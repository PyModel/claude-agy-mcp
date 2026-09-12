import type { Capabilities } from "./capabilities.js";
import { Admission } from "./concurrency.js";
import { delegationDepth, type Config } from "./config.js";
import { assertWithinRoots, redact, redactDeep } from "./egress.js";
import { snapshotTree, treeChanged, type TreeSnapshot } from "./worktree.js";
import { EMPTY_USAGE, type AgyUsage, type DeniedAction } from "./envelope.js";
import { AgyFailure } from "./failure.js";
import { resolveEntry, type Effort, type ModelInfo, type ModelRegistry } from "./models.js";
import {
  MemoryPreferenceStore,
  type ModelPreference,
  type PreferenceStore,
} from "./preferences.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { runAgy, type RunnerDeps, type RunProgress, truncate } from "./runner.js";
import { modeFor, type ToolDef } from "./tools.js";
import { UsageLedger } from "./usage.js";
import { WarmSessions, WarmTimeout, WarmUnavailable, type WarmDeps } from "./warm.js";

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
  /**
   * A plan-mode run changed the working tree anyway.
   *
   * `true` means the fingerprint moved and the run wrote despite being asked
   * not to; `false` means it demonstrably did not; `undefined` means the tree
   * could not be fingerprinted, which is not the same as "nothing happened".
   */
  wroteInReadOnlyMode?: boolean;
}

/** Thrown while AGY_ASK_MODEL is on and nobody has called `set_model` yet. */
export class ModelNotChosenError extends Error {
  constructor(suggested: ModelPreference | null, available: ModelInfo[] | null) {
    const listing = available
      ? available.map((m) => `- ${m.name}`).join("\n")
      : "- (agy models could not be listed; run `agy models` yourself)";
    const fallback = suggested
      ? `${suggested.model}${suggested.effort ? ` at ${suggested.effort} effort` : ""}`
      : "agy's own default model";
    super(
      "No model has been chosen for this machine yet. Ask the user this, in these words: " +
        `"Proceed with the default — ${fallback} — or change the model or effort?" ` +
        "Then call `set_model` once: with no arguments to accept the default, or with the " +
        "model and effort they chose. The choice is saved and this will not be asked again.\n" +
        `Models agy offers:\n${listing}\n` +
        "Set AGY_ASK_MODEL=false to skip this and route on the built-in chains.",
    );
    this.name = "ModelNotChosenError";
  }
}

export interface DelegationDeps extends RunnerDeps, WarmDeps {
  /** Where the user\'s `set_model` choice lives; in memory unless given. */
  preferences?: PreferenceStore;
  cooldowns?: CooldownRegistry;
  /** Fingerprints the working tree; injected so tests need no real filesystem. */
  snapshot?: (cwd: string) => Promise<TreeSnapshot>;
}

/** One model to try, already reconciled with the effort agy will accept for it. */
interface Candidate {
  /** Undefined lets agy choose: a continued conversation, or an unreadable listing. */
  model?: string;
  effort?: Effort;
}

interface Route {
  candidates: Candidate[];
  note?: string;
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
  private readonly prefs: PreferenceStore;
  private readonly depth: number;

