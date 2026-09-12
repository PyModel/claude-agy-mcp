import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, delegationDepth, loadConfig } from "../src/config.js";
import { KeyedMutex } from "../src/concurrency.js";
import { FileCooldownStore } from "../src/cooldown-store.js";
import { assertWithinRoots, redact } from "../src/egress.js";
import { classifyMessage } from "../src/failure.js";
import { CooldownRegistry, detectQuota, MemoryCooldownStore } from "../src/quota.js";
import { appendTail, runAgy, sweepStaleLogs } from "../src/runner.js";
import { createToolHandler } from "../src/server.js";
import { snapshotTree, treeChanged } from "../src/worktree.js";
import {
  WarmSessions,
  WarmTurnUncertain,
  WarmUnavailable,
  type SessionProcess,
} from "../src/warm.js";
import { STREAM_NDJSON } from "./fixtures.js";
import {
  envelopeJson,
  FAST_TIMING,
  fakeAgy,
  fullCaps,
  LOG_429,
  makeDelegator,
  testConfig,
  toolNamed,
  valueOf,
} from "./support.js";

const tmp = (prefix: string) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
const request = (tool: string, args: Record<string, unknown>, cwd = "/repo") => ({
  tool: toolNamed(tool),
  args,
  cwd,
  timeoutSec: 3600,
});
const textOf = (res: { content: { text: string }[] }) => res.content[0]!.text;
const rejects = (tool: string, args: Record<string, unknown>) =>
  expect(toolNamed(tool).schema.safeParse(args).success, JSON.stringify(args)).toBe(false);

