import { describe, it, expect } from "vitest";
import { EMPTY_USAGE } from "../src/envelope.js";
import { BudgetExceededError, UsageLedger } from "../src/usage.js";

const usage = (total: number) => ({ ...EMPTY_USAGE, inputTokens: 1, totalTokens: total });

describe("UsageLedger", () => {
  it("accumulates per model and sorts the heaviest first", () => {
    const ledger = new UsageLedger();
    ledger.record("Flash", usage(10));
    ledger.record("Flash", usage(5));
    ledger.record("Pro", usage(100));
    expect(ledger.rows().map((r) => [r.model, r.runs, r.totalTokens])).toEqual([
      ["Pro", 1, 100],
      ["Flash", 2, 15],
    ]);
    expect(ledger.spent).toBe(115);
  });

  it("files an unpinned run under agy's own default", () => {
    const ledger = new UsageLedger();
    ledger.record(undefined, usage(7));
    expect(ledger.rows()[0]!.model).toBe("agy default");
  });

  it("keeps cache_read out of the total, because agy reports it separately", () => {
    const ledger = new UsageLedger();
    ledger.record("Flash", { ...EMPTY_USAGE, cacheReadTokens: 9000, totalTokens: 10 });
    expect(ledger.spent).toBe(10);
    expect(ledger.rows()[0]!.cacheReadTokens).toBe(9000);
  });

  it("does not stop anything when no budget is set", () => {
    const ledger = new UsageLedger();
    ledger.record("Flash", usage(1_000_000));
    expect(() => ledger.assertWithinBudget()).not.toThrow();
  });

  it("stops once the budget is reached, naming the numbers", () => {
    const ledger = new UsageLedger(100);
    ledger.record("Flash", usage(60));
    expect(() => ledger.assertWithinBudget()).not.toThrow();
    ledger.record("Flash", usage(60));
    expect(() => ledger.assertWithinBudget()).toThrow(BudgetExceededError);
    expect(() => ledger.assertWithinBudget()).toThrow(/120 of 100/);
  });
});
