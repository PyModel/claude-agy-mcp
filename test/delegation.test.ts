import { describe, it, expect } from "vitest";
import { Delegator } from "../src/delegation.js";
import { ModelRegistry } from "../src/models.js";
import { CooldownRegistry } from "../src/quota.js";
import { TOOLS } from "../src/tools.js";
import type { Config } from "../src/config.js";
import { fakeAgy, FAST_TIMING, LISTING, LOG_429, testConfig } from "./support.js";

const toolNamed = (name: string) => TOOLS.find((t) => t.name === name)!;

/** An agy that hits a 429 for `quotaModels` and stalls forever for `stallModels`. */
function agyWhere(quotaModels: string[] = [], stallModels: string[] = []) {
  return fakeAgy((args) => {
    const i = args.indexOf("--model");
    const model = i === -1 ? undefined : args[i + 1];
    if (model && quotaModels.includes(model)) return { log: LOG_429, stdout: "", exitCode: 0 };
    if (model && stallModels.includes(model)) return { neverExit: true, stdout: "partial output" };
    return { stdout: "the answer" };
  });
}

function delegatorFor(
  agy: ReturnType<typeof fakeAgy>,
  overrides: Partial<Config> = {},
  cooldowns = new CooldownRegistry(),
) {
  return new Delegator(
    { ...testConfig, ...overrides },
    new ModelRegistry(async () => LISTING),
    cooldowns,
    { spawn: agy.spawn, timing: FAST_TIMING, readSessions: async () => '{"/repo":"sess-1"}' },
  );
}

const request = (tool: string, args: Record<string, unknown>) => ({
  tool: toolNamed(tool),
  args,
  cwd: "/repo",
  timeoutSec: 3600,
});

describe("Delegator", () => {
  it("runs the first available chain model and reports it", async () => {
    const agy = agyWhere();
    const d = await delegatorFor(agy).run(request("delegate", { prompt: "do x" }));
    expect(d.output).toBe("the answer");
    expect(d.model).toBe("Gemini 3.7 Flash (High)");
    expect(d.attempts).toEqual([]);
    expect(d.sessionId).toBe("sess-1");
    expect(d.timedOut).toBe(false);
  });

  it("fails over to the next chain model on quota exhaustion", async () => {
    const agy = agyWhere(["Gemini 3.7 Flash (Medium)"]);
    const d = await delegatorFor(agy).run(request("web_lookup", { query: "docs" }));
    expect(agy.runs.map(agy.modelOf)).toEqual([
      "Gemini 3.7 Flash (Medium)",
      "Gemini 3.7 Flash (High)",
    ]);
    expect(d.model).toBe("Gemini 3.7 Flash (High)");
    expect(d.attempts).toEqual(["Gemini 3.7 Flash (Medium): quota exhausted (resets in 4h24m)"]);
  });

  it("skips a cooling model on the next call without spawning it", async () => {
    const agy = agyWhere(["Gemini 3.7 Flash (Medium)"]);
    const delegator = delegatorFor(agy);
    await delegator.run(request("web_lookup", { query: "first" }));
    const second = await delegator.run(request("web_lookup", { query: "second" }));
    expect(agy.runs).toHaveLength(3);
    expect(agy.modelOf(agy.runs[2])).toBe("Gemini 3.7 Flash (High)");
    expect(second.attempts).toEqual([
      expect.stringMatching(/Gemini 3\.7 Flash \(Medium\): quota cooldown, .* left/),
    ]);
  });

  it("throws with every reset time when the whole chain is exhausted", async () => {
    const agy = agyWhere([
      "Gemini 3.7 Flash (Medium)",
      "Gemini 3.7 Flash (High)",
      "Gemini 3.5 Flash (High)",
    ]);
    const err = await delegatorFor(agy)
      .run(request("web_lookup", { query: "docs" }))
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/quota-exhausted or cooling down/);
    expect((err as Error).message).toContain("4h24m");
  });

  it("reports a degraded resolution as a note", async () => {
    const agy = agyWhere();
    const delegator = new Delegator(
      testConfig,
      new ModelRegistry(async () => {
        throw new Error("agy models failed");
      }),
      new CooldownRegistry(),
      { spawn: agy.spawn, timing: FAST_TIMING, readSessions: async () => "{}" },
    );
    const d = await delegator.run(request("delegate", { prompt: "x" }));
    expect(d.model).toBeUndefined();
    expect(d.note).toMatch(/could not list/i);
  });

  it("continues a session without resolving or passing a model", async () => {
    const agy = agyWhere();
    const d = await delegatorFor(agy).run({
      ...request("follow_up", { session_id: "abc", question: "more?" }),
      conversationId: "abc",
    });
    expect(agy.runs[0]).toContain("--conversation");
    expect(agy.runs[0]).toContain("abc");
    expect(agy.runs[0]).not.toContain("--model");
    expect(d.model).toBeUndefined();
  });

  it("honours a caller-pinned model over the tool's chain", async () => {
    const agy = agyWhere();
    const d = await delegatorFor(agy).run({
      ...request("delegate", { prompt: "x" }),
      model: "Gemini 3.1 Pro (High)",
    });
    expect(d.model).toBe("Gemini 3.1 Pro (High)");
  });

  it("marks a run that hit the deadline instead of failing over", async () => {
    const agy = agyWhere([], ["Gemini 3.7 Flash (High)"]);
    const d = await delegatorFor(agy, { timeoutSec: 0.05 }).run({
      ...request("delegate", { prompt: "x" }),
      timeoutSec: 0.05,
    });
    expect(d.timedOut).toBe(true);
    expect(d.output).toBe("partial output");
    expect(agy.runs).toHaveLength(1);
  });

  it("propagates cancellation instead of trying the next model", async () => {
    const agy = agyWhere([], ["Gemini 3.7 Flash (High)"]);
    const ac = new AbortController();
    const p = delegatorFor(agy).run({ ...request("delegate", { prompt: "x" }), signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(agy.runs).toHaveLength(1);
  });

  it("rejects tool arguments that violate the tool's schema", async () => {
    const agy = agyWhere();
    await expect(delegatorFor(agy).run(request("adversarial_review", {}))).rejects.toThrow(
      /content.*files/i,
    );
    expect(agy.runs).toHaveLength(0);
  });
});
