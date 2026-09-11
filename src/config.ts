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

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function bool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  return raw !== "false" && raw !== "0";
}

function effort(raw: string | undefined): "low" | "medium" | "high" | undefined {
  return raw === "low" || raw === "medium" || raw === "high" ? raw : undefined;
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

function loadPerToolTimeouts(env: Record<string, string | undefined>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("AGY_TIMEOUT_")) continue;
    const tool = key.slice("AGY_TIMEOUT_".length).toLowerCase();
    if (!tool) continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out[tool] = n;
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
    defaultTimeoutSec: positiveInt(env.AGY_TIMEOUT, positiveInt(env.AGY_MAX_RUNTIME, 3600)),
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || "gemini-flash@latest-high",
    defaultEffort: effort(env.AGY_EFFORT),
    askModel: bool(env.AGY_ASK_MODEL, true),
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
    maxConcurrency: positiveInt(env.AGY_MAX_CONCURRENCY, 2),
    budgetTokens: optionalPositiveInt(env.AGY_BUDGET_TOKENS),
    allowedRoots: parseRoots(env.AGY_ALLOWED_ROOTS),
    redact: bool(env.AGY_REDACT, true),
    maxDelegationDepth: positiveInt(env.AGY_MAX_DELEGATION_DEPTH, 1),
    warmSessions: bool(env.AGY_WARM_SESSIONS, true),
    warmMax: positiveInt(env.AGY_WARM_MAX, 2),
    warmIdleSec: positiveInt(env.AGY_WARM_IDLE_SEC, 300),
  };
}