describe("tool input validation", () => {
  it("rejects empty and whitespace-only text a model run would be spent on", () => {
    rejects("delegate", { prompt: "   " });
    rejects("follow_up", { session_id: "abc", question: "" });
    rejects("web_lookup", { query: " \n" });
    rejects("analyze_files", { files: ["a.ts"], question: "  " });
    rejects("deep_search", { query: "" });
    rejects("adversarial_review", { content: "   " });
  });

  it("rejects a session id that is empty, padded into a different id, or flag-shaped", () => {
    rejects("follow_up", { session_id: "", question: "q" });
    rejects("follow_up", { session_id: "-rf", question: "q" });
    rejects("delegate", { prompt: "p", model: "--help" });
    rejects("delegate", { prompt: "p", cwd: "" });
  });

  it("bounds and de-duplicates a fan-out, and refuses ambiguous shapes", () => {
    rejects("delegate_many", { tasks: ["", "A"] });
    rejects("delegate_many", { tasks: Array.from({ length: 9 }, (_, i) => `t${i}`) });
    rejects("delegate_many", { prompt: "p", models: ["x", "x"] });
    rejects("delegate_many", { tasks: ["A"], models: ["x"] });
  });

  it("refuses a prompt agy cannot receive before spawning anything", async () => {
    const agy = fakeAgy({ answer: "ok" });
    const run = (prompt: string) =>
      runAgy({ prompt, cwd: "/repo", timeoutSec: 60 }, testConfig, fullCaps, {
        spawn: agy.spawn,
        timing: FAST_TIMING,
      });
    await expect(run("has a \0 byte")).rejects.toThrow(/NUL/);
    const huge = "x".repeat(200_000);
    const err = (await run(huge).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/bytes/);
    expect(err.message.length).toBeLessThan(1000);
    expect(agy.runs).toHaveLength(0);
  });

  it("does not spawn agy for a call that was cancelled before it started", async () => {
    const agy = fakeAgy({ answer: "ok" });
    const signal = AbortSignal.abort();
    await expect(
      runAgy({ prompt: "q", cwd: "/repo", timeoutSec: 60, signal }, testConfig, fullCaps, {
        spawn: agy.spawn,
        timing: FAST_TIMING,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(agy.runs).toHaveLength(0);
  });
});

describe("configuration strictness", () => {
  const bad = (env: Record<string, string>) => expect(() => loadConfig(env)).toThrow(ConfigError);

  it("refuses a timeout Node's timers would overflow into an instant kill", () => {
    bad({ AGY_TIMEOUT: "3000000" });
    bad({ AGY_WARM_IDLE_SEC: "3000000" });
    bad({ AGY_TIMEOUT_DELEGATE: "3000000" });
  });

  it("accepts only plain decimal integers", () => {
    bad({ AGY_TIMEOUT: "1e3" });
    bad({ AGY_MAX_CONCURRENCY: "0x10" });
    bad({ AGY_MAX_OUTPUT_CHARS: " 5 " });
  });

  it("refuses a per-tool timeout for a tool that does not exist", () => {
    bad({ AGY_TIMEOUT_DEEPSEARCH: "10" });
  });

  it("normalises enum settings the way it normalises booleans", () => {
    expect(loadConfig({ AGY_EFFORT: " High " }).defaultEffort).toBe("high");
    expect(loadConfig({ AGY_ON_FAILURE: "STRICT" }).onFailure).toBe("strict");
  });

  it("fails closed on an unreadable delegation depth instead of reading it as zero", () => {
    expect(() => delegationDepth({ AGY_DELEGATION_DEPTH: "garbage" })).toThrow(ConfigError);
    expect(() => delegationDepth({ AGY_DELEGATION_DEPTH: "-1" })).toThrow(ConfigError);
    expect(delegationDepth({})).toBe(0);
  });
});

describe("containment and redaction", () => {
  it("judges `link/..` by where the OS will actually go, not by lexical normalisation", () => {
    const base = tmp("agy-escape-");
    mkdirSync(path.join(base, "root"));
    mkdirSync(path.join(base, "outside", "deep"), { recursive: true });
    symlinkSync(path.join(base, "outside", "deep"), path.join(base, "root", "link"));
    expect(() =>
      assertWithinRoots([`${path.join(base, "root", "link")}/..`], [path.join(base, "root")]),
    ).toThrow(/outside the allowed roots/);
  });

  it("allows a child whose name merely starts with two dots", () => {
    const base = tmp("agy-dots-");
    expect(() => assertWithinRoots([path.join(base, "..foo")], [base])).not.toThrow();
  });

  it("redacts in linear time on adversarial input", () => {
    // 400K chars: the quadratic pattern took over 20s here, linear takes
    // milliseconds, so the bound is generous for a slow shared runner.
    const started = Date.now();
    redact("TOKEN".repeat(80_000));
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("working-tree fingerprint", () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  const repo = () => {
    const dir = tmp("agy-git-");
    git(dir, "init", "-q");
    git(
      dir,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "i",
    );
    writeFileSync(path.join(dir, "tracked.txt"), "one\n");
    git(dir, "add", "tracked.txt");
    git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "t");
    return dir;
  };
  const changed = async (dir: string, act: () => void) => {
    const before = await snapshotTree(dir);
    act();
    return treeChanged(before, await snapshotTree(dir));
  };

  it("sees a second edit to a file that was already dirty", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "tracked.txt"), "two\n");
    expect(await changed(dir, () => writeFileSync(path.join(dir, "tracked.txt"), "six\n"))).toBe(
      true,
    );
  });

  it("sees an edit to an existing untracked file", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, "new.txt"), "aaa");
    expect(await changed(dir, () => writeFileSync(path.join(dir, "new.txt"), "bbb"))).toBe(true);
  });

  it("sees a mode change", async () => {
    const dir = repo();
    expect(await changed(dir, () => chmodSync(path.join(dir, "tracked.txt"), 0o755))).toBe(true);
  });

  it("sees a write to a file git ignores", async () => {
    // A plan-mode run that writes `.env` used to pass as read-only: git never
    // lists ignored files, and the fingerprint only asked git.
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), ".env\nbuild/\n");
    expect(await changed(dir, () => writeFileSync(path.join(dir, ".env"), "SECRET=1\n"))).toBe(
      true,
    );
  });

  it("sees a file added to an ignored directory, and a rewrite of an ignored file", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), ".env\nbuild/\n");
    mkdirSync(path.join(dir, "build"));
    writeFileSync(path.join(dir, ".env"), "A=1\n");
    expect(await changed(dir, () => writeFileSync(path.join(dir, "build", "out.js"), "x"))).toBe(
      true,
    );
    expect(await changed(dir, () => writeFileSync(path.join(dir, ".env"), "A=22\n"))).toBe(true);
  });

  it("sees a rewrite of a file inside an ignored directory, not only at its top", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "build/\n");
    mkdirSync(path.join(dir, "build", "sub"), { recursive: true });
    writeFileSync(path.join(dir, "build", "sub", "a.js"), "one");
    expect(
      await changed(dir, () => writeFileSync(path.join(dir, "build", "sub", "a.js"), "two!")),
    ).toBe(true);
  });

  it("keeps the git method, and sees a write, when an untracked nested repository is present", async () => {
    const dir = repo();
    mkdirSync(path.join(dir, "nested"));
    git(path.join(dir, "nested"), "init", "-q");
    writeFileSync(path.join(dir, "nested", "f.txt"), "one");
    expect((await snapshotTree(dir)).method).toBe("git");
    expect(await changed(dir, () => writeFileSync(path.join(dir, "nested", "f.txt"), "two!"))).toBe(
      true,
    );
  });

  it("keeps the git method when an untracked file name contains a newline", async () => {
    const dir = repo();
    const odd = path.join(dir, "odd\nname.txt");
    writeFileSync(odd, "one");
    expect((await snapshotTree(dir)).method).toBe("git");
    expect(await changed(dir, () => writeFileSync(odd, "two!"))).toBe(true);
  });

  it("cuts a huge ignored directory at a fixed count, so an unchanged tree still compares equal", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "cache/\n");
    mkdirSync(path.join(dir, "cache"));
    for (let i = 0; i < 1200; i++) writeFileSync(path.join(dir, "cache", `f${i}.bin`), "x");
    expect((await snapshotTree(dir)).method).toBe("git");
    expect(await changed(dir, () => {})).toBe(false);
    // f0 sorts first, so it is inside the walked prefix.
    expect(await changed(dir, () => writeFileSync(path.join(dir, "cache", "f0.bin"), "yy"))).toBe(
      true,
    );
  });

  it("covers an untracked directory whose whole content is ignored, once", async () => {
    // git lists both `u/` and `u/build/` here; the parent walk covers the child.
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "build/\n");
    mkdirSync(path.join(dir, "u", "build"), { recursive: true });
    writeFileSync(path.join(dir, "u", "build", "o.js"), "one");
    expect(await changed(dir, () => {})).toBe(false);
    expect(
      await changed(dir, () => writeFileSync(path.join(dir, "u", "build", "o.js"), "two!")),
    ).toBe(true);
  });

  it("still reports an untouched repository with ignored entries as unchanged", async () => {
    const dir = repo();
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "index.js"), "x");
    expect(await changed(dir, () => {})).toBe(false);
  });

  it("reports unknown when the two sides were taken by different methods", () => {
    expect(treeChanged({ method: "git", digest: "a" }, { method: "scan", digest: "b" })).toBe(
      undefined,
    );
  });

  it("scans nested build dirs, new empty dirs and mode changes outside git", async () => {
    const dir = tmp("agy-scan-");
    mkdirSync(path.join(dir, "pkg", "dist"), { recursive: true });
    writeFileSync(path.join(dir, "f.txt"), "x");
    expect(
      await changed(dir, () => writeFileSync(path.join(dir, "pkg", "dist", "out.js"), "x")),
    ).toBe(true);
    expect(await changed(dir, () => mkdirSync(path.join(dir, "empty")))).toBe(true);
    expect(await changed(dir, () => chmodSync(path.join(dir, "f.txt"), 0o700))).toBe(true);
  });
});

