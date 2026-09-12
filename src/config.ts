import path from "node:path";

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

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (unset(raw)) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(name, raw as string, "a positive integer");
  }
  return n;
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

function effort(raw: string | undefined): "low" | "medium" | "high" | undefined {
  if (unset(raw)) return undefined;
  if (raw === "low" || raw === "medium" || raw === "high") return raw;
  throw new ConfigError("AGY_EFFORT", raw as string, "one of low/medium/high");
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
  if (raw === "strict" || raw === "fallback") return raw;
  throw new ConfigError("AGY_ON_FAILURE", raw as string, "one of strict/fallback");
}

function loadPerToolTimeouts(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    if (unset(raw)) continue;
    out[tool] = positiveInt(key, raw, 0);
  }
  return out;
}

/** How long one tool's run may take. The whole precedence rule lives here. */
export function timeoutFor(cfg: Config, toolName: string): number {
  return cfg.perToolTimeouts[toolName] ?? cfg.defaultTimeoutSec;
}

/** The depth this server is running at, read from the env agy's parent set. */
export function delegationDepth(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AGY_DELEGATION_DEPTH);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    agyPath: env.AGY_PATH || "agy",
    defaultTimeoutSec: positiveInt(
      "AGY_TIMEOUT",
      env.AGY_TIMEOUT,
      positiveInt("AGY_MAX_RUNTIME", env.AGY_MAX_RUNTIME, 3600),
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
    warmIdleSec: positiveInt("AGY_WARM_IDLE_SEC", env.AGY_WARM_IDLE_SEC, 300),
  };
}
