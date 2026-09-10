import type { Capabilities } from "./capabilities.js";
import { Admission } from "./concurrency.js";
import { delegationDepth, type Config } from "./config.js";
import { assertWithinRoots, redact } from "./egress.js";
import type { AgyUsage, DeniedAction } from "./envelope.js";
import { AgyFailure } from "./failure.js";
import type { ModelRegistry } from "./models.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { runAgy, type RunnerDeps, type RunProgress } from "./runner.js";
import { sessionFor, type ReadSessionsFile } from "./sessions.js";
import { modeFor, type ToolDef } from "./tools.js";
import { UsageLedger } from "./usage.js";
import { WarmSessions, WarmUnavailable, type WarmDeps } from "./warm.js";

export interface DelegationRequest {
  tool: ToolDef;
  /** Raw tool arguments; the tool validates them while building its prompt. */
  args: unknown;
  cwd: string;
  dirs?: string[];
  /** Continue this agy conversation instead of routing to a model. */
  conversationId?: string;
  /** Caller-pinned model; skips the tool's chain. */
  model?: string;
  effort?: "low" | "medium" | "high";
  /** JSON Schema string; fills `structuredOutput`. */
  jsonSchema?: string;
  slashCommands?: boolean;
  write?: boolean;
  sandbox?: boolean;
  timeoutSec: number;
  signal?: AbortSignal;
  onProgress?: (p: RunProgress) => void;
}

/** What one delegation produced. `attempts` carries the only pre-rendered strings. */
export interface Delegation {
  output: string;
  /** The model that answered; undefined when agy chose for itself. */
  model?: string;
  /** One line per model skipped or exhausted before this one answered. */
  attempts: string[];
  /** Set when model resolution had to degrade. */
  note?: string;
  sessionId?: string;
  timedOut: boolean;
  /** Tool actions agy was refused. Non-empty means the answer may be incomplete. */
  deniedActions: DeniedAction[];
  usage: AgyUsage;
  structuredOutput?: unknown;
  numTurns: number;
  /** Original length when the output was cut. */
  truncatedFrom?: number;
  /** Answered by a resident session rather than a fresh process. */
  warm: boolean;
  /** How many credential-shaped strings were scrubbed from the output. */
  redactions: number;
}

export interface DelegationDeps extends RunnerDeps, WarmDeps {
  readSessions?: ReadSessionsFile;
  cooldowns?: CooldownRegistry;
}

export class DelegationDepthError extends Error {
  constructor(depth: number, max: number) {
    super(
      `Refusing to delegate: this server is already ${depth} delegation(s) deep ` +
        `(limit ${max}). claude-agy-mcp is registered as an MCP server inside the agy ` +
        `session that called it, so the call would loop Claude -> agy -> claude-agy-mcp -> agy ` +
        `until the quota is gone. Unregister it with \`agy mcp remove\`, or raise ` +
        `AGY_MAX_DELEGATION_DEPTH if the nesting is deliberate.`,
    );
    this.name = "DelegationDepthError";
  }
}

/**
 * Runs a tool's prompt through agy, walking the tool's model chain and skipping
 * models that are still cooling down from a quota error. Owns everything that
 * has to be true across calls: admission control, cooldowns, spend, and the
 * resident sessions that make a follow-up cheap.
 */
export class Delegator {
  private readonly cooldowns: CooldownRegistry;
  private readonly admission: Admission;
  private readonly ledger: UsageLedger;
  private readonly warm: WarmSessions;
  private readonly depth: number;

  constructor(
    private readonly cfg: Config,
    private readonly models: ModelRegistry,
    private readonly caps: Capabilities,
    private readonly deps: DelegationDeps = {},
    env: Record<string, string | undefined> = process.env,
  ) {
    this.cooldowns = deps.cooldowns ?? new CooldownRegistry();
    this.admission = new Admission(cfg.maxConcurrency);
    this.ledger = new UsageLedger(cfg.budgetTokens);
    this.warm = new WarmSessions(cfg, caps, deps);
    this.depth = delegationDepth(env);
  }

