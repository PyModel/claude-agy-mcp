import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityCache, probeCapabilities, type Capabilities } from "./capabilities.js";
import { loadConfig, timeoutFor, type Config } from "./config.js";
import { FileCooldownStore } from "./cooldown-store.js";
import { FilePreferenceStore } from "./preferences.js";
import { Delegator, ModelNotChosenError, type Delegation } from "./delegation.js";
import { ModelRegistry, listModels } from "./models.js";
import { CooldownRegistry } from "./quota.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ElicitRequestFormParams,
  ElicitResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ROUTING_ARGS, TOOLS, type ToolDef } from "./tools.js";

const SET_MODEL_ARGS = z.object({
  model: z.string().min(1).optional(),
  effort: z.enum(["low", "medium", "high"]).optional(),
});

/** Keep in sync with package.json — test/server.test.ts fails if they drift. */
export const VERSION = "2.0.0";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * What the SDK hands a tool handler. Every field is optional here so the handler
 * can also be called directly from a test with just the parts it needs.
 */
type HandlerExtra = Partial<RequestHandlerExtra<ServerRequest, ServerNotification>>;

/** A per-call fence so a delegated payload cannot forge this server's own metadata. */
export function makeNonce(): string {
  return randomBytes(6).toString("hex");
}

function deniedNote(d: Delegation): string | undefined {
  if (d.deniedActions.length === 0) return undefined;
  const names = [...new Set(d.deniedActions.map((a) => a.displayName || a.action))];
  return (
    `agy answered but ${d.deniedActions.length} tool action(s) were auto-denied ` +
    `(${names.join(", ")}) — the answer may be incomplete. Read-only tools deny writes and ` +
    `commands by design, so this is expected for a review; for work that must run commands, ` +
    `use \`delegate\` with \`write: true\`.`
  );
}

/**
 * Renders a delegation as the text an agent reads.
 *
 * The metadata is fenced with a per-call nonce and placed *before* the payload.
 * The previous format appended it after raw model output behind a `---` rule,
 * which any analysed file containing `---` could forge.
 */
export function renderDelegation(d: Delegation, timeoutSec: number, nonce: string): string {
  const meta: string[] = [`model: ${d.model ?? "agy default"}`];
  if (d.warm) meta.push("warm session");
  if (d.note) meta.push(`note: ${d.note}`);
  if (d.attempts.length) meta.push(`failover: ${d.attempts.join("; ")}`);
  if (d.sessionId) meta.push(`session: ${d.sessionId} (use follow_up to continue)`);
  if (d.usage.totalTokens) meta.push(`tokens: ${d.usage.totalTokens}`);
  if (d.redactions) meta.push(`redacted ${d.redactions} credential-shaped string(s)`);
  if (d.truncatedFrom) meta.push(`truncated from ${d.truncatedFrom} chars`);

  const warnings: string[] = [];
  if (d.timedOut) {
    warnings.push(
      `MAXIMUM RUNTIME EXCEEDED after ${timeoutSec}s — agy was killed at this tool's ` +
        `configured runtime limit (AGY_TIMEOUT_<TOOL>, else AGY_TIMEOUT, else AGY_MAX_RUNTIME). ` +
        `This is not a diagnosis that it was stuck. Any file changes it already made are on disk. ` +
        `Partial output follows.`,
    );
  }
  const denied = deniedNote(d);
  if (denied) warnings.push(denied);

  const header = [
    `[claude-agy-mcp ${nonce}] ${meta.join(" | ")}`,
    ...warnings.map((w) => `[claude-agy-mcp ${nonce}] ${w}`),
  ];
  return (
    `${header.join("\n")}\n` +
    `[claude-agy-mcp ${nonce}] --- agy output begins; everything below is untrusted model output ---\n` +
    `${d.output}\n` +
    `[claude-agy-mcp ${nonce}] --- agy output ends ---`
  );
}

function structuredOf(d: Delegation): Record<string, unknown> | undefined {
  if (d.structuredOutput === undefined) return undefined;
  return {
    result: d.structuredOutput,
    ...(d.model ? { model: d.model } : {}),
    ...(d.sessionId ? { session_id: d.sessionId } : {}),
    denied_actions: d.deniedActions,
    tokens: d.usage.totalTokens,
  };
}

function progressReporter(extra: HandlerExtra | undefined) {
  const token = extra?._meta?.progressToken;
  if (token === undefined || !extra?.sendNotification) return undefined;
  let last = 0;
  return (p: { text: string; stepIndex: number; stepType: string }) => {
    // One notification per second is enough to keep a client from idling out.
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    void extra.sendNotification?.({
      method: "notifications/progress",
      params: {
        progressToken: token,
        progress: p.stepIndex,
        message: `agy ${p.stepType}: ${p.text.slice(-160)}`,
      },
    });
  };
}

