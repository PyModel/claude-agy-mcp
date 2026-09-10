import path from "node:path";

/**
 * What may leave this machine and what may come back.
 *
 * The trust chain is file contents -> Gemini -> verbatim into the caller's
 * context window, so both ends need a gate: paths are checked before they are
 * handed to agy, and returned text is scrubbed before it is handed back.
 */

export class PathNotAllowedError extends Error {
  constructor(
    readonly offending: string,
    roots: string[],
  ) {
    super(
      `Path "${offending}" is outside the allowed roots.\n` +
        `Allowed: ${roots.join(", ")}\n` +
        `Set AGY_ALLOWED_ROOTS to change this.`,
    );
    this.name = "PathNotAllowedError";
  }
}

function within(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Throws unless every path sits under one of `roots`.
 * An empty `roots` means unrestricted — the default, so existing setups are unchanged.
 */
export function assertWithinRoots(paths: string[], roots: string[]): void {
  if (roots.length === 0) return;
  const resolvedRoots = roots.map((r) => path.resolve(r));
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!resolvedRoots.some((r) => within(resolved, r))) {
      throw new PathNotAllowedError(p, resolvedRoots);
    }
  }
}

/** Shapes that are secrets by construction, whatever their entropy. */
const KNOWN_SECRETS: [string, RegExp][] = [
  ["openai key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  [
    "private key block",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
];

/** `SOMETHING_SECRET=<value>` / `"api_key": "<value>"` with a long-enough value. */
const ASSIGNED_SECRET =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]*)(\s*[:=]\s*"?)([^\s"']{8,})/gi;

export interface Redaction {
  text: string;
  /** How many values were replaced. */
  count: number;
}

/**
 * Replaces credential-shaped strings with a marker.
 *
 * Deliberately shape-based rather than entropy-based: a 40-character hex string
 * is far more often a git SHA in a code review than a secret, and redacting
 * those would make the tool's own output useless.
 */
export function redact(text: string): Redaction {
  let count = 0;
  let out = text;
  for (const [label, re] of KNOWN_SECRETS) {
    out = out.replace(re, () => {
      count++;
      return `[redacted ${label}]`;
    });
  }
  out = out.replace(ASSIGNED_SECRET, (_m, name: string, sep: string) => {
    count++;
    return `${name}${sep}[redacted]`;
  });
  return { text: out, count };
}
