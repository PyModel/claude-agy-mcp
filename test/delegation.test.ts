import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import { fakeAgy, LOG_429, makeDelegator, toolNamed, valueOf } from "./support.js";

const SESSIONS = '{"/repo":"sess-1"}';

/** An agy that hits a 429 for `quotaModels` and stalls forever for `stallModels`. */
function agyWhere(quotaModels: string[] = [], stallModels: string[] = []) {
  return fakeAgy((args) => {
    const model = valueOf(args, "--model");
    if (model && quotaModels.includes(model)) return { log: LOG_429, stdout: "", exitCode: 0 };
    if (model && stallModels.includes(model)) return { neverExit: true, stdout: "partial output" };
    return { stdout: "the answer" };
  });
}

function delegatorFor(agy: ReturnType<typeof fakeAgy>, cfg: Partial<Config> = {}) {
  return makeDelegator({ spawn: agy.spawn, cfg, sessions: SESSIONS }).delegator;
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
    const { delegator } = makeDelegator({
      spawn: agy.spawn,
      listing: () => Promise.reject(new Error("agy models failed")),
    });
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
    const d = await delegatorFor(agy).run({
      ...request("delegate", { prompt: "x" }),
      timeoutSec: 0.05,
    });
    expect(d.timedOut).toBe(true);
    expect(d.output).toBe("partial output");
    // README promises a timed-out run still hands back a session to resume from.
    expect(d.sessionId).toBe("sess-1");
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