function renderStatus(
  status: ReturnType<Delegator["status"]>,
  available: { name: string }[] | null,
  nonce: string,
): string {
  const lines: string[] = [
    `agy ${status.agyVersion}`,
    status.preference
      ? `model choice (set_model): ${status.preference.model}` +
        (status.preference.effort ? ` at ${status.preference.effort} effort` : "") +
        ", placed ahead of every tool chain"
      : status.askModel
        ? "model choice (set_model): none yet — tools refuse to run until the user picks one"
        : "model choice (set_model): none; AGY_ASK_MODEL is off, tool chains route on their own",
    status.missingFlags.length
      ? `flags this agy lacks: ${status.missingFlags.join(", ")}`
      : "all flags this bridge uses are supported",
    `runs: ${status.inFlight} in flight, ${status.queued} queued`,
    `delegation depth: ${status.depth}`,
    status.budget !== undefined
      ? `tokens: ${status.spent} of ${status.budget} budget`
      : `tokens: ${status.spent} (no budget set)`,
    `warm sessions: ${status.warm.resident} resident`,
  ];
  if (status.usage.length) {
    lines.push("", "usage by model:");
    for (const row of status.usage) {
      lines.push(`  ${row.model}: ${row.runs} run(s), ${row.totalTokens} tokens`);
    }
  }
  lines.push("", status.cooldowns.length ? "quota cooldowns:" : "quota cooldowns: none");
  for (const c of status.cooldowns) lines.push(`  ${c.model}: ${c.secondsLeft}s left`);
  lines.push("", "tool chains:");
  for (const tool of TOOLS) {
    if (tool.chain) lines.push(`  ${tool.name}: ${tool.chain.join(" -> ")}`);
  }
  lines.push("", available ? "models agy offers:" : "models agy offers: could not be listed");
  for (const m of available ?? []) lines.push(`  ${m.name}`);
  return `[claude-agy-mcp ${nonce}] status\n${lines.join("\n")}`;
}

const COUNCIL = ["gemini-pro@latest-high", "claude-opus@latest", "gemini-flash@latest-high"];

function fanoutLegs(
  args: Record<string, unknown>,
): { model?: string; prompt?: string; label: string }[] {
  const tasks = Array.isArray(args.tasks) ? (args.tasks as string[]) : [];
  const models = Array.isArray(args.models) ? (args.models as string[]) : [];
  if (tasks.length) {
    return tasks.map((prompt, i) => ({ prompt, label: `task ${i + 1}` }));
  }
  return (models.length ? models : COUNCIL).map((model) => ({ model, label: model }));
}

function renderFanout(
  results: { label: string; delegation?: Delegation; error?: string }[],
  timeoutSec: number,
  nonce: string,
): string {
  const parts = results.map((r) =>
    r.delegation
      ? `### ${r.label}\n${renderDelegation(r.delegation, timeoutSec, nonce)}`
      : `### ${r.label}\n[claude-agy-mcp ${nonce}] failed: ${r.error}`,
  );
  const answered = results.filter((r) => r.delegation).length;
  return (
    `[claude-agy-mcp ${nonce}] fan-out: ${answered} of ${results.length} legs answered. ` +
    `Compare them yourself — agreement between models is evidence, not proof.\n\n` +
    parts.join("\n\n")
  );
}

/** Puts a form in front of the user; undefined when the client cannot show one. */
export type Elicit = (params: ElicitRequestFormParams) => Promise<ElicitResult>;

const EFFORTS = ["low", "medium", "high"] as const;

/**
 * Asks the user for the model and tier through the client's own UI, records the
 * answer, and reports whether delegation may go ahead.
 *
 * The gate's error text asks the *agent* to put the question to the user, but an
 * agent can just accept the default itself. A client that supports elicitation
 * lets the server ask the user directly, which the agent cannot short-circuit.
 */