  constructor(
    private readonly cfg: Config,
    private readonly models: ModelRegistry,
    private readonly caps: Capabilities,
    private readonly deps: DelegationDeps = {},
    env: Record<string, string | undefined> = process.env,
  ) {
    this.depth = delegationDepth(env);
    this.cooldowns = deps.cooldowns ?? new CooldownRegistry();
    this.admission = new Admission(cfg.maxConcurrency);
    this.ledger = new UsageLedger(cfg.budgetTokens);
    this.warm = new WarmSessions(cfg, caps, { ...deps, env: this.childEnv() });
    this.prefs = deps.preferences ?? new MemoryPreferenceStore();
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
    preference: ModelPreference | null;
    askModel: boolean;
  } {
    return {
      preference: this.prefs.load(),
      askModel: this.cfg.askModel,
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

  /** The models agy offers, or null when the listing could not be read. */
  availableModels(): Promise<ModelInfo[] | null> {
    return this.models.available();
  }

  /**
   * What `set_model` accepts when the user just says "proceed": the configured
   * default model resolved against the live listing, at the tier its name carries.
   */
  async defaultChoice(): Promise<ModelPreference | null> {
    if (!this.cfg.defaultModel) return null;
    const available = await this.models.available();
    const name = available ? resolveEntry(this.cfg.defaultModel, available) : undefined;
    if (!name) return null;
    const tier = available?.find((m) => m.name === name)?.effort;
    const effort =
      tier === "low" || tier === "medium" || tier === "high" ? tier : this.cfg.defaultEffort;
    return { model: name, ...(effort ? { effort } : {}), setAt: "" };
  }

  /**
   * Records the user's choice for every later call on this machine.
   *
   * The model is validated against the live listing; a tier that differs from
   * the one in the model's name selects the sibling at that tier, so what is
   * stored is exactly what will be passed to agy.
   */
  async setPreference(
    model: string | undefined,
    effort: Effort | undefined,
  ): Promise<ModelPreference> {
    if (!model) {
      const fallback = await this.defaultChoice();
      if (!fallback) {
        throw new Error(
          "set_model needs a `model`: the default could not be resolved against agy's model list.",
        );
      }
      model = fallback.model;
      effort ??= fallback.effort;
    }
    const { models, note } = await this.models.resolveChain({ explicit: model, chain: [] });
    const resolved = models[0] ?? model;
    const pick = (await this.models.forEffort(resolved, effort)) ?? { model: resolved };
    const pref: ModelPreference = {
      model: pick.model,
      ...(effort ? { effort } : {}),
      setAt: new Date().toISOString(),
    };
    this.prefs.save(pref);
    if (note) console.error(`claude-agy-mcp: set_model: ${note}`);
    return pref;
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
    // Everything agy will be given, not a similar-looking subset. `dirsFor`
    // derives workspace roots with dirname(), so validating only the caller's
    // own paths let a file argument equal to an allowed root contribute that
    // root's PARENT as a workspace directory — one level outside containment,
    // once per call.
    assertWithinRoots(
      [req.cwd, ...this.dirsFor(req), ...req.tool.touchedPaths(req.args, req.cwd)],
      this.cfg.allowedRoots,
    );
  }

  /**
   * Every workspace root this call needs: what the caller asked for, plus the
   * directories the tool's own arguments imply — a file outside `cwd` is not in
   * agy's workspace unless its directory is added too.
   *
   * Whatever this returns is containment-checked by `assertMayDelegate`, so a
   * derived root can never widen the caller's reach.
   */
  private dirsFor(req: DelegationRequest): string[] {
    return [...new Set([...(req.dirs ?? []), ...req.tool.extraDirs(req.args, req.cwd)])];
  }

  async run(req: DelegationRequest): Promise<Delegation> {
    this.assertMayDelegate(req);
    const prompt = req.tool.buildPrompt(req.args, req.cwd);
    const pref = this.prefs.load();
    if (this.cfg.askModel && !pref && !req.model && !req.conversationId) {
      throw new ModelNotChosenError(await this.defaultChoice(), await this.models.available());
    }
    const route = await this.routeFor(req, pref);
    // agy cannot be *made* to honour plan mode while permissions are skipped, so
    // the bridge watches instead of promising. Only plan-mode runs are watched:
    // a write run changing the tree is the point of it. Both fingerprints are
    // taken inside the admission gate, so this filesystem work is bounded by
    // AGY_MAX_CONCURRENCY like everything else and cannot stampede a big tree.
    const watch = modeFor(req.tool, req.write) === "plan";
    return this.admission.run(
      req.conversationId,
      async () => {
        // COR-M4. Re-check the budget here, inside the gate, not only before
        // queueing: `runMany` fans every leg out at once, so all of them used to
        // pass the pre-flight check while spend was still zero and overshoot was
        // bounded by leg count rather than by the limit.
        this.ledger.assertWithinBudget();
        const snap = this.deps.snapshot ?? snapshotTree;
        const before = watch ? await snap(req.cwd) : undefined;
        const result = await this.attemptWithSkewRetry(req, prompt, route);
        if (!before) return result;
        const wrote = treeChanged(before, await snap(req.cwd));
        return wrote === undefined ? result : { ...result, wroteInReadOnlyMode: wrote };
      },
      req.signal,
    );
  }

  /**
   * The models to try, in order, each with the `--effort` it will be sent.
   *
   * A requested effort belongs to the primary model only — the caller's
   * `model`, else the user's `set_model` choice, else the chain's head.
   * Re-tiering the fallbacks as well would turn "Flash (Medium)" back into the
   * "Flash (High)" that just hit its quota, so they keep the tier their name
   * carries, and only an untiered fallback takes the configured default effort.
   */
  private async routeFor(req: DelegationRequest, pref: ModelPreference | null): Promise<Route> {
    // Continuing a conversation reuses the model it was started with, unless the
    // caller pinned one — agy honours a model switch on a resumed conversation,
    // which is how a cheap session gets a second opinion without re-sending it.
    if (req.conversationId && !req.model) return { candidates: [{}] };

    const resolution = await this.models.resolveChain({
      explicit: req.model,
      chain: [...(pref ? [pref.model] : []), ...(req.tool.chain ?? [])],
      defaultModel: this.cfg.defaultModel,
    });
    const available = await this.models.available();
    const primaryEffort = req.effort ?? pref?.effort ?? this.cfg.defaultEffort;
    const tierOf = (name: string) => available?.find((m) => m.name === name)?.effort;

    const candidates: Candidate[] = [];
    for (const [i, model] of resolution.models.entries()) {
      if (!model) {
        candidates.push({});
        continue;
      }
      const pick =
        i === 0
          ? await this.models.forEffort(model, primaryEffort)
          : tierOf(model)
            ? { model }
            : await this.models.forEffort(model, this.cfg.defaultEffort);
      const candidate: Candidate = pick ?? { model };
      if (!candidates.some((c) => c.model === candidate.model)) candidates.push(candidate);
    }
    return { candidates, ...(resolution.note ? { note: resolution.note } : {}) };
  }

  /**
   * The single exit through which every answer leaves this bridge.
   *
   * Order matters and is the reason both steps live here rather than in the
   * runner: redaction runs on the whole answer first, then truncation cuts it.
   * The other way round, a secret that straddled the cut point was split into
   * two halves that no longer matched any credential shape, and survived.
   * Routing both through one funnel also means the warm-session paths, which
   * never touch the runner, are scrubbed and capped exactly like a cold run.
   */
  private finish(partial: Omit<Delegation, "redactions" | "truncatedFrom">): Delegation {
    const scrubbed = this.cfg.redact ? redact(partial.output) : { text: partial.output, count: 0 };
    // SEC-M2. structuredContent is model output the caller *parses*, so leaving
    // it unscrubbed defeated the setting entirely for any schema-constrained call.
    const structured =
      this.cfg.redact && partial.structuredOutput !== undefined
        ? redactDeep(partial.structuredOutput)
        : undefined;
    const cut = truncate(scrubbed.text, this.cfg.maxOutputChars);
    return {
      ...partial,
      ...(structured ? { structuredOutput: structured.value } : {}),
      output: cut.text,
      ...(cut.from !== undefined ? { truncatedFrom: cut.from } : {}),
      redactions: scrubbed.count + (structured?.count ?? 0),
    };
  }

  /**
   * A resident session runs with the conversation's own model, in plan mode,
   * so it can only stand in for a call that asks for nothing else.
   */
  private warmEligible(req: DelegationRequest): boolean {
    return (
      this.warm.enabled &&
      req.conversationId !== undefined &&
      !req.jsonSchema &&
      !req.model &&
      !req.effort &&
      modeFor(req.tool, req.write) === "plan"
    );
  }

  /**
   * Runs the route, and re-reads `agy models` once if agy rejects every name in it.
   *
   * An unknown model does not fail over, by design — it is a caller error, not a
   * quota problem. But it is also exactly what an agy upgrade under a running
   * bridge looks like, because the listing is cached for the process lifetime.
   * Without this the server stayed bricked until it was restarted.
   */
  private async attemptWithSkewRetry(
    req: DelegationRequest,
    prompt: string,
    route: Route,
  ): Promise<Delegation> {
    try {
      return await this.attempt(req, prompt, route);
    } catch (err) {
      if (!(err instanceof AgyFailure) || err.kind !== "invalid_model") throw err;
      this.models.invalidate();
      const fresh = await this.routeFor(req, this.prefs.load());
      return this.attempt(req, prompt, fresh);
    }
  }

  private async attempt(req: DelegationRequest, prompt: string, route: Route): Promise<Delegation> {
    const attempts: string[] = [];

    // A follow-up on a live conversation is the case a resident process is for.
    if (this.warmEligible(req)) {
      const conversationId = req.conversationId!;
      try {
        const envelope = await this.warm.turn(conversationId, req.cwd, prompt, {
          timeoutMs: req.timeoutSec * 1000,
          ...(req.signal ? { signal: req.signal } : {}),
          ...(req.onProgress
            ? {
                onProgress: (text: string) =>
                  req.onProgress?.({ text, stepIndex: 0, stepType: "agent_response", tokens: 0 }),
              }
            : {}),
        });
        if (envelope.status === "SUCCESS" && envelope.response.trim()) {
          this.ledger.record(undefined, envelope.usage);
          return this.finish({
            output: envelope.response.trim(),
            attempts,
            sessionId: envelope.conversationId ?? conversationId,
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
        if (err instanceof WarmTimeout) {
          return this.finish({
            output: err.text.trim(),
            attempts,
            sessionId: conversationId,
            timedOut: true,
            deniedActions: [],
            usage: EMPTY_USAGE,
            numTurns: 0,
            warm: true,
          });
        }
        if (!(err instanceof WarmUnavailable)) throw err;
        attempts.push(`warm session unavailable (${err.message}); ran a fresh agy process`);
      }
    }

    for (const { model, effort } of route.candidates) {
      if (model && this.cooldowns.cooling(model)) {
        attempts.push(`${model}: quota cooldown, ${this.cooldowns.describe(model)} left`);
        continue;
      }
      try {
        return await this.runOnce(req, prompt, model, effort, attempts, route.note);
      } catch (err) {
        if (err instanceof QuotaError && model) {
          this.cooldowns.set(model, err.resetSeconds);
          attempts.push(
            `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
          );
          continue;
        }
        if (err instanceof AgyFailure && err.policy.failover && model) {
          // `failover` is granted to quota alone, and a quota reached this branch
          // rather than the one above because it was classified from stderr or the
          // envelope instead of the log. It is still an exhausted model: record the
          // cooldown, or every later call re-burns it before failing over again.
          if (err.kind === "quota") this.cooldowns.set(model, undefined);
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
    effort: Effort | undefined,
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
          ...(effort ? { effort } : {}),
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
      // No fallback to agy's global last-conversation cache: that file is keyed by
      // directory across the whole machine, so it hands back the user's own
      // interactive session, which follow_up would then read and append to.
      // A run that reports no conversation id simply has no resumable session.
      ...(result.conversationId ? { sessionId: result.conversationId } : {}),
      timedOut: result.timedOut,
      deniedActions: result.deniedActions,
      usage: result.usage,
      ...(result.structuredOutput !== undefined
        ? { structuredOutput: result.structuredOutput }
        : {}),
      numTurns: result.numTurns,
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
    // Legs swallow their own errors, so the ask-once gate has to trip before fan-out.
    if (this.cfg.askModel && !this.prefs.load() && !req.model && !req.conversationId) {
      throw new ModelNotChosenError(await this.defaultChoice(), await this.models.available());
    }
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
