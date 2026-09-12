import type { AgyEnvelope, AgyUsage } from "./envelope.js";
import { QUOTA_RE } from "./quota.js";

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

/**
 * The first matching pattern wins, so order is policy. Quota comes before auth
 * and network: "PERMISSION_DENIED: RESOURCE_EXHAUSTED" is an exhausted model
 * that should fail over, and a 429 that also mentions a reset connection must
 * not retry the exhausted one. Status codes count only beside a status word, so
 * a source location like "foo.ts:401:3" is not an auth failure. A bare EOF is a
 * network blip only where Go puts one, at the end of a read ("…:443: EOF"); a
 * parser's "unexpected EOF" is not worth repeating.
 */
const PATTERNS: [FailureKind, RegExp][] = [
  ["invalid_model", /invalid model selection|is not recognized as a known model/i],
  ["quota", QUOTA_RE],
  [
    "unauthenticated",
    /unauthenticated|not logged in|please (re-?)?login|invalid credentials|PERMISSION_DENIED|UNAUTHENTICATED|\b(?:code|status|HTTP)[\s:=]*401\b|\b401 Unauthorized\b|\bauth\w*\s+(has\s+)?expired|\btoken\s+(has\s+)?expired|re-authenticate/i,
  ],
  [
    "network",
    /dial tcp|no such host|connection refused|connection reset|network is unreachable|i\/o timeout|TLS handshake|:\s*EOF\s*$|ENOTFOUND|ECONNRESET|ETIMEDOUT/im,
  ],
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

/**
 * The call itself was unusable: a path outside the roots, a prompt agy cannot
 * receive, a working directory that does not exist. Nothing was delegated, so
 * this is the caller's to fix, not a delegation failure to escalate.
 */
export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

export class AgyFailure extends Error {
  /** Tokens the failed run still spent, when agy reported them. */
  usage?: AgyUsage;

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