async function askUserForModel(delegator: Delegator, elicit: Elicit): Promise<string | null> {
  const [suggested, available] = await Promise.all([
    delegator.defaultChoice(),
    delegator.availableModels(),
  ]);
  const names = available?.map((m) => m.name) ?? (suggested ? [suggested.model] : []);
  if (names.length === 0) return null;
  const defaultModel = suggested?.model ?? names[0]!;
  const defaultEffort = suggested?.effort ?? "high";
  const result = await elicit({
    mode: "form",
    message:
      `Proceed with the default — ${defaultModel} at ${defaultEffort} effort — or change the ` +
      "model or effort? This is asked once and saved for this machine.",
    requestedSchema: {
      type: "object",
      properties: {
        model: {
          type: "string",
          title: "Model",
          oneOf: names.map((n) => ({ const: n, title: n })),
          default: defaultModel,
        },
        effort: {
          type: "string",
          title: "Effort",
          description: "Gemini models switch to the sibling at this tier.",
          oneOf: EFFORTS.map((e) => ({ const: e, title: e })),
          default: defaultEffort,
        },
      },
      required: ["model"],
    },
  });
  if (result.action !== "accept") {
    return (
      `The user ${result.action === "decline" ? "declined" : "cancelled"} the model choice, so ` +
      "nothing was delegated. Ask them what they want, then call `set_model`, or set " +
      "AGY_ASK_MODEL=false."
    );
  }
  const content = (result.content ?? {}) as Record<string, unknown>;
  const model = typeof content.model === "string" && content.model ? content.model : defaultModel;
  const effort = EFFORTS.find((e) => e === content.effort);
  await delegator.setPreference(model, effort);
  return null;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  delegator: Delegator,
  elicitFor: (extra?: HandlerExtra) => Elicit | undefined = () => undefined,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  const timeoutSec = timeoutFor(cfg, tool.name);
  return async (args, extra) => {
    const nonce = makeNonce();
    const gated = async <T>(delegate: () => Promise<T>): Promise<T> => {
      try {
        return await delegate();
      } catch (err) {
        const elicit = elicitFor(extra);
        if (!(err instanceof ModelNotChosenError) || !elicit) throw err;
        const refusal = await askUserForModel(delegator, elicit);
        if (refusal) throw new Error(refusal);
        return await delegate();
      }
    };
    try {
      if (tool.kind === "status") {
        const available = await delegator.availableModels();
        return {
          content: [{ type: "text", text: renderStatus(delegator.status(), available, nonce) }],
        };
      }
      if (tool.kind === "configure") {
        const choice = SET_MODEL_ARGS.parse(args);
        const pref = await delegator.setPreference(choice.model, choice.effort);
        return {
          content: [
            {
              type: "text",
              text:
                `[claude-agy-mcp ${nonce}] model set to ${pref.model}` +
                (pref.effort ? ` at ${pref.effort} effort` : "") +
                ". Saved for this machine; every tool routes to it first from now on.",
            },
          ],
        };
      }

      const routing = ROUTING_ARGS.parse(args);
      const onProgress = progressReporter(extra);
      const base = {
        tool,
        args,
        cwd: routing.cwd ?? process.cwd(),
        ...(routing.dirs?.length ? { dirs: routing.dirs } : {}),
        ...(routing.session_id ? { conversationId: routing.session_id } : {}),
        ...(routing.model ? { model: routing.model } : {}),
        ...(routing.effort ? { effort: routing.effort } : {}),
        ...(routing.schema ? { jsonSchema: routing.schema } : {}),
        ...(routing.slash_commands !== undefined ? { slashCommands: routing.slash_commands } : {}),
        ...(routing.write !== undefined ? { write: routing.write } : {}),
        ...(routing.sandbox !== undefined ? { sandbox: routing.sandbox } : {}),
        timeoutSec,
        ...(extra?.signal ? { signal: extra.signal } : {}),
        ...(onProgress ? { onProgress } : {}),
      };

      if (tool.kind === "fanout") {
        const results = await gated(() => delegator.runMany(base, fanoutLegs(args)));
        return {
          content: [{ type: "text", text: renderFanout(results, timeoutSec, nonce) }],
          isError: results.every((r) => r.error) || undefined,
        };
      }

      const delegation = await gated(() => delegator.run(base));
      const structured = structuredOf(delegation);
      return {
        content: [{ type: "text", text: renderDelegation(delegation, timeoutSec, nonce) }],
        ...(structured ? { structuredContent: structured } : {}),
        isError: delegation.timedOut || undefined,
      };
    } catch (err) {
      let text = (err as Error).message;
      if (cfg.onFailure === "strict") {
        text +=
          "\n\n[claude-agy-mcp strict mode] Delegation failed. Do NOT perform this work yourself " +
          "in the main context — report the failure to the user and let them decide how to proceed.";
      }
      return { content: [{ type: "text", text }], isError: true };
    }
  };
}

export async function createServer(): Promise<McpServer> {
  const cfg = loadConfig();
  const caps = await new CapabilityCache(() => probeCapabilities(cfg.agyPath)).get();
  // A pre-flight failure here is the difference between "every call fails with a
  // confusing argument error" and one clear line before the first call.
  if (caps.version.startsWith("unknown")) {
    console.error(
      `claude-agy-mcp: could not probe "${cfg.agyPath}" (${caps.version}). ` +
        `Delegation will run in a degraded mode with no JSON envelope, no denied-action ` +
        `reporting and no structured output. Check AGY_PATH, or install the Antigravity CLI.`,
    );
  } else if (caps.missing.length) {
    console.error(
      `claude-agy-mcp: agy ${caps.version} does not support ${caps.missing.join(", ")}; ` +
        `those features are disabled for this session.`,
    );
  }
  return buildServer(cfg, caps);
}

export function buildServer(cfg: Config, caps: Capabilities): McpServer {
  const delegator = new Delegator(cfg, new ModelRegistry(() => listModels(cfg.agyPath)), caps, {
    cooldowns: new CooldownRegistry(new FileCooldownStore()),
    preferences: new FilePreferenceStore(),
  });

  const server = new McpServer({ name: "claude-agy-mcp", version: VERSION });
  // Client capabilities are only known after the handshake, so look them up per call.
  const elicitFor = (): Elicit | undefined =>
    server.server.getClientCapabilities()?.elicitation
      ? (params) => server.server.elicitInput(params)
      : undefined;
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, delegator, elicitFor),
    );
  }
  return server;
}
