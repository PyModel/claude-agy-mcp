import { describe, it, expect } from "vitest";
import { loadConfig, timeoutFor } from "../src/config.js";

describe("loadConfig", () => {
  it("returns defaults for empty env", () => {
    const c = loadConfig({});
    expect(c).toEqual({
      agyPath: "agy",
      defaultTimeoutSec: 3600,
      perToolTimeouts: {},
      maxOutputChars: 50_000,
      defaultModel: "gemini-flash@latest-high",
      defaultEffort: undefined,
      askModel: true,
      skipPermissions: true,
      sandbox: false,
      onFailure: "fallback",
      maxConcurrency: 2,
      budgetTokens: undefined,
      allowedRoots: [],
      redact: true,
      maxDelegationDepth: 1,
      warmSessions: true,
      warmMax: 2,
      warmIdleSec: 300,
    });
  });

  it("reads overrides from env", () => {
    const c = loadConfig({
      AGY_PATH: "/opt/agy",
      AGY_TIMEOUT: "300",
      AGY_MAX_RUNTIME: "900",
      AGY_MAX_OUTPUT_CHARS: "1000",
      AGY_DEFAULT_MODEL: "Gemini 3.1 Pro (High)",
      AGY_SKIP_PERMISSIONS: "false",
      AGY_SANDBOX: "true",
    });
    expect(c.agyPath).toBe("/opt/agy");
    expect(c.defaultTimeoutSec).toBe(300);
    expect(c.maxOutputChars).toBe(1000);
    expect(c.defaultModel).toBe("Gemini 3.1 Pro (High)");
    expect(c.skipPermissions).toBe(false);
    expect(c.sandbox).toBe(true);
  });

  it("falls back to defaults on non-numeric values", () => {
    const c = loadConfig({
      AGY_TIMEOUT: "abc",
      AGY_MAX_RUNTIME: "abc",
      AGY_MAX_OUTPUT_CHARS: "-5",
    });
    expect(c.defaultTimeoutSec).toBe(3600);
    expect(c.maxOutputChars).toBe(50_000);
  });

  it("falls back to the default ceiling for zero", () => {
    expect(loadConfig({ AGY_MAX_RUNTIME: "0" }).defaultTimeoutSec).toBe(3600);
  });

  it("uses the AGY_MAX_RUNTIME ceiling when AGY_TIMEOUT is unset", () => {
    expect(loadConfig({ AGY_MAX_RUNTIME: "900" }).defaultTimeoutSec).toBe(900);
  });

  it("parses per-tool AGY_TIMEOUT_<TOOL> overrides", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "300", AGY_TIMEOUT_DELEGATE: "900" });
    expect(c.perToolTimeouts).toEqual({ deep_search: 300, delegate: 900 });
  });

  it("ignores non-positive per-tool timeout values", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "abc", AGY_TIMEOUT_DELEGATE: "-5" });
    expect(c.perToolTimeouts).toEqual({});
  });

  it("prefers an explicit AGY_TIMEOUT over the ceiling", () => {
    expect(loadConfig({ AGY_TIMEOUT: "300", AGY_MAX_RUNTIME: "900" }).defaultTimeoutSec).toBe(300);
  });

  it("reads AGY_ON_FAILURE=strict", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "strict" }).onFailure).toBe("strict");
  });

  it("treats unknown AGY_ON_FAILURE values as fallback", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "explode" }).onFailure).toBe("fallback");
  });
});

describe("timeoutFor", () => {
  it("uses the default when the tool has no override", () => {
    expect(timeoutFor(loadConfig({}), "delegate")).toBe(3600);
  });

  it("prefers a per-tool override over an explicit AGY_TIMEOUT", () => {
    const c = loadConfig({ AGY_TIMEOUT: "900", AGY_TIMEOUT_DEEP_SEARCH: "300" });
    expect(timeoutFor(c, "deep_search")).toBe(300);
    expect(timeoutFor(c, "web_lookup")).toBe(900);
  });
});
