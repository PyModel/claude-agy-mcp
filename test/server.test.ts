import { describe, it, expect } from "vitest";
import { createToolHandler } from "../src/server.js";
import { ModelRegistry } from "../src/models.js";
import { TOOLS } from "../src/tools.js";
import { CooldownRegistry } from "../src/quota.js";
import type { Config } from "../src/config.js";
import type { ChildHandle, RunnerDeps } from "../src/runner.js";

const cfg: Config = {
  agyPath: "agy",
  timeoutSec: 600,
  timeoutExplicit: false,
  perToolTimeouts: {},
  maxRuntimeSec: 3600,
  maxOutputChars: 50_000,
  defaultModel: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
};

const LISTING =
  "Gemini 3.6 Flash (Medium)\n" +
  "Gemini 3.6 Flash (High)\n" +
  "Gemini 3.5 Flash (High)\n" +
  "Gemini 3.1 Pro (High)\n";

interface Run {
  args: string[];
}

/**
 * Fake runner deps: records every spawn's args and answers with canned output.
 */
function fakeDeps() {
  const runs: Run[] = [];

  const deps: RunnerDeps = {
    spawnChild: (_file, args) => {
      runs.push({ args });
      const child: ChildHandle = {
        stdout: () => "the answer",
        stderr: () => "",
        wait: () => Promise.resolve({ code: 0 }),
        kill: () => {},
      };
      return child;
    },
    readLog: async () => "",
    removeLog: async () => {},
    readSessionsFile: async () => JSON.stringify({ [process.cwd()]: "sess-1" }),
    makeLogPath: () => "/tmp/claude-agy-mcp-test.log",
    pollMs: 5,
    graceMs: 20,
    killGraceMs: 5,
  };

  return { deps, runs };
}

function handlerFor(
  name: string,
  f: ReturnType<typeof fakeDeps>,
  overrides: Partial<Config> = {},
  cooldowns = new CooldownRegistry(),
) {
  return createToolHandler(
    TOOLS.find((t) => t.name === name)!,
    { ...cfg, ...overrides },
    new ModelRegistry(async () => LISTING),
    f.deps,
    cooldowns,
  );
}

describe("createToolHandler", () => {
  it("runs delegate and appends model + session footer", async () => {
    const f = fakeDeps();
    const res = await handlerFor("delegate", f)({ prompt: "do x" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain("the answer");
    expect(text).toContain("Gemini 3.6 Flash (High)");
    expect(text).toContain("sess-1");
    expect(f.runs[0].args).toContain("--model");
  });

  it("follow_up passes --conversation and no --model", async () => {
    const f = fakeDeps();
    await handlerFor("follow_up", f)({ session_id: "abc", question: "more?" });
    expect(f.runs[0].args).toContain("--conversation");
    expect(f.runs[0].args).toContain("abc");
    expect(f.runs[0].args).not.toContain("--model");
  });

  it("uses the runtime ceiling for every tool", async () => {
    const f = fakeDeps();
    await handlerFor("delegate", f)({ prompt: "do x" });
    await handlerFor("web_lookup", f)({ query: "docs" });
    const delegateArgs = f.runs[0].args;
    const webLookupArgs = f.runs[1].args;
    expect(delegateArgs[delegateArgs.indexOf("--print-timeout") + 1]).toBe("3600s");
    expect(webLookupArgs[webLookupArgs.indexOf("--print-timeout") + 1]).toBe("3600s");
  });

  it("explicit AGY_TIMEOUT overrides per-tool timeouts", async () => {
    const f = fakeDeps();
    await handlerFor("web_lookup", f, { timeoutSec: 900, timeoutExplicit: true })({ query: "q" });
    const args = f.runs[0].args;
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("900s");
  });

  it("AGY_TIMEOUT_DELEGATE overrides only delegate", async () => {
    const f = fakeDeps();
    const cfg = { perToolTimeouts: { delegate: 300 } };
    await handlerFor("delegate", f, cfg)({ prompt: "q" });
    const delegateArgs = f.runs[0].args;
    expect(delegateArgs[delegateArgs.indexOf("--print-timeout") + 1]).toBe("300s");
    // a tool without an override keeps its default
    await handlerFor("web_lookup", f, cfg)({ query: "q" });
    const webLookupArgs = f.runs[1].args;
    expect(webLookupArgs[webLookupArgs.indexOf("--print-timeout") + 1]).toBe("3600s");
  });

  it("per-tool override wins over explicit global AGY_TIMEOUT", async () => {
    const f = fakeDeps();
    const cfg = { timeoutSec: 900, timeoutExplicit: true, perToolTimeouts: { deep_search: 300 } };
    await handlerFor("deep_search", f, cfg)({ query: "q" });
    expect(f.runs[0].args[f.runs[0].args.indexOf("--print-timeout") + 1]).toBe("300s");
  });
});
