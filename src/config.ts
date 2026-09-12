import path from "node:path";
import { TOOLS_BY_NAME } from "./tools.js";

export interface Config {
  agyPath: string;
  /**
   * Timeout for a tool with no AGY_TIMEOUT_<TOOL> override: AGY_TIMEOUT when it
   * is set, otherwise the AGY_MAX_RUNTIME resource ceiling.
   */
  defaultTimeoutSec: number;
  /**
   * Per-tool timeout overrides from AGY_TIMEOUT_<TOOL_NAME> env vars
   * (e.g. AGY_TIMEOUT_DEEP_SEARCH), keyed by lowercased tool name.
   */
  perToolTimeouts: Record<string, number>;
  maxOutputChars: number;
  defaultModel: string | undefined;
  /** Reasoning tier applied when a tool does not ask for one. */
  defaultEffort: "low" | "medium" | "high" | undefined;
  /**
   * Refuse to delegate until the user has chosen a model and tier through
   * `set_model`. The choice is stored per machine, so this asks once.
   */
  askModel: boolean;
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
  /** Most agy processes this server will have running at once. */
  maxConcurrency: number;
  /** Hard stop once this many tokens have been spent since startup. */
  budgetTokens: number | undefined;
  /** Absolute roots that `cwd`, `dirs` and `files` may not escape. Empty = unrestricted. */
  allowedRoots: string[];
  /** Scrub credential-shaped strings out of returned text. */
  redact: boolean;
  /** Refuse to delegate once this many nested delegations deep. */
  maxDelegationDepth: number;
  /** Keep an agy process resident per conversation so follow-ups skip the cold start. */
  warmSessions: boolean;
  warmMax: number;
  warmIdleSec: number;
}

/**
 * A setting was present but unusable.
 *
 * Every parser below throws this rather than falling back. A silent fallback is
 * how `AGY_SKIP_PERMISSIONS=0` used to mean "skip permissions": the operator
 * spelled a hardening setting a way the parser did not accept, and the server
 * started anyway with the setting they were trying to turn off. A typo in a
 * security control has to stop the process, not pick a default for it.
 */
export class ConfigError extends Error {
  constructor(
    readonly variable: string,
    readonly value: string,
    expected: string,
  ) {
    super(`${variable}="${value}" is not valid. Expected ${expected}.`);
    this.name = "ConfigError";
  }
}

/** Unset and empty both mean "not configured"; everything else must parse. */
function unset(raw: string | undefined): boolean {
  return raw === undefined || raw === "";
}

/**
 * The longest runtime any timer here may be given. Node clamps a delay above
 * 2^31-1 ms (about 24.8 days) to 1 ms, so an over-large timeout did not mean
 * "effectively forever": it killed every run the instant it started.
 */
export const MAX_DURATION_SEC = 7 * 24 * 3600;

/** Plain decimal digits only: `Number()` also accepts "1e3", "0x10" and " 5 ". */
const DECIMAL = /^[0-9]+$/;

function positiveInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (unset(raw)) return fallback;
  const n = DECIMAL.test(raw as string) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(name, raw as string, "a positive integer");
  }
  if (n > max)
    throw new ConfigError(name, raw as string, `a positive integer no larger than ${max}`);
  return n;
}

/** A duration in seconds that every timer in the bridge can actually honour. */
function durationSec(name: string, raw: string | undefined, fallback: number): number {
  return positiveInt(name, raw, fallback, MAX_DURATION_SEC);
}

function optionalPositiveInt(name: string, raw: string | undefined): number | undefined {
  if (unset(raw)) return undefined;
  return positiveInt(name, raw, 0);
}

const TRUE = new Set(["true", "1", "yes", "on"]);
const FALSE = new Set(["false", "0", "no", "off"]);

function bool(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (unset(raw)) return fallback;
  const v = (raw as string).trim().toLowerCase();
  if (TRUE.has(v)) return true;
  if (FALSE.has(v)) return false;
  throw new ConfigError(name, raw as string, "one of true/false/1/0/yes/no/on/off");
}

