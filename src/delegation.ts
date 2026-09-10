import type { Config } from "./config.js";
import type { ModelRegistry } from "./models.js";
import { CooldownRegistry, QuotaError } from "./quota.js";
import { runAgy, type RunnerDeps } from "./runner.js";
import { sessionFor, type ReadSessionsFile } from "./sessions.js";
import type { ToolDef } from "./tools.js";

export interface DelegationRequest {
  tool: ToolDef;
  /** Raw tool arguments; the tool validates them while building its prompt. */
  args: unknown;
  cwd: string;
  /** Continue this agy conversation instead of routing to a model. */
  conversationId?: string;
  /** Caller-pinned model; skips the tool's chain. */
  model?: string;
  timeoutSec: number;
  signal?: AbortSignal;
}

/** What one delegation produced, as data — nothing here is formatted for display. */
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
}

export interface DelegationDeps extends RunnerDeps {
  readSessions?: ReadSessionsFile;
}

/**
 * Runs a tool's prompt through agy, walking the tool's model chain and skipping
 * models that are still cooling down from a quota error. Holds the cooldown
 * state that makes a failover on one call cheap on the next.
 */
export class Delegator {
  constructor(
    private readonly cfg: Config,
    private readonly models: ModelRegistry,
    private readonly cooldowns: CooldownRegistry = new CooldownRegistry(),
    private readonly deps: DelegationDeps = {},
  ) {}

  async run(req: DelegationRequest): Promise<Delegation> {
    const prompt = req.tool.buildPrompt(req.args, req.cwd);

    // Continuing a conversation reuses the model it was started with.
    const resolution = req.conversationId
      ? { models: [undefined], note: undefined }
      : await this.models.resolveChain({
          explicit: req.model,
          chain: req.tool.chain ?? [],
          defaultModel: this.cfg.defaultModel,
        });

    const attempts: string[] = [];

    for (const model of resolution.models) {
      if (model && this.cooldowns.cooling(model)) {
        attempts.push(`${model}: quota cooldown, ${this.cooldowns.describe(model)} left`);
        continue;
      }
      try {
        const result = await runAgy(
          {
            prompt,
            cwd: req.cwd,
            model,
            conversationId: req.conversationId,
            timeoutSec: req.timeoutSec,
            signal: req.signal,
          },
          this.cfg,
          this.deps,
        );
        return {
          output: result.output,
          model,
          attempts,
          note: resolution.note,
          sessionId: await sessionFor(req.cwd, this.deps.readSessions),
          timedOut: result.timedOut ?? false,
        };
      } catch (err) {
        if (err instanceof QuotaError && model) {
          this.cooldowns.set(model, err.resetSeconds);
          attempts.push(
            `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`,
          );
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
}
