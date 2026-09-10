import { describe, it, expect } from "vitest";
import { buildArgs, truncate, runAgy } from "../src/runner.js";
import { QuotaError } from "../src/quota.js";
import type { Config } from "../src/config.js";
import { fakeAgy, FAST_TIMING, LOG_429 } from "./support.js";

const cfg: Config = {
  agyPath: "agy",
  defaultTimeoutSec: 3600,
  perToolTimeouts: {},
  maxOutputChars: 100,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

describe("buildArgs", () => {
  it("passes the resolved runtime ceiling to agy", () => {
    expect(
      buildArgs(
        { prompt: "hi", cwd: "/repo", model: "Gemini 3.1 Pro (High)", timeoutSec: 3600 },
        cfg,
        "/tmp/run.log",
      ),
    ).toEqual([
      "--dangerously-skip-permissions",
      "--add-dir",
      "/repo",
      "--log-file",
      "/tmp/run.log",
      "--model",
      "Gemini 3.1 Pro (High)",
      "--print-timeout",
      "3600s",
      "-p",
      "hi",
    ]);
  });

  it("adds --conversation and --sandbox when set", () => {
    const args = buildArgs(
      { prompt: "q", cwd: "/repo", conversationId: "abc-123", timeoutSec: 600 },
      { ...cfg, sandbox: true, skipPermissions: false },
      "/tmp/run.log",
    );
    expect(args).toEqual([
      "--sandbox",
      "--add-dir",
      "/repo",
      "--log-file",
      "/tmp/run.log",
      "--conversation",
      "abc-123",
      "--print-timeout",
      "600s",
      "-p",
      "q",
    ]);
  });
});

describe("truncate", () => {
  it("passes short output through", () => {
    expect(truncate("short", 100)).toEqual({ text: "short", truncated: false });
  });
  it("cuts long output with a notice", () => {
    const r = truncate("x".repeat(150), 100);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("x".repeat(100));
    expect(r.text).toMatch(/truncated at 100.*150/s);
  });
});

describe("runAgy", () => {
  const run = (req: Parameters<typeof runAgy>[0], agy: ReturnType<typeof fakeAgy>) =>
    runAgy(req, cfg, { spawn: agy.spawn, timing: FAST_TIMING });

  it("returns the agy output", async () => {
    const agy = fakeAgy({ stdout: "answer\n" });
    expect((await run({ prompt: "q", cwd: "/repo", timeoutSec: 600 }, agy)).output).toBe("answer");
  });

  it("kills the child and throws QuotaError when the log shows a 429", async () => {
    const agy = fakeAgy({ neverExit: true, log: LOG_429 });
    await expect(
      run({ prompt: "q", cwd: "/repo", model: "Gemini 3.5 Flash (Medium)", timeoutSec: 600 }, agy),
    ).rejects.toThrow(QuotaError);
    expect(agy.kills).toContain("SIGTERM");
  });

  it("includes the reset time in the QuotaError", async () => {
    const agy = fakeAgy({ neverExit: true, log: LOG_429 });
    const err = (await run({ prompt: "q", cwd: "/repo", model: "M", timeoutSec: 600 }, agy).catch(
      (e) => e,
    )) as QuotaError;
    expect(err).toBeInstanceOf(QuotaError);
    expect(err.resetSeconds).toBe(4 * 3600 + 24 * 60);
  });

  it("resolves partial output when the hard deadline hits", async () => {
    const agy = fakeAgy({ neverExit: true, stdout: "partial answer\n" });
    const r = await run({ prompt: "q", cwd: "/repo", timeoutSec: 0.05 }, agy);
    expect(r.output).toBe("partial answer");
    expect(r.timedOut).toBe(true);
    expect(agy.kills).toContain("SIGTERM");
  });

  it("escalates to SIGKILL when the child survives SIGTERM", async () => {
    const agy = fakeAgy({ neverExit: true });
    const r = await run({ prompt: "q", cwd: "/repo", timeoutSec: 0.05 }, agy);
    expect(r.timedOut).toBe(true);
    await new Promise((r) => setTimeout(r, 25)); // killGraceMs is 5 in FAST_TIMING
    expect(agy.kills).toContain("SIGKILL");
  });

  it("kills the child and rejects when the abort signal fires", async () => {
    const agy = fakeAgy({ neverExit: true });
    const ac = new AbortController();
    const p = run({ prompt: "q", cwd: "/repo", timeoutSec: 600, signal: ac.signal }, agy);
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(agy.kills.length).toBeGreaterThan(0);
  });

  it("treats empty output with a quota log as QuotaError, not success", async () => {
    const agy = fakeAgy({ stdout: "", exitCode: 0, log: LOG_429 });
    await expect(
      run({ prompt: "q", cwd: "/repo", model: "M", timeoutSec: 600 }, agy),
    ).rejects.toThrow(QuotaError);
  });

  it("treats empty output with a clean log as an error, not success", async () => {
    const agy = fakeAgy({ stdout: "", exitCode: 0 });
    await expect(run({ prompt: "q", cwd: "/repo", timeoutSec: 600 }, agy)).rejects.toThrow(
      /empty output/i,
    );
  });

  it("throws install guidance on ENOENT", async () => {
    const e = new Error("spawn agy ENOENT") as NodeJS.ErrnoException;
    e.code = "ENOENT";
    const agy = fakeAgy({ spawnError: e, exitCode: null });
    await expect(run({ prompt: "q", cwd: "/repo", timeoutSec: 600 }, agy)).rejects.toThrow(
      /not found.*antigravity/is,
    );
  });

  it("surfaces stderr on non-zero exit", async () => {
    const agy = fakeAgy({ exitCode: 1, stderr: "auth expired" });
    await expect(run({ prompt: "q", cwd: "/repo", timeoutSec: 600 }, agy)).rejects.toThrow(
      /auth expired/,
    );
  });

  it("removes its run log when the run finishes", async () => {
    const agy = fakeAgy({ stdout: "answer" });
    await run({ prompt: "q", cwd: "/repo", timeoutSec: 600 }, agy);
    const logPath = agy.runs[0][agy.runs[0].indexOf("--log-file") + 1];
    expect(logPath).toMatch(/claude-agy-mcp-\d+-/);
    const { existsSync } = await import("node:fs");
    expect(existsSync(logPath)).toBe(false);
  });
});
