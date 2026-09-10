import { writeFileSync } from "node:fs";
import type { Capabilities } from "../src/capabilities.js";
import { WANTED_FLAGS } from "../src/capabilities.js";
import type { Config } from "../src/config.js";
import { Delegator } from "../src/delegation.js";
import { ModelRegistry } from "../src/models.js";
import { CooldownRegistry, MemoryCooldownStore } from "../src/quota.js";
import type { AgyProcess, SpawnAgy } from "../src/runner.js";
import type { SpawnSession } from "../src/warm.js";
import { TOOLS, type ToolDef } from "../src/tools.js";

export { LOG_429 } from "./fixtures.js";

/** An agy that understands every flag this bridge knows how to send. */
export const fullCaps: Capabilities = {
  version: "1.2.0",
  flags: new Set(WANTED_FLAGS),
  has: (f) => (WANTED_FLAGS as readonly string[]).includes(f),
  missing: [],
};

/** An older agy: only the flags that predate --output-format. */
export const oldCaps: Capabilities = (() => {
  const flags = new Set(["--print-timeout", "--log-file", "--add-dir", "--conversation"]);
  return {
    version: "1.0.0",
    flags,
    has: (f: string) => flags.has(f),
    missing: WANTED_FLAGS.filter((f) => !flags.has(f)),
  };
})();

export interface EnvelopeOptions {
  response?: string;
  status?: string;
  error?: string;
  conversationId?: string;
  denied?: { action: string; display_name: string }[];
  structuredOutput?: unknown;
  numTurns?: number;
  totalTokens?: number;
}

/** The JSON line agy prints under --output-format json. */
export function envelopeJson(opts: EnvelopeOptions = {}): string {
  return `${JSON.stringify({
    conversation_id: opts.conversationId ?? "sess-1",
    status: opts.status ?? "SUCCESS",
    response: opts.response ?? "",
    ...(opts.error ? { error: opts.error } : {}),
    duration_seconds: 1,
    num_turns: opts.numTurns ?? 1,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      thinking_tokens: 2,
      cache_read_tokens: 7,
      total_tokens: opts.totalTokens ?? 15,
    },
    ...(opts.denied ? { denied_actions: opts.denied } : {}),
    ...(opts.structuredOutput !== undefined ? { structured_output: opts.structuredOutput } : {}),
  })}\n`;
}

export interface FakeAgyOptions {
  /** Wrapped into a JSON envelope, the way agy answers under --output-format json. */
  answer?: string;
  /** Full control over the envelope agy prints. */
  envelope?: EnvelopeOptions;
  /** Raw stdout, bypassing the envelope entirely (text mode, or a crash). */
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  /** Never exits — pair with a deadline, an abort signal, or a quota log. */
  neverExit?: boolean;
  /** Exit only once this settles, so a test can hold a run open deterministically. */
  hold?: Promise<unknown>;
  /** Written to the --log-file path in argv before the run starts, exactly as agy would. */
  log?: string;
}

/** Choose behaviour per run from the argv the runner passes in. */
export type FakeAgyPlan = (args: string[]) => FakeAgyOptions;

export interface FakeAgy {
  spawn: SpawnAgy;
  /** argv of every run, in order. */
  runs: string[][];
  /** The env each run was given, in order. */
  envs: (Record<string, string> | undefined)[];
  kills: string[];
  modelOf(run: string[]): string | undefined;
}

/** The value agy was passed for `flag`, e.g. `valueOf(run, "--model")`. */
export function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/** Every value agy was passed for a repeatable flag, e.g. `--add-dir`. */
export function valuesOf(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag && args[i + 1] !== undefined) out.push(args[i + 1]!);
  });
  return out;
}

function stdoutFor(opts: FakeAgyOptions): string {
  if (opts.stdout !== undefined) return opts.stdout;
  if (opts.envelope) return envelopeJson(opts.envelope);
  if (opts.answer !== undefined) return envelopeJson({ response: opts.answer });
  return envelopeJson({ response: "" });
}

/**
 * A stand-in for the agy CLI. It only knows what the real one does: it reads its
 * argv, may write to its log file, prints to stdout, and exits.
 */
export function fakeAgy(plan: FakeAgyOptions | FakeAgyPlan = {}): FakeAgy {
  const runs: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const kills: string[] = [];

  const spawn: SpawnAgy = (_file, args, spawnOpts) => {
    runs.push(args);
    envs.push(spawnOpts.env);
    const opts = typeof plan === "function" ? plan(args) : plan;

    const logPath = valueOf(args, "--log-file");
    if (opts.log && logPath) writeFileSync(logPath, opts.log);

    const process: AgyProcess = {
      stdout: () => stdoutFor(opts),
      stderr: () => opts.stderr ?? "",
      wait: async () => {
        if (opts.neverExit) return new Promise<never>(() => {});
        if (opts.hold) await opts.hold;
        return { code: opts.exitCode ?? 0, error: opts.spawnError };
      },
      kill: (signal) => {
        kills.push(signal);
      },
    };
    return process;
  };

  return { spawn, runs, envs, kills, modelOf: (run) => valueOf(run, "--model") };
}

/** Timing that keeps runner tests in the tens of milliseconds. */
export const FAST_TIMING = { pollMs: 5, graceMs: 20, killGraceMs: 5 };

/** Baseline config for tests; override per case with `{ ...testConfig, ... }`. */
export const testConfig: Config = {
  agyPath: "agy",
  defaultTimeoutSec: 3600,
  perToolTimeouts: {},
  maxOutputChars: 50_000,
  defaultModel: undefined,
  defaultEffort: undefined,
  skipPermissions: true,
  sandbox: false,
  onFailure: "fallback",
  maxConcurrency: 2,
  budgetTokens: undefined,
  allowedRoots: [],
  redact: true,
  maxDelegationDepth: 1,
  warmSessions: false,
  warmMax: 2,
  warmIdleSec: 300,
};

/** The model listing tests resolve chains against, in agy's real tab-separated shape. */
export const LISTING =
  "Fetching available models...\n" +
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n" +
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n" +
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\n" +
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n" +
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)\n" +
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)\n" +
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n";

/** The tool definition under test, by name. */
export const toolNamed = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;

export interface DelegatorOptions {
  /** The fake agy to run; omit for a delegator that never spawns successfully. */
  spawn?: SpawnAgy;
  cfg?: Partial<Config>;
  caps?: Capabilities;
  /** Raw contents of the sessions cache file. */
  sessions?: string;
  /** Stands in for `agy models`; throw from here to test a degraded resolution. */
  listing?: () => Promise<string>;
  /** Resident-session processes, for the warm-session path. */
  spawnSession?: SpawnSession;
  /** The environment the delegator reads AGY_DELEGATION_DEPTH from. */
  env?: Record<string, string | undefined>;
  now?: () => number;
}

/** A Delegator wired to fakes, plus the config it was built with. */
export function makeDelegator(opts: DelegatorOptions = {}): { cfg: Config; delegator: Delegator } {
  const cfg: Config = { ...testConfig, ...opts.cfg };
  const delegator = new Delegator(
    cfg,
    new ModelRegistry(opts.listing ?? (async () => LISTING)),
    opts.caps ?? fullCaps,
    {
      spawn: opts.spawn,
      spawnSession: opts.spawnSession,
      timing: FAST_TIMING,
      readSessions: async () => opts.sessions ?? "{}",
      cooldowns: new CooldownRegistry(new MemoryCooldownStore(), opts.now),
    },
    opts.env ?? {},
  );
  return { cfg, delegator };
}
