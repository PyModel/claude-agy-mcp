import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import { DelegationDepthError } from "../src/delegation.js";
import { PathNotAllowedError } from "../src/egress.js";
import { BudgetExceededError } from "../src/usage.js";
import {
  fakeAgy,
  LOG_429,
  makeDelegator,
  oldCaps,
  toolNamed,
  valueOf,
  type DelegatorOptions,
} from "./support.js";

/** An agy that hits a 429 for `quotaModels` and stalls forever for `stallModels`. */
function agyWhere(quotaModels: string[] = [], stallModels: string[] = []) {
  return fakeAgy((args) => {
    const model = valueOf(args, "--model");
    if (model && quotaModels.includes(model))
      return { log: `${LOG_429}\n`, answer: "", exitCode: 0 };
    if (model && stallModels.includes(model)) return { neverExit: true, answer: "partial output" };
    return { answer: "the answer" };
  });
}

function delegatorFor(
  agy: ReturnType<typeof fakeAgy>,
  cfg: Partial<Config> = {},
  extra: Partial<DelegatorOptions> = {},
) {
  return makeDelegator({ spawn: agy.spawn, cfg, ...extra }).delegator;
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
    expect(d.model).toBe("Gemini 3.8 Flash (High)");
    expect(d.attempts).toEqual([]);
    expect(d.timedOut).toBe(false);
    expect(d.warm).toBe(false);
  });

  it("prefers the envelope's conversation id over the shared last-conversation cache", async () => {
    const agy = fakeAgy({ envelope: { response: "hi", conversationId: "from-envelope" } });
    const d = await delegatorFor(agy).run(request("delegate", { prompt: "x" }));
    expect(d.sessionId).toBe("from-envelope");
  });

  // SEC-M5. agy's last-conversation cache is keyed by directory across the whole
  // machine, so falling back to it handed the caller whatever interactive agy
  // session the user last ran there — readable and appendable through follow_up.
  // A run that reports no conversation id now has no resumable session at all.
  it("never invents a session id from agy's global conversation cache", async () => {
    const agy = fakeAgy({ stdout: "plain answer" });
    // write:true so the run uses accept-edits: an old agy cannot enforce plan
    // mode, and a read-only call against one is now refused outright.
    const d = await delegatorFor(agy, {}, { caps: oldCaps }).run({
      ...request("delegate", { prompt: "x" }),
      write: true,
    });
    expect(d.sessionId).toBeUndefined();
  });

  it("fails over to the next chain model on quota exhaustion", async () => {
    const agy = agyWhere(["Gemini 3.8 Flash (High)"]);
    const d = await delegatorFor(agy).run(request("web_lookup", { query: "docs" }));
    expect(agy.runs.map(agy.modelOf)).toEqual([
      "Gemini 3.8 Flash (High)",
      "Gemini 3.8 Flash (Medium)",
    ]);
    expect(d.model).toBe("Gemini 3.8 Flash (Medium)");
    expect(d.attempts).toEqual(["Gemini 3.8 Flash (High): quota exhausted (resets in 4h24m)"]);
  });

  it("keeps the fallback's own tier when the pinned model carries a different effort", async () => {
    // A set_model choice of Flash (High) at high effort must not turn the
    // Flash (Medium) fallback back into the Flash (High) that just hit its quota.
    const agy = agyWhere(["Gemini 3.8 Flash (High)"]);
    const delegator = delegatorFor(agy);
    await delegator.setPreference("gemini-flash@latest-high", "high");
    const d = await delegator.run(request("web_lookup", { query: "docs" }));
    expect(agy.runs.map(agy.modelOf)).toEqual([
      "Gemini 3.8 Flash (High)",
      "Gemini 3.8 Flash (Medium)",
    ]);
    expect(d.model).toBe("Gemini 3.8 Flash (Medium)");
  });

  it("cools down the model it actually sent, not the name it re-tiered from", async () => {
    // Pinned Flash (High) at low effort runs as Flash (Low)... which this listing
    // lacks, so it stays Flash (High); a medium pin does re-tier and must cool Medium.
    const agy = agyWhere(["Gemini 3.8 Flash (Medium)"]);
    const delegator = delegatorFor(agy);
    const err = await delegator
      .run({
        ...request("web_lookup", { query: "x" }),
        model: "Gemini 3.8 Flash (High)",
        effort: "medium",
      })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/quota-exhausted/);
    expect(agy.runs.map(agy.modelOf)).toEqual(["Gemini 3.8 Flash (Medium)"]);
    expect(delegator.status().cooldowns.map((c) => c.model)).toEqual(["Gemini 3.8 Flash (Medium)"]);
  });

  it("does NOT fail over when the failure is the request's fault, not the model's", async () => {
    const agy = fakeAgy({
      envelope: { status: "ERROR", error: "UNAUTHENTICATED: please login again" },
      exitCode: 1,
    });
    await expect(delegatorFor(agy).run(request("web_lookup", { query: "x" }))).rejects.toThrow(
      /login again/,
    );
    expect(agy.runs).toHaveLength(1);
  });

  it("skips a cooling model on the next call without spawning it", async () => {
    const agy = agyWhere(["Gemini 3.8 Flash (High)"]);
    const delegator = delegatorFor(agy);
    await delegator.run(request("web_lookup", { query: "first" }));
    const second = await delegator.run(request("web_lookup", { query: "second" }));
    expect(agy.runs).toHaveLength(3);
    expect(agy.modelOf(agy.runs[2]!)).toBe("Gemini 3.8 Flash (Medium)");
    expect(second.attempts).toEqual([
      expect.stringMatching(/Gemini 3\.8 Flash \(High\): quota cooldown, .* left/),
    ]);
  });

  it("throws with every reset time when the whole chain is exhausted", async () => {
    const agy = agyWhere(["Gemini 3.8 Flash (Medium)", "Gemini 3.8 Flash (High)"]);
    const err = await delegatorFor(agy)
      .run(request("web_lookup", { query: "docs" }))
      .catch((e: Error) => e);
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
    expect(valueOf(agy.runs[0]!, "--conversation")).toBe("abc");
    expect(agy.runs[0]).not.toContain("--model");
    expect(d.model).toBeUndefined();
  });

  it("lets a follow-up pin a different model, for a second opinion on the same history", async () => {
    const agy = agyWhere();
    const d = await delegatorFor(agy).run({
      ...request("follow_up", { session_id: "abc", question: "critique that" }),
      conversationId: "abc",
      model: "Claude Opus 4.6 (Thinking)",
    });
    expect(valueOf(agy.runs[0]!, "--conversation")).toBe("abc");
    expect(valueOf(agy.runs[0]!, "--model")).toBe("Claude Opus 4.6 (Thinking)");
    expect(d.model).toBe("Claude Opus 4.6 (Thinking)");
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
    const agy = agyWhere([], ["Gemini 3.8 Flash (High)"]);
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
    const agy = agyWhere([], ["Gemini 3.8 Flash (High)"]);
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

describe("Delegator guards", () => {
  it("refuses to delegate once it is already a delegation deep, naming the cycle", async () => {
    const agy = agyWhere();
    const { delegator } = makeDelegator({
      spawn: agy.spawn,
      env: { AGY_DELEGATION_DEPTH: "1" },
    });
    await expect(delegator.run(request("delegate", { prompt: "x" }))).rejects.toThrow(
      DelegationDepthError,
    );
    expect(agy.runs).toHaveLength(0);
  });

  it("tells the child which depth it is running at", async () => {
    const agy = agyWhere();
    await delegatorFor(agy).run(request("delegate", { prompt: "x" }));
    expect(agy.envs[0]).toEqual({ AGY_DELEGATION_DEPTH: "1" });
  });

  it("stops once the token budget is spent", async () => {
    const agy = fakeAgy({ envelope: { response: "hi", totalTokens: 100 } });
    const delegator = delegatorFor(agy, { budgetTokens: 150 });
    await delegator.run(request("delegate", { prompt: "one" }));
    await delegator.run(request("delegate", { prompt: "two" }));
    await expect(delegator.run(request("delegate", { prompt: "three" }))).rejects.toThrow(
      BudgetExceededError,
    );
    expect(agy.runs).toHaveLength(2);
  });

  it("refuses a file outside the allowed roots before agy sees it", async () => {
    const agy = agyWhere();
    const delegator = delegatorFor(agy, { allowedRoots: ["/repo"] });
    await expect(
      delegator.run(request("analyze_files", { files: ["/etc/shadow"], question: "q" })),
    ).rejects.toThrow(PathNotAllowedError);
    expect(agy.runs).toHaveLength(0);
  });

  it("allows a file inside the allowed roots", async () => {
    const agy = agyWhere();
    const delegator = delegatorFor(agy, { allowedRoots: ["/repo"] });
    await delegator.run(request("analyze_files", { files: ["src/a.ts"], question: "q" }));
    expect(agy.runs).toHaveLength(1);
  });

  it("scrubs credential-shaped strings out of what it hands back", async () => {
    const agy = fakeAgy({
      envelope: { response: "found AKIAIOSFODNN7EXAMPLE in config, and API_TOKEN=hunter2hunter2" },
    });
    const d = await delegatorFor(agy).run(request("delegate", { prompt: "x" }));
    expect(d.output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(d.output).not.toContain("hunter2hunter2");
    expect(d.redactions).toBe(2);
  });

  it("never runs more than AGY_MAX_CONCURRENCY agy processes at once", async () => {
    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const agy = fakeAgy(() => {
      live++;
      peak = Math.max(peak, live);
      return {
        answer: "ok",
        hold: new Promise<void>((resolve) =>
          gates.push(() => {
            live--;
            resolve();
          }),
        ),
      };
    });
    const delegator = delegatorFor(agy, { maxConcurrency: 2 });
    const running = Array.from({ length: 6 }, () =>
      delegator.run(request("delegate", { prompt: "x" })),
    );

    // Drain one at a time, waiting for each admitted run to actually reach the
    // spawn. A single macrotask tick is not enough under load: the gate would
    // still be empty, the shift would be a no-op, and the assertion below would
    // measure an empty semaphore rather than a full one.
    for (let i = 0; i < 6; i++) {
      while (gates.length === 0) await new Promise((r) => setTimeout(r, 0));
      expect(live).toBeLessThanOrEqual(2);
      gates.shift()!();
    }
    await Promise.all(running);
    expect(peak).toBe(2);
    expect(agy.runs).toHaveLength(6);
  });

  it("serialises two calls against the same conversation", async () => {
    const order: string[] = [];
    const agy = fakeAgy((args) => {
      order.push(`start ${valueOf(args, "--conversation")}`);
      return { answer: "ok" };
    });
    const delegator = delegatorFor(agy, { maxConcurrency: 4 });
    const call = () =>
      delegator.run({
        ...request("follow_up", { session_id: "same", question: "q" }),
        conversationId: "same",
      });
    await Promise.all([call(), call()]);
    expect(order).toEqual(["start same", "start same"]);
    expect(agy.runs).toHaveLength(2);
  });
});

describe("Delegator warm sessions", () => {
  /** A resident agy that answers each written turn with a canned response. */
  function residentAgy(
    behaviour: "answers" | "dies" | "stalls" = "answers",
    reportedId = "conv-1",
  ) {
    const written: string[] = [];
    let emit: (chunk: string) => void = () => {};
    let exit: () => void = () => {};
    const envs: (Record<string, string> | undefined)[] = [];
    const spawnSession = (_f: string, _a: string[], opts: { env?: Record<string, string> }) => ({
      write: (line: string) => {
        written.push(line);
        envs.push(opts.env);
        if (behaviour === "dies") queueMicrotask(() => exit());
        else if (behaviour === "stalls") return;
        else
          queueMicrotask(() =>
            emit(
              `${JSON.stringify({
                event: "result",
                result: {
                  conversation_id: reportedId,
                  status: "SUCCESS",
                  response: "warm answer",
                  num_turns: 2,
                  usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    thinking_tokens: 0,
                    cache_read_tokens: 0,
                    total_tokens: 3,
                  },
                },
              })}\n`,
            ),
          );
      },
      onData: (cb: (c: string) => void) => (emit = cb),
      onExit: (cb: () => void) => (exit = cb),
      kill: () => {},
    });
    return { spawnSession, written, envs };
  }

  const followUp = () => ({
    ...request("follow_up", { session_id: "conv-1", question: "more?" }),
    conversationId: "conv-1",
  });

  // F-05. agy answers `--conversation <unknown>` from a brand-new conversation and
  // exits 0, only warning on the side. A resident session must not pass that fork
  // off as the continuation the caller asked for.
  it("reports a warm follow-up that agy forked into a new conversation", async () => {
    const resident = residentAgy("answers", "conv-new");
    const delegator = delegatorFor(
      agyWhere(),
      { warmSessions: true },
      { spawnSession: resident.spawnSession },
    );
    const d = await delegator.run(followUp());
    expect(d.warm).toBe(true);
    expect(d.sessionId).toBe("conv-new");
    expect(d.continuation).toEqual({ requested: "conv-1", resumed: false });
    delegator.shutdown();
  });

  it("answers a follow-up from a resident process instead of spawning agy again", async () => {
    const agy = agyWhere();
    const resident = residentAgy();
    const delegator = delegatorFor(
      agy,
      { warmSessions: true },
      {
        spawnSession: resident.spawnSession,
      },
    );
    const d = await delegator.run(followUp());
    expect(d.output).toBe("warm answer");
    expect(d.warm).toBe(true);
    expect(agy.runs).toHaveLength(0);
    expect(resident.written).toHaveLength(1);
    delegator.shutdown();
  });

  it("falls back to a cold run, and says so, when the resident process dies", async () => {
    const agy = agyWhere();
    const resident = residentAgy("dies");
    const delegator = delegatorFor(
      agy,
      { warmSessions: true },
      {
        spawnSession: resident.spawnSession,
      },
    );
    const d = await delegator.run(followUp());
    expect(d.output).toBe("the answer");
    expect(d.warm).toBe(false);
    expect(d.attempts[0]).toMatch(/warm session unavailable.*fresh agy process/);
    expect(agy.runs).toHaveLength(1);
    delegator.shutdown();
  });

  it("tells the resident process which delegation depth it runs at", async () => {
    const resident = residentAgy();
    const delegator = delegatorFor(
      agyWhere(),
      { warmSessions: true },
      { spawnSession: resident.spawnSession },
    );
    await delegator.run(followUp());
    expect(resident.envs[0]).toEqual({ AGY_DELEGATION_DEPTH: "1" });
    delegator.shutdown();
  });

  it("runs cold when the follow-up pins a model, an effort, or asks to write", async () => {
    for (const extra of [{ model: "Gemini 3.1 Pro (High)" }, { effort: "low" as const }]) {
      const agy = agyWhere();
      const resident = residentAgy();
      const delegator = delegatorFor(
        agy,
        { warmSessions: true },
        { spawnSession: resident.spawnSession },
      );
      const d = await delegator.run({ ...followUp(), ...extra });
      expect(d.warm).toBe(false);
      expect(resident.written).toHaveLength(0);
      expect(agy.runs).toHaveLength(1);
      delegator.shutdown();
    }
    const agy = agyWhere();
    const resident = residentAgy();
    const delegator = delegatorFor(
      agy,
      { warmSessions: true },
      { spawnSession: resident.spawnSession },
    );
    const d = await delegator.run({
      ...request("delegate", { prompt: "fix it", session_id: "conv-1" }),
      conversationId: "conv-1",
      write: true,
    });
    expect(d.warm).toBe(false);
    expect(valueOf(agy.runs[0]!, "--mode")).toBe("accept-edits");
    delegator.shutdown();
  });

  it("returns the partial text as a timed-out delegation when the resident turn stalls", async () => {
    const agy = agyWhere();
    const resident = residentAgy("stalls");
    const delegator = delegatorFor(
      agy,
      { warmSessions: true },
      { spawnSession: resident.spawnSession },
    );
    const d = await delegator.run({ ...followUp(), timeoutSec: 0.01 });
    expect(d.timedOut).toBe(true);
    expect(d.warm).toBe(true);
    expect(agy.runs).toHaveLength(0);
    expect(delegator.status().warm.resident).toBe(0);
    delegator.shutdown();
  });

  it("does not use a resident session when the call needs a JSON schema", async () => {
    const agy = agyWhere();
    const resident = residentAgy();
    const delegator = delegatorFor(
      agy,
      { warmSessions: true },
      {
        spawnSession: resident.spawnSession,
      },
    );
    const d = await delegator.run({ ...followUp(), jsonSchema: '{"type":"object"}' });
    expect(d.warm).toBe(false);
    expect(resident.written).toHaveLength(0);
    expect(agy.runs).toHaveLength(1);
    delegator.shutdown();
  });
});

describe("Delegator.status", () => {
  it("reports spend, cooldowns and the agy it probed", async () => {
    const agy = agyWhere(["Gemini 3.8 Flash (High)"]);
    const delegator = delegatorFor(agy);
    await delegator.run(request("web_lookup", { query: "x" }));
    const s = delegator.status();
    expect(s.agyVersion).toBe("1.2.0");
    expect(s.spent).toBeGreaterThan(0);
    expect(s.cooldowns.map((c) => c.model)).toEqual(["Gemini 3.8 Flash (High)"]);
    expect(s.depth).toBe(0);
  });
});

describe("Delegator.runMany", () => {
  it("reports a failed leg without failing the others", async () => {
    const agy = fakeAgy((args) =>
      valueOf(args, "--model") === "Gemini 3.1 Pro (High)"
        ? { envelope: { status: "ERROR", error: "boom" }, exitCode: 1 }
        : { answer: "fine" },
    );
    const results = await delegatorFor(agy).runMany(request("delegate_many", { prompt: "q" }), [
      { model: "Gemini 3.8 Flash (High)", label: "flash" },
      { model: "Gemini 3.1 Pro (High)", label: "pro" },
    ]);
    expect(results.find((r) => r.label === "flash")?.delegation?.output).toBe("fine");
    expect(results.find((r) => r.label === "pro")?.error).toMatch(/boom/);
  });
});

describe("containment (SEC-M1, SEC-M6)", () => {
  it("rejects a file argument whose derived workspace root escapes the allowed roots", async () => {
    // `extraDirs` derives a workspace root with dirname(). A file argument equal
    // to the allowed root therefore derives its PARENT, which used to be handed
    // to agy as --add-dir without ever being containment-checked.
    const agy = fakeAgy({ answer: "ok" });
    const d = delegatorFor(agy, { allowedRoots: ["/repo"] });
    await expect(
      d.run(request("analyze_files", { files: ["/repo"], question: "q" })),
    ).rejects.toThrow(/outside the allowed roots/i);
  });

  it("still allows a file inside an allowed root", async () => {
    const agy = fakeAgy({ answer: "ok" });
    const d = delegatorFor(agy, { allowedRoots: ["/repo"] });
    await expect(
      d.run(request("analyze_files", { files: ["/repo/src/a.ts"], question: "q" })),
    ).resolves.toBeDefined();
  });
});

describe("read-only violation reporting (OWN-F3)", () => {
  const digests = (...seq: string[]) => {
    let i = 0;
    return async () => ({ method: "scan" as const, digest: seq[Math.min(i++, seq.length - 1)] });
  };

  it("flags a plan-mode run that changed the working tree", async () => {
    // agy does write in plan mode when permissions are skipped, verified against
    // agy 1.2.2. The bridge cannot prevent it, so it must report it.
    const agy = fakeAgy({ answer: "done" });
    const d = await makeDelegator({
      spawn: agy.spawn,
      snapshot: digests("before", "after"),
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(d.wroteInReadOnlyMode).toBe(true);
  });

  it("reports a clean plan-mode run as demonstrably unchanged", async () => {
    const agy = fakeAgy({ answer: "done" });
    const d = await makeDelegator({
      spawn: agy.spawn,
      snapshot: digests("same", "same"),
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(d.wroteInReadOnlyMode).toBe(false);
  });

  it("does not watch a run that was asked to write", async () => {
    const agy = fakeAgy({ answer: "done" });
    const d = await makeDelegator({
      spawn: agy.spawn,
      snapshot: digests("before", "after"),
    }).delegator.run({ ...request("delegate", { prompt: "x" }), write: true });
    expect(d.wroteInReadOnlyMode).toBeUndefined();
  });

  it("says nothing when the tree could not be fingerprinted", async () => {
    const agy = fakeAgy({ answer: "done" });
    const d = await makeDelegator({
      spawn: agy.spawn,
      snapshot: async () => ({ method: "none" as const }),
    }).delegator.run(request("delegate", { prompt: "x" }));
    expect(d.wroteInReadOnlyMode).toBeUndefined();
  });
});

describe("conversation continuity reporting (F-05)", () => {
  const followUp = (id: string) => ({
    ...request("follow_up", { session_id: id, question: "more?" }),
    conversationId: id,
  });

  it("reports a fork when agy answers from a different conversation than requested", async () => {
    const agy = fakeAgy({ envelope: { response: "Hello!", conversationId: "brand-new" } });
    const d = await delegatorFor(agy).run(followUp("never-issued"));
    expect(valueOf(agy.runs[0]!, "--conversation")).toBe("never-issued");
    expect(d.sessionId).toBe("brand-new");
    expect(d.continuation).toEqual({ requested: "never-issued", resumed: false });
  });

  it("confirms a continuation when agy reports the conversation it was asked for", async () => {
    const agy = fakeAgy({ envelope: { response: "more", conversationId: "abc" } });
    const d = await delegatorFor(agy).run(followUp("abc"));
    expect(d.continuation).toEqual({ requested: "abc", resumed: true });
  });

  it("makes no claim when agy reports no conversation id", async () => {
    // Plain text output carries no envelope. "Could not tell" must not read as
    // either "resumed" or "forked".
    const agy = fakeAgy({ stdout: "plain answer" });
    const d = await delegatorFor(agy, {}, { caps: oldCaps }).run({
      ...followUp("abc"),
      write: true,
    });
    expect(d.continuation).toBeUndefined();
  });

  it("makes no claim for a call that did not ask to continue anything", async () => {
    const agy = fakeAgy({ envelope: { response: "hi", conversationId: "fresh" } });
    const d = await delegatorFor(agy).run(request("delegate", { prompt: "x" }));
    expect(d.continuation).toBeUndefined();
  });
});
