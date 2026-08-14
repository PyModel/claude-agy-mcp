import { describe, it, expect } from "vitest";
import {
  buildArgs,
  truncate,
  runAgy,
  execWithClosedStdin,
  type ChildHandle,
  type RunnerDeps,
} from "../src/runner.js";
import type { Config } from "../src/config.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxRuntimeSec: 3600,
  maxOutputChars: 100,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

interface FakeOpts {
  stdout?: string;
}

function fakeDeps(opts: FakeOpts = {}) {
  const removed: string[] = [];

  const child: ChildHandle = {
    stdout: () => opts.stdout ?? "",
    stderr: () => "",
    wait: () => Promise.resolve({ code: 0 }),
    kill: () => {},
  };

  const deps: RunnerDeps = {
    spawnChild: () => child,
    readLog: async () => "",
    removeLog: async (p) => {
      removed.push(p);
    },
    readSessionsFile: async () => JSON.stringify({ "/repo": "sess-42" }),
    makeLogPath: () => "/tmp/claude-agy-mcp-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, removed };
}

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

  it("falls back to cfg timeout; adds --conversation and --sandbox when set", () => {
    const args = buildArgs(
      { prompt: "q", cwd: "/repo", conversationId: "abc-123" },
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

describe("execWithClosedStdin", () => {
  it("closes child stdin so stdin-reading commands exit instead of hanging", async () => {
    const r = await execWithClosedStdin("cat", [], {
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 1024,
    });
    expect(r.stdout).toBe("");
  });
});

describe("runAgy", () => {
  it("returns output and session id, and removes the run log", async () => {
    const f = fakeDeps({ stdout: "answer\n" });
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps);
    expect(r.output).toBe("answer");
    expect(r.sessionId).toBe("sess-42");
    expect(f.removed).toEqual(["/tmp/claude-agy-mcp-test.log"]);
  });

  it("resolves a session id when agy stored the cwd key with a trailing slash", async () => {
    const f = fakeDeps({ stdout: "answer" });
    f.deps.readSessionsFile = async () => JSON.stringify({ "/tmp/proj/": "sess-slash" });
    const r = await runAgy({ prompt: "x", cwd: "/tmp/proj" }, cfg, f.deps);
    expect(r.sessionId).toBe("sess-slash");
  });

  it("omits session id when file unreadable", async () => {
    const f = fakeDeps({ stdout: "ok" });
    f.deps.readSessionsFile = async () => {
      throw new Error("no file");
    };
    const r = await runAgy({ prompt: "q", cwd: "/repo" }, cfg, f.deps);
    expect(r.sessionId).toBeUndefined();
  });
});