  /** Everything the `agy_status` tool reports. */
  status(): {
    agyVersion: string;
    missingFlags: string[];
    spent: number;
    budget?: number;
    usage: ReturnType<UsageLedger["rows"]>;
    cooldowns: ReturnType<CooldownRegistry["active"]>;
    inFlight: number;
    queued: number;
    warm: ReturnType<WarmSessions["stats"]>;
    depth: number;
  } {
    return {
      agyVersion: this.caps.version,
      missingFlags: this.caps.missing,
      spent: this.ledger.spent,
      ...(this.ledger.budget !== undefined ? { budget: this.ledger.budget } : {}),
      usage: this.ledger.rows(),
      cooldowns: this.cooldowns.active(),
      inFlight: this.admission.inFlight,
      queued: this.admission.queued,
      warm: this.warm.stats(),
      depth: this.depth,
    };
  }

  shutdown(): void {
    this.warm.shutdown();
  }

  /** The environment a child agy inherits, carrying the recursion counter. */
  private childEnv(): Record<string, string> {
    return { AGY_DELEGATION_DEPTH: String(this.depth + 1) };
  }

  private assertMayDelegate(req: DelegationRequest): void {
    if (this.depth >= this.cfg.maxDelegationDepth) {
      throw new DelegationDepthError(this.depth, this.cfg.maxDelegationDepth);
    }
    this.ledger.assertWithinBudget();
    assertWithinRoots(
      [req.cwd, ...(req.dirs ?? []), ...req.tool.touchedPaths(req.args, req.cwd)],
      this.cfg.allowedRoots,
    );
  }

  /**
   * Every workspace root this call needs: what the caller asked for, plus the
   * directories the tool's own arguments imply — a file outside `cwd` is not in
   * agy's workspace unless its directory is added too.
   */
  private dirsFor(req: DelegationRequest): string[] {
    return [...new Set([...(req.dirs ?? []), ...req.tool.extraDirs(req.args, req.cwd)])];
  }

  async run(req: DelegationRequest): Promise<Delegation> {
    this.assertMayDelegate(req);
    const prompt = req.tool.buildPrompt(req.args, req.cwd);

    // Continuing a conversation reuses the model it was started with, unless the
    // caller pinned one — agy honours a model switch on a resumed conversation,
    // which is how a cheap session gets a second opinion without re-sending it.
    const resolution =
      req.conversationId && !req.model
        ? { models: [undefined], note: undefined }
        : await this.models.resolveChain({
            explicit: req.model,
            chain: req.tool.chain ?? [],
            defaultModel: this.cfg.defaultModel,
          });

    return this.admission.run(req.conversationId, () => this.attempt(req, prompt, resolution));
  }

  private finish(
    partial: Omit<Delegation, "redactions" | "output"> & { output: string },
  ): Delegation {
    const scrubbed = this.cfg.redact ? redact(partial.output) : { text: partial.output, count: 0 };
    return { ...partial, output: scrubbed.text, redactions: scrubbed.count };
  }