describe("delegation safety", () => {
  /** Per-path digests the test can move; any path not listed is stable. */
  const trees = () => {
    const state = new Map<string, number>();
    return {
      bump: (p: string) => state.set(p, (state.get(p) ?? 0) + 1),
      snapshot: async (p: string) => ({
        method: "scan" as const,
        digest: `${p}#${state.get(p) ?? 0}`,
      }),
    };
  };

  it("names a missing working directory instead of blaming the agy install", async () => {
    const e = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const agy = fakeAgy({ spawnError: e, exitCode: null });
    const missing = path.join(tmp("agy-cwd-"), "gone");
    const err = (await runAgy({ prompt: "q", cwd: missing, timeoutSec: 60 }, testConfig, fullCaps, {
      spawn: agy.spawn,
      timing: FAST_TIMING,
    }).catch((x: Error) => x)) as Error;
    expect(err.message).toContain(missing);
    expect(err.message).not.toMatch(/Install the Antigravity CLI/);
  });

  it("reports a plan-mode write into an extra workspace directory", async () => {
    const t = trees();
    const agy = fakeAgy((args) => {
      if (valueOf(args, "-p")) t.bump("/other");
      return { answer: "done" };
    });
    const { delegator } = makeDelegator({ spawn: agy.spawn, snapshot: t.snapshot });
    const d = await delegator.run({ ...request("delegate", { prompt: "x" }), dirs: ["/other"] });
    expect(d.wroteInReadOnlyMode).toBe(true);
  });

  it("reports a plan-mode write even when the run then fails", async () => {
    const t = trees();
    const agy = fakeAgy(() => {
      t.bump("/repo");
      return { stdout: "", exitCode: 1, stderr: "the disk is on fire" };
    });
    const { delegator } = makeDelegator({ spawn: agy.spawn, snapshot: t.snapshot });
    await expect(delegator.run(request("delegate", { prompt: "x" }))).rejects.toThrow(
      /READ-ONLY VIOLATION/,
    );
  });

  it("does not repeat a write run whose tree changed before a network failure", async () => {
    const t = trees();
    const agy = fakeAgy(() => {
      t.bump("/repo");
      return { stdout: "", exitCode: 1, stderr: "read tcp 1.2.3.4:443: connection reset by peer" };
    });
    const { delegator } = makeDelegator({ spawn: agy.spawn, snapshot: t.snapshot });
    const err = (await delegator
      .run({ ...request("delegate", { prompt: "x" }), write: true })
      .catch((e: Error) => e)) as Error;
    expect(agy.runs).toHaveLength(1);
    expect(err.message).toMatch(/not (re)?tried/i);
  });

  it("still retries a write run once when the tree is provably unchanged", async () => {
    const t = trees();
    let n = 0;
    const agy = fakeAgy(() =>
      n++ === 0
        ? { stdout: "", exitCode: 1, stderr: "dial tcp: connection refused" }
        : { answer: "ok" },
    );
    const { delegator } = makeDelegator({ spawn: agy.spawn, snapshot: t.snapshot });
    const d = await delegator.run({ ...request("delegate", { prompt: "x" }), write: true });
    expect(d.output).toBe("ok");
    expect(agy.runs).toHaveLength(2);
  });

  it("does not fail a write run over to the next model once the tree changed", async () => {
    const t = trees();
    const agy = fakeAgy(() => {
      t.bump("/repo");
      return { log: `${LOG_429}\n`, answer: "", exitCode: 0 };
    });
    const { delegator } = makeDelegator({ spawn: agy.spawn, snapshot: t.snapshot });
    await expect(
      delegator.run({ ...request("delegate", { prompt: "x" }), write: true }),
    ).rejects.toThrow(/not (re)?tried|failed over/i);
    expect(agy.runs).toHaveLength(1);
  });

  it("tries a model the caller pinned even while it is cooling down", async () => {
    const pro = "Gemini 3.1 Pro (High)";
    let quota = true;
    const agy = fakeAgy(() => {
      if (!quota) return { answer: "ok" };
      quota = false;
      return { log: `${LOG_429}\n`, answer: "", exitCode: 0 };
    });
    const { delegator } = makeDelegator({ spawn: agy.spawn });
    const pinned = { ...request("delegate", { prompt: "x" }), model: pro };
    await delegator.run(pinned).catch(() => {});
    expect(delegator.status().cooldowns.map((c) => c.model)).toContain(pro);
    const d = await delegator.run(pinned);
    expect(d.model).toBe(pro);
  });

  it("counts the tokens a failed attempt spent against the budget", async () => {
    let n = 0;
    const agy = fakeAgy(() =>
      n++ === 0
        ? { envelope: { status: "ERROR", error: "RESOURCE_EXHAUSTED (code 429)", totalTokens: 15 } }
        : { envelope: { response: "ok", totalTokens: 15 } },
    );
    const { delegator } = makeDelegator({ spawn: agy.spawn });
    await delegator.run(request("delegate", { prompt: "x" }));
    expect(delegator.status().spent).toBe(30);
  });

  it("does not gate a fan-out whose every leg names its model", async () => {
    const agy = fakeAgy({ answer: "ok" });
    const { delegator } = makeDelegator({ spawn: agy.spawn, cfg: { askModel: true } });
    const results = await delegator.runMany(
      request("delegate_many", { prompt: "p" }),
      [{ model: "Gemini 3.1 Pro (High)", label: "pro" }],
      { modelsChosen: true },
    );
    expect(results[0]!.delegation?.output).toBe("ok");
  });
});

