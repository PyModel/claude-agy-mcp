import type { AgyEnvelope } from "./envelope.js";

/**
 * Why a run did not produce a usable answer. The kind decides policy: only
 * `quota` earns a failover to the next model in the chain, because only quota
 * is a property of the model rather than of the request or the machine.
 */
export type FailureKind =
  | "quota"
  | "invalid_model"
  | "unauthenticated"
  | "network"
  | "empty"
  | "agy_error"
  | "not_installed";

export interface FailurePolicy {
  /** Try the next model in the chain. */
  failover: boolean;
  /** Re-run the same model once before giving up. */
  retryOnce: boolean;
}

const POLICY: Record<FailureKind, FailurePolicy> = {
  quota: { failover: true, retryOnce: false },
  invalid_model: { failover: false, retryOnce: false },
  unauthenticated: { failover: false, retryOnce: false },
  network: { failover: false, retryOnce: true },
  empty: { failover: false, retryOnce: false },
  agy_error: { failover: false, retryOnce: false },
  not_installed: { failover: false, retryOnce: false },
};

export function policyFor(kind: FailureKind): FailurePolicy {
  return POLICY[kind];
}

const PATTERNS: [FailureKind, RegExp][] = [
  ["invalid_model", /invalid model selection|is not recognized as a known model/i],
  [
    "unauthenticated",
    /unauthenticated|not logged in|please (re-?)?login|invalid credentials|PERMISSION_DENIED|UNAUTHENTICATED|\b401\b|\bauth\w*\s+(has\s+)?expired|\btoken\s+(has\s+)?expired|re-authenticate/i,
  ],
  [
    "network",
    /dial tcp|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|TLS handshake|EOF\b|ENOTFOUND|ECONNRESET|ETIMEDOUT/i,
  ],
  ["quota", /RESOURCE_EXHAUSTED|\bcode 429\b|quota (exceeded|reached)/i],
];

/** The kind implied by a message, or undefined when nothing matches. */
export function classifyMessage(text: string): FailureKind | undefined {
  for (const [kind, re] of PATTERNS) if (re.test(text)) return kind;
  return undefined;
}

export interface ClassifyInput {
  envelope: AgyEnvelope | null;
  exitCode: number | null;
  stderr: string;
}

/**
 * The failure a finished run represents, or null when it produced a real answer.
 * A run with denied actions is *not* a failure — it answered, just with less
 * authority than it wanted; the caller is told about the denials separately.
 */
export function classifyRun(input: ClassifyInput): { kind: FailureKind; message: string } | null {
  const { envelope, exitCode, stderr } = input;

  if (envelope) {
    if (envelope.status !== "SUCCESS") {
      const text = envelope.error || envelope.response || `agy status ${envelope.status}`;
      return { kind: classifyMessage(text) ?? "agy_error", message: text.trim() };
    }
    if (!envelope.response.trim()) {
      return {
        kind: "empty",
        message:
          "agy reported SUCCESS with an empty response — the turn produced no answer " +
          "(usually its print-timeout elapsed mid-run).",
      };
    }
    return null;
  }

  // No envelope: agy is older than --output-format json, or died before printing one.
  const text = stderr.trim();
  if (exitCode !== 0) {
    return {
      kind: classifyMessage(text) ?? "agy_error",
      message: text || `agy exited with code ${exitCode}.`,
    };
  }
  return null;
}

export class AgyFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    /** The model that produced it, when one was pinned. */
    readonly model?: string,
  ) {
    super(message);
    this.name = "AgyFailure";
  }

  get policy(): FailurePolicy {
    return policyFor(this.kind);
  }
}
