import { writeFileSync } from "node:fs";
import type { Config } from "../src/config.js";
import type { AgyProcess, SpawnAgy } from "../src/runner.js";

/** A real 429 line as agy writes it to its --log-file. */
export const LOG_429 =
  "E0613 log.go:398] agent executor error: RESOURCE_EXHAUSTED (code 429): " +
  "Individual quota reached. Resets in 4h24m.";

export interface FakeAgyOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  spawnError?: NodeJS.ErrnoException;
  /** Never exits — pair with a deadline, an abort signal, or a quota log. */
  neverExit?: boolean;
  /** Written to the --log-file path in argv before the run starts, exactly as agy would. */
  log?: string;
}

/** Choose behaviour per run from the argv the runner passes in. */
export type FakeAgyPlan = (args: string[]) => FakeAgyOptions;

export interface FakeAgy {
  spawn: SpawnAgy;
  /** argv of every run, in order. */
  runs: string[][];
  kills: string[];
  modelOf(run: string[]): string | undefined;
}

function valueOf(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * A stand-in for the agy CLI. It only knows what the real one does: it reads its
 * argv, may write to its log file, prints to stdout, and exits.
 */
export function fakeAgy(plan: FakeAgyOptions | FakeAgyPlan = {}): FakeAgy {
  const runs: string[][] = [];
  const kills: string[] = [];

  const spawn: SpawnAgy = (_file, args) => {
    runs.push(args);
    const opts = typeof plan === "function" ? plan(args) : plan;

    const logPath = valueOf(args, "--log-file");
    if (opts.log && logPath) writeFileSync(logPath, opts.log);

    const process: AgyProcess = {
      stdout: () => opts.stdout ?? "",
      stderr: () => opts.stderr ?? "",
      wait: () =>
        opts.neverExit
          ? new Promise(() => {})
          : Promise.resolve({ code: opts.exitCode ?? 0, error: opts.spawnError }),
      kill: (signal) => {
        kills.push(signal);
      },
    };
    return process;
  };

  return { spawn, runs, kills, modelOf: (run) => valueOf(run, "--model") };
}

/** Timing that keeps runner tests in the tens of milliseconds. */
export const FAST_TIMING = { pollMs: 5, graceMs: 20, killGraceMs: 5 };

/** Baseline config for tests; override per case with `{ ...testConfig, ... }`. */
export const testConfig: Config = {
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

/** The model listing tests resolve chains against. */
export const LISTING =
  "Gemini 3.7 Flash (Medium)\n" +
  "Gemini 3.7 Flash (High)\n" +
  "Gemini 3.5 Flash (High)\n" +
  "Gemini 3.1 Pro (High)\n";
