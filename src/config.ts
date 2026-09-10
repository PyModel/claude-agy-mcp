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
  skipPermissions: boolean;
  sandbox: boolean;
  onFailure: "strict" | "fallback";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    agyPath: env.AGY_PATH || "agy",
    defaultTimeoutSec: positiveInt(env.AGY_TIMEOUT, positiveInt(env.AGY_MAX_RUNTIME, 3600)),
    perToolTimeouts: loadPerToolTimeouts(env),
    maxOutputChars: positiveInt(env.AGY_MAX_OUTPUT_CHARS, 50_000),
    defaultModel: env.AGY_DEFAULT_MODEL || "Gemini 3.7 Flash (High)",
    skipPermissions: env.AGY_SKIP_PERMISSIONS !== "false",
    sandbox: env.AGY_SANDBOX === "true",
    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",
  };
}
