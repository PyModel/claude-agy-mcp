import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, timeoutFor, type Config } from "./config.js";
import { Delegator, type Delegation } from "./delegation.js";
import { ModelRegistry, listModels } from "./models.js";
import { ROUTING_ARGS, TOOLS, type ToolDef } from "./tools.js";

/** Keep in sync with package.json — test/server.test.ts fails if they drift. */
export const VERSION = "2.0.0";

interface ToolResponse {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

interface HandlerExtra {
  signal?: AbortSignal;
}

/** Renders a delegation as the text an agent reads. */
export function renderDelegation(d: Delegation, timeoutSec: number): string {
  const meta: string[] = [`model: ${d.model ?? "agy default"}`];
  if (d.note) meta.push(`note: ${d.note}`);
  if (d.attempts.length) meta.push(`failover: ${d.attempts.join("; ")}`);
  if (d.sessionId) meta.push(`session: ${d.sessionId} (use follow_up to continue)`);

  const output = d.timedOut
    ? `[claude-agy-mcp] MAXIMUM RUNTIME EXCEEDED after ${timeoutSec}s — ` +
      "agy was killed at this tool's configured runtime limit (AGY_TIMEOUT_<TOOL>, " +
      "else AGY_TIMEOUT, else AGY_MAX_RUNTIME). This is not a diagnosis " +
      "that it was stuck. Any file changes it already made are on disk. Partial output follows.\n" +
      d.output
    : d.output;

  return `${output}\n\n---\n[claude-agy-mcp] ${meta.join(" | ")}`;
}

export function createToolHandler(
  tool: ToolDef,
  cfg: Config,
  delegator: Delegator,
): (args: Record<string, unknown>, extra?: HandlerExtra) => Promise<ToolResponse> {
  const timeoutSec = timeoutFor(cfg, tool.name);
  return async (args, extra) => {
    try {
      const routing = ROUTING_ARGS.parse(args);
      const delegation = await delegator.run({
        tool,
        args,
        cwd: routing.cwd ?? process.cwd(),
        conversationId: routing.session_id,
        model: routing.model,
        timeoutSec,
        signal: extra?.signal,
      });
      return {
        content: [{ type: "text", text: renderDelegation(delegation, timeoutSec) }],
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

export function createServer(): McpServer {
  const cfg = loadConfig();
  const delegator = new Delegator(cfg, new ModelRegistry(() => listModels(cfg.agyPath)));

  const server = new McpServer({ name: "claude-agy-mcp", version: VERSION });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      createToolHandler(tool, cfg, delegator),
    );
  }
  return server;
}
