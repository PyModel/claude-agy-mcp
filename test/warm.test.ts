import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import {
  turnMessage,
  WarmSessions,
  WarmTimeout,
  WarmTurnUncertain,
  WarmUnavailable,
  type SessionProcess,
} from "../src/warm.js";

const TURN = { timeoutMs: 60_000 };
import { fullCaps, oldCaps, testConfig } from "./support.js";

const cfg: Config = { ...testConfig, warmSessions: true, warmMax: 2, warmIdleSec: 300 };

/** A resident agy that answers whatever the driver writes to it. */
function fakeSession() {
  const spawned: { args: string[]; cwd: string; env?: Record<string, string> }[] = [];
  const written: string[] = [];
  const kills: string[] = [];
  let emit: (chunk: string) => void = () => {};
  let exit: () => void = () => {};

  const spawnSession = (
    _file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): SessionProcess => {
    spawned.push({ args, ...opts });
    return {
      write: (line) => written.push(line),
      onData: (cb) => (emit = cb),
      onExit: (cb) => (exit = cb),
      kill: (signal) => kills.push(signal),
    };
  };

  const result = (response: string, conversationId = "conv-1", totalTokens = 2) =>
    `${JSON.stringify({
      event: "result",
      result: {
        conversation_id: conversationId,
        status: "SUCCESS",
        response,
        num_turns: 1,
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: totalTokens,
        },
      },
    })}\n`;

  const step = (text: string) =>
    `${JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: text,
      },
    })}\n`;

  // `emit` must forward through the closure: capturing the variable's value here
  // would freeze the initial no-op before onData replaced it.
  return {
    spawnSession,
    spawned,
    written,
    kills,
    answer: (r: string, totalTokens?: number) => emit(result(r, "conv-1", totalTokens)),
    emit: (chunk: string) => emit(chunk),
    step,
    die: () => exit(),
  };
}

describe("turnMessage", () => {
  it("uses the exact envelope agy accepts, found by probing its rejections", () => {
    expect(turnMessage("hello")).toBe('{"event":"user","message":{"content":"hello"}}\n');
  });
});

describe("WarmSessions", () => {
  it("is disabled when the config says so or agy cannot stream", () => {
    const s = fakeSession();
    expect(
      new WarmSessions({ ...cfg, warmSessions: false }, fullCaps, { spawnSession: s.spawnSession })
        .enabled,
    ).toBe(false);
    expect(new WarmSessions(cfg, oldCaps, { spawnSession: s.spawnSession }).enabled).toBe(false);
    expect(new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession }).enabled).toBe(true);
  });

  it("starts one resident process per conversation and reuses it for the next turn", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });

    const first = warm.turn("conv-1", "/repo", "question one", TURN);
    s.answer("answer one");
    expect(await first).toMatchObject({ response: "answer one" });

    const second = warm.turn("conv-1", "/repo", "question two", TURN);
    s.answer("answer two");
    expect(await second).toMatchObject({ response: "answer two" });

    expect(s.spawned).toHaveLength(1);
    expect(s.written).toEqual([turnMessage("question one"), turnMessage("question two")]);
    expect(warm.stats()).toEqual({ resident: 1, keys: ["conv-1"] });
    warm.shutdown();
  });

  it("resumes the conversation it was given, in stream-json both ways", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-9", "/repo", "q", TURN);
    s.answer("a");
    await p;
    const args = s.spawned[0]!.args;
    expect(args).toEqual(
      expect.arrayContaining([
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--conversation",
        "conv-9",
        "--add-dir",
        "/repo",
        "--disable-slash-commands",
      ]),
    );
    warm.shutdown();
  });

  it("streams partial text to the progress callback before the result arrives", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const seen: string[] = [];
    const p = warm.turn("conv-1", "/repo", "q", { ...TURN, onProgress: (t) => seen.push(t) });
    s.emit(s.step("par"));
    s.emit(s.step("tial"));
    s.answer("partial");
    await p;
    expect(seen).toEqual(["par", "partial"]);
    warm.shutdown();
  });

  it("survives an NDJSON line split across two chunks", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-1", "/repo", "q", TURN);
    const line = s.step("hello");
    s.emit(line.slice(0, 20));
    s.emit(line.slice(20));
    s.answer("hello");
    expect(await p).toMatchObject({ response: "hello" });
    warm.shutdown();
  });

  it("reports a process that dies after the turn was sent as uncertain, not as run-cold", async () => {
    // The prompt reached agy's stdin, so it may have run. A cold re-run could
    // apply its effects a second time; the caller has to be told instead.
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-1", "/repo", "q", TURN);
    s.die();
    await expect(p).rejects.toThrow(WarmTurnUncertain);
    expect(warm.stats().resident).toBe(0);
  });

  it("refuses a second concurrent turn on one session instead of interleaving them", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const first = warm.turn("conv-1", "/repo", "one", TURN);
    await expect(warm.turn("conv-1", "/repo", "two", TURN)).rejects.toThrow(WarmUnavailable);
    s.answer("done");
    await first;
    warm.shutdown();
  });

  it("evicts the least recently used session once the cap is reached", async () => {
    const s = fakeSession();
    const warm = new WarmSessions({ ...cfg, warmMax: 2 }, fullCaps, {
      spawnSession: s.spawnSession,
    });
    for (const id of ["a", "b"]) {
      const p = warm.turn(id, "/repo", "q", TURN);
      s.answer("ok");
      await p;
    }
    expect(warm.stats().resident).toBe(2);
    const p = warm.turn("c", "/repo", "q", TURN);
    s.answer("ok");
    await p;
    expect(warm.stats().resident).toBe(2);
    expect(warm.stats().keys).toContain("c");
    expect(s.kills).toContain("SIGTERM");
    warm.shutdown();
  });

  it("kills every resident process on shutdown", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-1", "/repo", "q", TURN);
    s.answer("ok");
    await p;
    warm.shutdown();
    // SIGKILL immediately, not on a deferred timer: on the way out there is no
    // later, and these children are detached with permissions skipped, so one
    // that ignores SIGTERM would outlive the bridge for good.
    expect(s.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(warm.stats().resident).toBe(0);
  });

  it("reports each turn's own usage, not agy's running total for the conversation", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const first = warm.turn("conv-1", "/repo", "one", TURN);
    s.answer("a", 7815);
    expect((await first).usage.totalTokens).toBe(7815);
    const second = warm.turn("conv-1", "/repo", "two", TURN);
    s.answer("b", 15709);
    expect((await second).usage.totalTokens).toBe(15709 - 7815);
    warm.shutdown();
  });

  it("passes the extra environment to the resident process", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, {
      spawnSession: s.spawnSession,
      env: { AGY_DELEGATION_DEPTH: "1" },
    });
    const p = warm.turn("conv-1", "/repo", "q", TURN);
    s.answer("ok");
    await p;
    expect(s.spawned[0]!.env).toEqual({ AGY_DELEGATION_DEPTH: "1" });
    warm.shutdown();
  });

  it("drops the session and reports the streamed text when a turn times out", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-1", "/repo", "q", { timeoutMs: 10 });
    s.emit(s.step("half an"));
    const err = (await p.catch((e: Error) => e)) as WarmTimeout;
    expect(err).toBeInstanceOf(WarmTimeout);
    expect(err.text).toBe("half an");
    expect(warm.stats().resident).toBe(0);
    expect(s.kills).toContain("SIGTERM");
  });

  it("drops the session and rejects as cancelled when the signal fires", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const ac = new AbortController();
    const p = warm.turn("conv-1", "/repo", "q", { ...TURN, signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(warm.stats().resident).toBe(0);
  });

  it("runs cold instead of exceeding the cap when every resident session is busy", async () => {
    const s = fakeSession();
    const warm = new WarmSessions({ ...cfg, warmMax: 1 }, fullCaps, {
      spawnSession: s.spawnSession,
    });
    const first = warm.turn("a", "/repo", "q", TURN);
    await expect(warm.turn("b", "/repo", "q", TURN)).rejects.toThrow(WarmUnavailable);
    expect(warm.stats().resident).toBe(1);
    s.answer("ok");
    await first;
    warm.shutdown();
  });

  it("drops an idle session once its TTL expires", async () => {
    const s = fakeSession();
    const warm = new WarmSessions({ ...cfg, warmIdleSec: 0.01 }, fullCaps, {
      spawnSession: s.spawnSession,
    });
    const p = warm.turn("conv-1", "/repo", "q", TURN);
    s.answer("ok");
    await p;
    await new Promise((r) => setTimeout(r, 30));
    expect(warm.stats().resident).toBe(0);
    expect(s.kills).toContain("SIGTERM");
  });
});