describe("failure classification", () => {
  it("does not read a stray 429 or 401 as quota or auth", () => {
    expect(detectQuota("read 429 bytes from socket")).toBeNull();
    expect(detectQuota("E0613 handler.go:429] request ok")).toBeNull();
    expect(detectQuota(LOG_429)).not.toBeNull();
    expect(detectQuota("HTTP 429 Too Many Requests")).not.toBeNull();
    expect(classifyMessage("TypeError at foo.ts:401:3")).toBeUndefined();
  });

  it("classifies quota before auth when a message carries both words", () => {
    expect(classifyMessage("PERMISSION_DENIED: RESOURCE_EXHAUSTED")).toBe("quota");
  });

  it("does not treat a parser's unexpected EOF as a network blip worth repeating", () => {
    expect(classifyMessage("unexpected EOF parsing tool result")).not.toBe("network");
    expect(classifyMessage("read tcp 10.0.0.1:443: EOF")).toBe("network");
  });

  it("never cools a model down for zero seconds", () => {
    let now = 0;
    const reg = new CooldownRegistry(new MemoryCooldownStore(), () => now);
    reg.set("m", 0);
    now = 1000;
    expect(reg.cooling("m")).toBe(true);
  });
});

describe("persistent stores", () => {
  it("removes its temp file when the rename into place fails", () => {
    const dir = tmp("agy-store-");
    mkdirSync(path.join(dir, "cooldowns.json", "blocker"), { recursive: true });
    new FileCooldownStore(dir).save({ m: Date.now() + 60_000 }, Date.now());
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("tool handler responses", () => {
  it("does not tell the agent a caller-input error was a failed delegation", async () => {
    const { cfg, delegator } = makeDelegator({
      spawn: fakeAgy({ answer: "ok" }).spawn,
      cfg: { onFailure: "strict", allowedRoots: ["/repo"] },
    });
    const res = await createToolHandler(
      toolNamed("delegate"),
      cfg,
      delegator,
    )({
      prompt: "x",
      cwd: "/elsewhere",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/Do NOT perform this work yourself/);
  });

  it("flags a fan-out as an error when every leg timed out", async () => {
    const agy = fakeAgy({ neverExit: true, answer: "partial" });
    const { cfg, delegator } = makeDelegator({
      spawn: agy.spawn,
      cfg: { perToolTimeouts: { delegate_many: 1 } },
    });
    const res = await createToolHandler(
      toolNamed("delegate_many"),
      cfg,
      delegator,
    )({
      prompt: "p",
      models: ["Gemini 3.1 Pro (High)"],
    });
    expect(res.isError).toBe(true);
  }, 10_000);

  it("refuses to save a model choice it could not verify against agy's listing", async () => {
    const { cfg, delegator } = makeDelegator({
      listing: async () => {
        throw new Error("agy models failed");
      },
    });
    const res = await createToolHandler(
      toolNamed("set_model"),
      cfg,
      delegator,
    )({
      model: "Made Up Model",
    });
    expect(res.isError).toBe(true);
    expect(delegator.status().preference).toBeNull();
  });
});

describe("runner robustness", () => {
  it("returns the streamed text, not raw event JSON, when a streaming run times out", async () => {
    const firstStep = STREAM_NDJSON.split("\n").slice(0, 3).join("\n") + "\n";
    const agy = fakeAgy({ stdout: firstStep, neverExit: true });
    const r = await runAgy(
      { prompt: "q", cwd: "/repo", timeoutSec: 0.01, onProgress: () => {} },
      testConfig,
      fullCaps,
      { spawn: agy.spawn, timing: FAST_TIMING },
    );
    expect(r.timedOut).toBe(true);
    expect(r.output).toBe("OK");
  });

  it("survives a progress callback that throws", async () => {
    const agy = fakeAgy({ stdout: STREAM_NDJSON });
    const r = await runAgy(
      {
        prompt: "q",
        cwd: "/repo",
        timeoutSec: 60,
        onProgress: () => {
          throw new Error("client went away");
        },
      },
      testConfig,
      fullCaps,
      { spawn: agy.spawn, timing: FAST_TIMING },
    );
    expect(r.output).toBe("OK");
    expect(r.timedOut).toBe(false);
  });

  it("cancels the SIGKILL escalation once the killed child has exited", async () => {
    let exit: () => void = () => {};
    const kills: string[] = [];
    const exited = new Promise<void>((r) => (exit = r));
    const controller = new AbortController();
    const run = runAgy(
      { prompt: "q", cwd: "/repo", timeoutSec: 60, signal: controller.signal },
      testConfig,
      fullCaps,
      {
        spawn: () => ({
          stdout: () => envelopeJson({ response: "x" }),
          stderr: () => "",
          wait: async () => {
            await exited;
            return { code: 0 };
          },
          kill: (s) => {
            kills.push(s);
            if (s === "SIGTERM") exit();
          },
        }),
        timing: { pollMs: 5, graceMs: 20, killGraceMs: 30 },
      },
    ).catch(() => {});
    controller.abort();
    await run;
    await new Promise((r) => setTimeout(r, 100));
    expect(kills).toEqual(["SIGTERM"]);
  });
});

describe("concurrency", () => {
  it("lets a call cancelled while queued on its conversation leave at once", async () => {
    const mutex = new KeyedMutex();
    let release: () => void = () => {};
    const holder = mutex.run("c", () => new Promise<void>((r) => (release = r)));
    const controller = new AbortController();
    const waiter = mutex.run("c", async () => "ran", controller.signal).catch((e: Error) => e);
    controller.abort();
    const settled = await Promise.race([
      waiter,
      new Promise((r) => setTimeout(() => r("still waiting"), 200)),
    ]);
    expect(settled).toBeInstanceOf(Error);
    release();
    await holder;
  });
});

describe("resident sessions", () => {
  const cfg = { ...testConfig, warmSessions: true, warmMax: 2, warmIdleSec: 300 };
  function sessions() {
    const procs: { exit: () => void; emit: (s: string) => void; kills: string[] }[] = [];
    const spawnSession = (): SessionProcess => {
      const p = { exit: () => {}, emit: (_: string) => {}, kills: [] as string[] };
      procs.push(p);
      return {
        write: () => {},
        onData: (cb) => (p.emit = cb),
        onExit: (cb) => (p.exit = cb),
        kill: (s) => p.kills.push(s),
      };
    };
    return { procs, spawnSession };
  }

  it("does not let an old process's late exit forget its replacement", async () => {
    const s = sessions();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const controller = new AbortController();
    const first = warm.turn("conv", "/repo", "q", { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await first.catch(() => {});
    const second = warm.turn("conv", "/repo", "q2", { timeoutMs: 60_000 }).catch(() => {});
    s.procs[0]!.exit();
    expect(warm.stats().resident).toBe(1);
    warm.shutdown();
    expect(s.procs[1]!.kills).toContain("SIGKILL");
    await second;
  });

  it("reports an exit after the turn was sent as uncertain, not as safe to re-run", async () => {
    const s = sessions();
    const warm = new WarmSessions(cfg, fullCaps, { spawnSession: s.spawnSession });
    const turn = warm.turn("conv", "/repo", "q", { timeoutMs: 60_000 }).catch((e: Error) => e);
    s.procs[0]!.exit();
    expect(await turn).toBeInstanceOf(WarmTurnUncertain);
  });

  it("falls back cold when the resident process cannot even be spawned", async () => {
    const warm = new WarmSessions(cfg, fullCaps, {
      spawnSession: () => {
        throw new Error("spawn EINVAL");
      },
    });
    await expect(warm.turn("conv", "/repo", "q", { timeoutMs: 1000 })).rejects.toBeInstanceOf(
      WarmUnavailable,
    );
  });

  it("drains a chatty resident process's stderr so its turns cannot block", async () => {
    const dir = tmp("agy-warm-");
    const script = path.join(dir, "chatty-agy.mjs");
    writeFileSync(
      script,
      [
        "#!/usr/bin/env node",
        'import { writeSync } from "node:fs";',
        // Synchronous, like a Go binary: it blocks once nobody drains the pipe.
        'writeSync(2, "w".repeat(4 * 1024 * 1024));',
        'process.stdin.once("data", () => {',
        "  const usage = { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 };",
        '  process.stdout.write(JSON.stringify({ event: "result", result: { conversation_id: "conv", status: "SUCCESS", response: "pong", num_turns: 1, usage } }) + "\\n");',
        "});",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const warm = new WarmSessions({ ...cfg, agyPath: script }, fullCaps);
    try {
      const env = await warm.turn("conv", dir, "ping", { timeoutMs: 5_000 });
      expect(env.response).toBe("pong");
    } finally {
      warm.shutdown();
    }
  }, 15_000);
});

describe("bounded buffers and leftover logs", () => {
  it("keeps the tail of an over-long stream, where agy prints its envelope", () => {
    let buf = "";
    let dropped = 0;
    for (let i = 0; i < 50; i++) {
      const next = appendTail(buf, `chunk-${i};`, 40);
      buf = next.text;
      dropped += next.dropped;
    }
    buf = appendTail(buf, "ENVELOPE", 40).text;
    expect(buf.endsWith("ENVELOPE")).toBe(true);
    expect(buf.length).toBeLessThanOrEqual(50);
    expect(dropped).toBeGreaterThan(0);
  });

  it("removes run logs a dead bridge left behind, and only those", () => {
    const dir = tmp("agy-sweep-");
    // A pid that certainly belonged to a process that has exited: a fixed large
    // number can be live on a host with a high pid_max.
    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    const dead = path.join(dir, `claude-agy-mcp-${exited}-abc`);
    const mine = path.join(dir, `claude-agy-mcp-${process.pid}-def`);
    const other = path.join(dir, "unrelated-999999-x");
    for (const d of [dead, mine, other]) mkdirSync(d);
    writeFileSync(path.join(dead, "run.log"), "prompt text");
    sweepStaleLogs(dir);
    expect(readdirSync(dir).sort()).toEqual([path.basename(mine), path.basename(other)].sort());
  });
});
