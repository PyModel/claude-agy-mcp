import { describe, it, expect } from "vitest";
import type { Config } from "../src/config.js";
import { turnMessage, WarmSessions, WarmUnavailable, type SessionProcess } from "../src/warm.js";
import { fullCaps, oldCaps, testConfig } from "./support.js";

const cfg: Config = { ...testConfig, warmSessions: true, warmMax: 2, warmIdleSec: 300 };

/** A resident agy that answers whatever the driver writes to it. */
function fakeSession() {
  const spawned: { args: string[]; cwd: string }[] = [];
  const written: string[] = [];
  const kills: string[] = [];
  let emit: (chunk: string) => void = () => {};
  let exit: () => void = () => {};

  const spawnSession = (_file: string, args: string[], cwd: string): SessionProcess => {
    spawned.push({ args, cwd });
    return {
      write: (line) => written.push(line),
      onData: (cb) => (emit = cb),
      onExit: (cb) => (exit = cb),
      kill: (signal) => kills.push(signal),
    };
  };

  const result = (response: string, conversationId = "conv-1") =>
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
          total_tokens: 2,
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
    answer: (r: string) => emit(result(r)),
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

    const first = warm.turn("conv-1", "/repo", "question one");
    s.answer("answer one");
    expect(await first).toMatchObject({ response: "answer one" });

    const second = warm.turn("conv-1", "/repo", "question two");
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
    const p = warm.turn("conv-9", "/repo", "q");
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
    const p = warm.turn("conv-1", "/repo", "q", (t) => seen.push(t));
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
    const p = warm.turn("conv-1", "/repo", "q");
    const line = s.step("hello");
    s.emit(line.slice(0, 20));
    s.emit(line.slice(20));
    s.answer("hello");
    expect(await p).toMatchObject({ response: "hello" });
    warm.shutdown();
  });

  it("asks the caller to run cold rather than failing when the process dies mid-turn", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const p = warm.turn("conv-1", "/repo", "q");
    s.die();
    await expect(p).rejects.toThrow(WarmUnavailable);
    expect(warm.stats().resident).toBe(0);
  });

  it("refuses a second concurrent turn on one session instead of interleaving them", async () => {
    const s = fakeSession();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const first = warm.turn("conv-1", "/repo", "one");
    await expect(warm.turn("conv-1", "/repo", "two")).rejects.toThrow(WarmUnavailable);
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
      const p = warm.turn(id, "/repo", "q");
      s.answer("ok");
      await p;
    }
    expect(warm.stats().resident).toBe(2);
    const p = warm.turn("c", "/repo", "q");
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
    const p = warm.turn("conv-1", "/repo", "q");
    s.answer("ok");
    await p;
    warm.shutdown();
    expect(s.kills).toEqual(["SIGTERM"]);
    expect(warm.stats().resident).toBe(0);
  });

  it("drops an idle session once its TTL expires", async () => {
    const s = fakeSession();
    const warm = new WarmSessions({ ...cfg, warmIdleSec: 0.01 }, fullCaps, {
      spawnSession: s.spawnSession,
    });
    const p = warm.turn("conv-1", "/repo", "q");
    s.answer("ok");
    await p;
    await new Promise((r) => setTimeout(r, 30));
    expect(warm.stats().resident).toBe(0);
    expect(s.kills).toContain("SIGTERM");
  });
});