describe("ambiguous turn outcomes (COR-M8)", () => {
  it("reports uncertainty instead of a safe-to-retry failure once the turn was sent", async () => {
    // A dropped session used to reject with WarmUnavailable in both cases, and
    // the caller acts on that by re-sending the prompt. Re-sending a turn agy
    // may already have processed applies a write follow-up twice.
    const f = fakeSession();
    const pool = new WarmSessions(cfg, fullCaps, { spawnSession: f.spawnSession });
    const turn = pool.turn("conv-1", "/repo", "do the thing", TURN);
    await Promise.resolve();
    expect(f.written).toHaveLength(1);
    pool.shutdown();
    await expect(turn).rejects.toBeInstanceOf(WarmTurnUncertain);
    // Still exactly one send: nothing replayed it.
    expect(f.written).toHaveLength(1);
  });
});

describe("WarmSessions mismatch", () => {
  const confinement = {
    available: true,
    wrap: (file: string, args: string[]) => ({ file, args }),
  };

  it("drops an idle resident when a turn needs a different cwd or confinement", async () => {
    for (const next of [
      { cwd: "/elsewhere", confineTo: ["/repo"] },
      { cwd: "/repo", confineTo: undefined },
    ]) {
      const s = fakeSession();
      const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession, confinement });
      const first = warm.turn("conv-1", "/repo", "q", { ...TURN, confineTo: ["/repo"] });
      s.answer("ok");
      await first;
      await expect(
        warm.turn("conv-1", next.cwd, "q2", { ...TURN, confineTo: next.confineTo }),
      ).rejects.toThrow(WarmUnavailable);
      expect(warm.stats().resident).toBe(0);
      expect(s.kills.length).toBeGreaterThan(0);
      warm.shutdown();
    }
  });

  it("reuses a resident when the same roots arrive in another order or spelling", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession, confinement });
    const first = warm.turn("conv-1", "/repo", "q", { ...TURN, confineTo: ["/repo", "/other"] });
    s.answer("ok");
    await first;
    const second = warm.turn("conv-1", "/repo/", "q2", {
      ...TURN,
      confineTo: ["/other/", "/repo"],
    });
    s.answer("ok2");
    await second;
    expect(s.spawned).toHaveLength(1);
    warm.shutdown();
  });
});
