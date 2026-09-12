import { describe, it, expect } from "vitest";
import { ConfigError, loadConfig, parseRoots, timeoutFor } from "../src/config.js";

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

  it("rejects non-numeric values instead of falling back to defaults", () => {
    expect(() => loadConfig({ AGY_TIMEOUT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_MAX_RUNTIME: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_MAX_OUTPUT_CHARS: "-5" })).toThrow(ConfigError);
  });

  it("names the offending variable and value in the error", () => {
    try {
      loadConfig({ AGY_MAX_CONCURRENCY: "lots" });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).variable).toBe("AGY_MAX_CONCURRENCY");
      expect((e as ConfigError).value).toBe("lots");
      expect((e as Error).message).toContain("positive integer");
    }
  });

  it("treats unset and empty alike, so an exported-but-blank var keeps the default", () => {
    expect(loadConfig({ AGY_TIMEOUT: "", AGY_SKIP_PERMISSIONS: "" }).defaultTimeoutSec).toBe(3600);
    expect(loadConfig({ AGY_SKIP_PERMISSIONS: "" }).skipPermissions).toBe(true);
  });

  it("rejects a zero ceiling instead of silently using the default", () => {
    expect(() => loadConfig({ AGY_MAX_RUNTIME: "0" })).toThrow(ConfigError);
  });

  it("uses the AGY_MAX_RUNTIME ceiling when AGY_TIMEOUT is unset", () => {
    expect(loadConfig({ AGY_MAX_RUNTIME: "900" }).defaultTimeoutSec).toBe(900);
  });

  it("parses per-tool AGY_TIMEOUT_<TOOL> overrides", () => {
    const c = loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "300", AGY_TIMEOUT_DELEGATE: "900" });
    expect(c.perToolTimeouts).toEqual({ deep_search: 300, delegate: 900 });
  });

  it("rejects a non-positive per-tool timeout instead of dropping it", () => {
    expect(() => loadConfig({ AGY_TIMEOUT_DEEP_SEARCH: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_TIMEOUT_DELEGATE: "-5" })).toThrow(ConfigError);
  });

  it("still ignores a per-tool timeout that is set but empty", () => {
    expect(loadConfig({ AGY_TIMEOUT_DELEGATE: "" }).perToolTimeouts).toEqual({});
  });

  it("prefers an explicit AGY_TIMEOUT over the ceiling", () => {
    expect(loadConfig({ AGY_TIMEOUT: "300", AGY_MAX_RUNTIME: "900" }).defaultTimeoutSec).toBe(300);
  });

  it("reads AGY_ON_FAILURE=strict", () => {
    expect(loadConfig({ AGY_ON_FAILURE: "strict" }).onFailure).toBe("strict");
  });

  it("rejects an unknown AGY_ON_FAILURE instead of treating it as fallback", () => {
    expect(() => loadConfig({ AGY_ON_FAILURE: "explode" })).toThrow(ConfigError);
  });

  // SEC-C1. These two settings used to bypass the shared boolean parser:
  // skipPermissions was `!== "false"` and sandbox was `=== "true"`, so an
  // operator hardening the server with the numeric spelling got the opposite of
  // what they asked for, silently.
  it("honours every accepted spelling of AGY_SKIP_PERMISSIONS", () => {
    for (const off of ["false", "0", "no", "off", "FALSE", " Off "]) {
      expect(loadConfig({ AGY_SKIP_PERMISSIONS: off }).skipPermissions, off).toBe(false);
    }
    for (const on of ["true", "1", "yes", "on"]) {
      expect(loadConfig({ AGY_SKIP_PERMISSIONS: on }).skipPermissions, on).toBe(true);
    }
    expect(loadConfig({}).skipPermissions).toBe(true);
  });

  it("honours every accepted spelling of AGY_SANDBOX", () => {
    for (const on of ["true", "1", "yes", "on"]) {
      expect(loadConfig({ AGY_SANDBOX: on }).sandbox, on).toBe(true);
    }
    expect(loadConfig({ AGY_SANDBOX: "0" }).sandbox).toBe(false);
    expect(loadConfig({}).sandbox).toBe(false);
  });

  it("refuses to start on an unparseable security setting rather than guessing", () => {
    expect(() => loadConfig({ AGY_SKIP_PERMISSIONS: "nope" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_SANDBOX: "maybe" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_REDACT: "sometimes" })).toThrow(ConfigError);
    expect(() => loadConfig({ AGY_EFFORT: "extreme" })).toThrow(ConfigError);
  });
});

describe("parseRoots", () => {
  it("splits on the platform delimiter or commas, so Windows drive letters survive", () => {
    expect(parseRoots("/a:/b, /c", ":")).toEqual(["/a", "/b", "/c"]);
    expect(parseRoots("C:\\repo;D:\\other", ";")).toEqual(["C:\\repo", "D:\\other"]);
    expect(parseRoots(undefined)).toEqual([]);
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