/** Enum settings are read the way booleans are: trimmed and case-insensitive. */
function oneOf<T extends string>(name: string, raw: string, allowed: readonly T[]): T {
  const v = raw.trim().toLowerCase();
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new ConfigError(name, raw, `one of ${allowed.join("/")}`);
  return hit;
}

function effort(raw: string | undefined): "low" | "medium" | "high" | undefined {
  if (unset(raw)) return undefined;
  return oneOf("AGY_EFFORT", raw as string, ["low", "medium", "high"] as const);
}

/**
 * Roots are separated by the platform path delimiter (":" on POSIX, ";" on
 * Windows, where ":" is part of every absolute path), or by commas.
 */
export function parseRoots(raw: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!raw) return [];
  return raw
    .split(new RegExp(`[${delimiter},]`))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function onFailure(raw: string | undefined): "strict" | "fallback" {
  if (unset(raw)) return "fallback";
  return oneOf("AGY_ON_FAILURE", raw as string, ["strict", "fallback"] as const);
}

/**
 * A per-tool override must name a real tool. `AGY_TIMEOUT_DEEPSEARCH` used to be
 * accepted and silently never applied, so the operator believed a limit was in
 * force that was not.
 */
function loadPerToolTimeouts(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    if (unset(raw)) continue;
    if (!TOOLS_BY_NAME.has(tool)) {
      throw new ConfigError(
        key,
        raw as string,
        `AGY_TIMEOUT_<TOOL> for a tool this server has (${[...TOOLS_BY_NAME.keys()].join(", ")})`,
      );
    }
    out[tool] = durationSec(key, raw, 0);
  }
  return out;
}

/** How long one tool's run may take. The whole precedence rule lives here. */
export function timeoutFor(cfg: Config, toolName: string): number {
  return cfg.perToolTimeouts[toolName] ?? cfg.defaultTimeoutSec;
}

/**
 * The depth this server is running at, read from the env agy's parent set.
 *
 * Unset means top level. Anything else must parse: reading garbage as zero
 * switched the recursion guard off, which is the one direction it must not fail.
 */
export function delegationDepth(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AGY_DELEGATION_DEPTH;
  if (unset(raw)) return 0;
  if (!DECIMAL.test(raw as string)) {
    throw new ConfigError("AGY_DELEGATION_DEPTH", raw as string, "a non-negative integer");
  }
  return Number(raw);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    agyPath: env.AGY_PATH || "agy",
    defaultTimeoutSec: durationSec(
      "AGY_TIMEOUT",
      env.AGY_TIMEOUT,
      durationSec("AGY_MAX_RUNTIME", env.AGY_MAX_RUNTIME, 3600),
    ),
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt("AGY_MAX_OUTPUT_CHARS", env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || "gemini-flash@latest-high",
    defaultEffort: effort(env.AGY_EFFORT),
    askModel: bool("AGY_ASK_MODEL", env.AGY_ASK_MODEL, true),
    skipPermissions: bool("AGY_SKIP_PERMISSIONS", env.AGY_SKIP_PERMISSIONS, true),
    sandbox: bool("AGY_SANDBOX", env.AGY_SANDBOX, false),
    onFailure: onFailure(env.AGY_ON_FAILURE),
    maxConcurrency: positiveInt("AGY_MAX_CONCURRENCY", env.AGY_MAX_CONCURRENCY, 2),
    budgetTokens: optionalPositiveInt("AGY_BUDGET_TOKENS", env.AGY_BUDGET_TOKENS),
    allowedRoots: parseRoots(env.AGY_ALLOWED_ROOTS),
    redact: bool("AGY_REDACT", env.AGY_REDACT, true),
    maxDelegationDepth: positiveInt("AGY_MAX_DELEGATION_DEPTH", env.AGY_MAX_DELEGATION_DEPTH, 1),
    warmSessions: bool("AGY_WARM_SESSIONS", env.AGY_WARM_SESSIONS, true),
    warmMax: positiveInt("AGY_WARM_MAX", env.AGY_WARM_MAX, 2),
    warmIdleSec: durationSec("AGY_WARM_IDLE_SEC", env.AGY_WARM_IDLE_SEC, 300),
  };
}