  private async attempt(
    req: DelegationRequest,
    prompt: string,
    resolution: { models: (string | undefined)[]; note?: string },
  ): Promise<Delegation> {
    const attempts: string[] = [];

    // A follow-up on a live conversation is the case a resident process is for.
    if (req.conversationId && !req.jsonSchema && this.warm.enabled) {
      try {
        const envelope = await this.warm.turn(req.conversationId, req.cwd, prompt);
        if (envelope.status === "SUCCESS" && envelope.response.trim()) {
          this.ledger.record(req.model, envelope.usage);
          return this.finish({
            output: envelope.response.trim(),
            ...(req.model ? { model: req.model } : {}),
            attempts,
            sessionId: envelope.conversationId ?? req.conversationId,
            timedOut: false,
            deniedActions: envelope.deniedActions,
            usage: envelope.usage,
            ...(envelope.structuredOutput !== undefined
              ? { structuredOutput: envelope.structuredOutput }
              : {}),
            numTurns: envelope.numTurns,
            warm: true,
          });
        }
        attempts.push("warm session returned no answer; retried with a fresh agy process");
      } catch (err) {
        if (!(err instanceof WarmUnavailable)) throw err;
        attempts.push(`warm session unavailable (${err.message}); ran a fresh agy process`);
      }
    }

    for (const model of resolution.models) {
      if (model && this.cooldowns.cooling(model)) {
        attempts.push(`${model}: quota cooldown, ${this.cooldowns.describe(model)} left`);
        continue;
      }
      try {
        return await this.runOnce(req, prompt, model, attempts, resolution.note);
      } catch (err) {
        if (err instanceof QuotaError && model) {
          this.cooldowns.set(model, err.resetSeconds);
          attempts.push(
            `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
          );
          continue;
        }
        if (err instanceof AgyFailure && err.policy.failover && model) {
          attempts.push(`${model}: ${err.message}`);
          continue;
        }
        throw err;
      }
    }

    throw new Error(
      `All candidate models are quota-exhausted or cooling down:\n` +
        `${attempts.map((a) => `- ${a}`).join("\n")}\n` +
        `Retry after the quota resets, or pass an explicit \`model\`.`,
    );
  }

  private async runOnce(
    req: DelegationRequest,
    prompt: string,
    model: string | undefined,
    attempts: string[],
    note: string | undefined,
  ): Promise<Delegation> {
    const call = () =>
      runAgy(
        {
          prompt,
          cwd: req.cwd,
          ...(this.dirsFor(req).length ? { dirs: this.dirsFor(req) } : {}),
          ...(model ? { model } : {}),
          ...((req.effort ?? req.tool.effort ?? this.cfg.defaultEffort)
            ? { effort: (req.effort ?? req.tool.effort ?? this.cfg.defaultEffort)! }
            : {}),
          mode: modeFor(req.tool, req.write),
          ...(req.sandbox !== undefined ? { sandbox: req.sandbox } : {}),
          ...(req.slashCommands !== undefined ? { slashCommands: req.slashCommands } : {}),
          ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
          ...(req.conversationId ? { conversationId: req.conversationId } : {}),
          timeoutSec: req.timeoutSec,
          ...(req.signal ? { signal: req.signal } : {}),
          env: this.childEnv(),
          ...(req.onProgress ? { onProgress: req.onProgress } : {}),
        },
        this.cfg,
        this.caps,
        { spawn: this.deps.spawn, timing: this.deps.timing },
      );

    let result;
    try {
      result = await call();
    } catch (err) {
      // A network blip is the one failure worth repeating verbatim.
      if (err instanceof AgyFailure && err.policy.retryOnce) {
        attempts.push(`${model ?? "agy default"}: ${err.kind}, retrying once`);
        result = await call();
      } else {
        throw err;
      }
    }

    this.ledger.record(model, result.usage);
    return this.finish({
      output: result.output,
      ...(model ? { model } : {}),
      attempts,
      ...(note ? { note } : {}),
      sessionId: result.conversationId ?? (await sessionFor(req.cwd, this.deps.readSessions)),
      timedOut: result.timedOut,
      deniedActions: result.deniedActions,
      usage: result.usage,
      ...(result.structuredOutput !== undefined
        ? { structuredOutput: result.structuredOutput }
        : {}),
      numTurns: result.numTurns,
      ...(result.truncatedFrom !== undefined ? { truncatedFrom: result.truncatedFrom } : {}),
      warm: false,
    });
  }

  /**
   * Fans one prompt out to several models, or several prompts out to the
   * automatic route. Each leg goes through `run`, so the semaphore, cooldowns,
   * budget and depth guard all still apply.
   */
  async runMany(
    req: DelegationRequest,
    legs: { model?: string; prompt?: string; label: string }[],
  ): Promise<{ label: string; delegation?: Delegation; error?: string }[]> {
    return Promise.all(
      legs.map(async (leg) => {
        try {
          const delegation = await this.run({
            ...req,
            ...(leg.model ? { model: leg.model } : {}),
            ...(leg.prompt ? { args: { ...(req.args as object), prompt: leg.prompt } } : {}),
          });
          return { label: leg.label, delegation };
        } catch (err) {
          return { label: leg.label, error: (err as Error).message };
        }
      }),
    );
  }
}
