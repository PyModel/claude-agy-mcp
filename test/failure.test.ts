import { describe, it, expect } from "vitest";
import { parseEnvelope } from "../src/envelope.js";
import { classifyRun, classifyMessage, policyFor } from "../src/failure.js";
import { DENIED_ENVELOPE, ERROR_ENVELOPE, LOG_429, SUCCESS_ENVELOPE } from "./fixtures.js";

const run = (stdout: string, exitCode = 0, stderr = "") =>
  classifyRun({ envelope: parseEnvelope(stdout), exitCode, stderr });

describe("classifyRun", () => {
  it("returns null for a real answer", () => {
    expect(run(SUCCESS_ENVELOPE)).toBeNull();
  });

  it("treats a denied-but-answered run as a success, not a failure", () => {
    expect(run(DENIED_ENVELOPE)).toBeNull();
  });

  it("classifies a rejected model as invalid_model from the envelope's error", () => {
    expect(run(ERROR_ENVELOPE, 1)).toMatchObject({ kind: "invalid_model" });
  });

  it("names the empty SUCCESS case instead of blaming the print-timeout", () => {
    const empty = '{"status":"SUCCESS","response":"","num_turns":1}';
    const f = run(empty)!;
    expect(f.kind).toBe("empty");
    expect(f.message).not.toMatch(/print-timeout without a response/);
  });

  it("falls back to stderr when agy produced no envelope", () => {
    expect(run("", 1, "dial tcp: no such host")).toMatchObject({ kind: "network" });
    expect(run("", 1, "something odd")).toMatchObject({ kind: "agy_error" });
    expect(run("plain text answer", 0, "")).toBeNull();
  });
});

describe("classifyMessage", () => {
  it.each([
    ['invalid model selection (--model "X")', "invalid_model"],
    ["error: UNAUTHENTICATED: please login again", "unauthenticated"],
    ["Post https://…: dial tcp 1.2.3.4:443: i/o timeout", "network"],
    ["agent executor error: RESOURCE_EXHAUSTED (code 429)", "quota"],
  ])("classifies %s", (text, kind) => {
    expect(classifyMessage(text)).toBe(kind);
  });

  it("returns undefined when nothing matches", () => {
    expect(classifyMessage("the disk is on fire")).toBeUndefined();
  });
});

/**
 * Error envelopes captured verbatim from agy 1.2.2 on 2026-09-12. The classifier
 * matches agy's text, so these pin it to what agy really prints: an upgrade that
 * rewords an error fails here instead of silently changing the policy.
 */
describe("real agy 1.2.2 error envelopes", () => {
  const usage =
    '"duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,' +
    '"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}';
  const envelope = (error: string) =>
    `{"conversation_id":"","status":"ERROR","response":"","error":${JSON.stringify(error)},${usage}}`;

  it.each([
    [
      "an unknown --model",
      'invalid model selection (--model "Bogus Model 9" --effort ""): model Bogus Model 9 is not ' +
        "recognized as a known model or custom model in settings\nAvailable models:\n  Gemini 3.8 Flash (High)",
      "invalid_model",
    ],
    [
      "a refused connection",
      'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": ' +
        "proxyconnect tcp: dial tcp 127.0.0.1:9: connect: connection refused",
      "network",
    ],
    ["a machine with no login", "authentication failed or timed out", "unauthenticated"],
  ])("classifies %s", (_what, error, kind) => {
    expect(run(envelope(error), 1)).toMatchObject({ kind });
  });

  it("classifies the quota line agy writes to its log", () => {
    expect(classifyMessage(LOG_429)).toBe("quota");
  });
});

describe("policyFor", () => {
  it("fails over only for quota", () => {
    expect(policyFor("quota").failover).toBe(true);
    for (const kind of ["invalid_model", "unauthenticated", "network", "empty"] as const) {
      expect(policyFor(kind).failover).toBe(false);
    }
  });

  it("retries the same model once for a network blip", () => {
    expect(policyFor("network").retryOnce).toBe(true);
    expect(policyFor("quota").retryOnce).toBe(false);
  });
});
