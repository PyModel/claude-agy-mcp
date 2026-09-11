import type { AgyUsage } from "./envelope.js";

export interface ModelUsage extends AgyUsage {
  model: string;
  runs: number;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spent: number,
    readonly limit: number,
  ) {
    super(
      `Token budget exhausted: ${spent} of ${limit} tokens used by this server since it started. ` +
        `Raise AGY_BUDGET_TOKENS or restart the server to reset the count.`,
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * What delegation has cost so far, per model.
 *
 * agy reports `cache_read_tokens` outside `total_tokens` — in one sample the
 * cache figure was larger than the total — so the fields are kept separate and
 * only `totalTokens` is ever summed.
 */
export class UsageLedger {
  private readonly byModel = new Map<string, ModelUsage>();

  constructor(private readonly budgetTokens?: number) {}

  record(model: string | undefined, usage: AgyUsage): void {
    const key = model ?? "agy default";
    const row = this.byModel.get(key) ?? {
      model: key,
      runs: 0,
      inputTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    };
    row.runs++;
    row.inputTokens += usage.inputTokens;
    row.outputTokens += usage.outputTokens;
    row.thinkingTokens += usage.thinkingTokens;
    row.cacheReadTokens += usage.cacheReadTokens;
    row.totalTokens += usage.totalTokens;
    this.byModel.set(key, row);
  }

  get spent(): number {
    let sum = 0;
    for (const row of this.byModel.values()) sum += row.totalTokens;
    return sum;
  }

  rows(): ModelUsage[] {
    return [...this.byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  }

  /** Throws before a run starts once the budget is gone. */
  assertWithinBudget(): void {
    if (this.budgetTokens !== undefined && this.spent >= this.budgetTokens) {
      throw new BudgetExceededError(this.spent, this.budgetTokens);
    }
  }

  get budget(): number | undefined {
    return this.budgetTokens;
  }
}
