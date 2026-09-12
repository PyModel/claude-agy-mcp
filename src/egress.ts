import { realpathSync } from "node:fs";
import path from "node:path";
import { InvalidRequestError } from "./failure.js";

/**
 * What may leave this machine and what may come back.
 *
 * The trust chain is file contents -> Gemini -> verbatim into the caller's
 * context window, so both ends need a gate: paths are checked before they are
 * handed to agy, and returned text is scrubbed before it is handed back.
 */

export class PathNotAllowedError extends InvalidRequestError {
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
  // `..foo` is a child with an odd name; only a `..` segment climbs out.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The path the operating system will actually reach, symlinks followed.
 *
 * `path.resolve` collapses `link/..` lexically, before any link is followed, so
 * `root/link/..` was judged to be `root` while the OS went to the link target's
 * parent. The existing part of the path is therefore resolved physically, by
 * `realpath(3)`, exactly as given; only a tail that does not exist yet — where
 * no link can be — is joined on lexically.
 */
export function canonical(p: string): string {
  const absolute = path.isAbsolute(p) ? p : `${process.cwd()}${path.sep}${p}`;
  const parts = absolute.split(path.sep);
  for (let cut = parts.length; cut > 0; cut--) {
    const head = parts.slice(0, cut).join(path.sep) || path.sep;
    try {
      return path.resolve(realpathSync.native(head), ...parts.slice(cut));
    } catch {
      // does not exist yet; try its parent
    }
  }
  return path.resolve(absolute);
}

/**
 * Throws unless every path sits under one of `roots`, symlinks followed.
 * An empty `roots` means unrestricted — the default, so existing setups are unchanged.
 */
export function assertWithinRoots(paths: string[], roots: string[]): void {
  if (roots.length === 0) return;
  const resolvedRoots = roots.map(canonical);
  for (const p of paths) {
    const resolved = canonical(p);
    if (!resolvedRoots.some((r) => within(resolved, r))) {
      throw new PathNotAllowedError(p, resolvedRoots);
    }
  }
}

/** Shapes that are secrets by construction, whatever their entropy. */
const KNOWN_SECRETS: [string, RegExp][] = [
  ["openai key", /\bsk-[A-Za-z0-9_-]{20,}\b/g],
  // Stripe and friends use an underscore, so the hyphenated `sk-` rule above
  // never matched them. Live keys are the ones worth catching.
  ["stripe key", /\b[srp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["github token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["gitlab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["aws access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["google api key", /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ["slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  [
    "private key block",
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  ],
];

/**
 * `scheme://user:secret@host`. Connection strings are how a database password
 * most often reaches a code review, and no shape rule above sees them because
 * the password itself is arbitrary text.
 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

/** `SOMETHING_SECRET=<value>` / `"api_key": "<value>"` with a long-enough value. */
/**
 * The identifier runs are bounded: unbounded `[A-Za-z0-9_]*` on both sides of
 * the keyword backtracks quadratically, and one long run of "TOKENTOKEN…" in a
 * model answer took minutes to scan.
 */
const ASSIGNED_SECRET =
  /\b([A-Za-z_][A-Za-z0-9_]{0,48}?(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Za-z0-9_]{0,48})(\s*[:=]\s*"?)([^\s"']{8,})/gi;

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
  out = out.replace(URL_CREDENTIALS, (_m, scheme: string, user: string) => {
    count++;
    return `${scheme}${user}:[redacted]@`;
  });
  out = out.replace(ASSIGNED_SECRET, (_m, name: string, sep: string) => {
    count++;
    return `${name}${sep}[redacted]`;
  });
  return { text: out, count };
}

/**
 * Redacts every string anywhere in a JSON-shaped value.
 *
 * `structuredContent` is model output too, and it is the one return path a
 * caller parses rather than reads, so leaving it unscrubbed put secrets
 * straight into machine-consumed fields.
 */
export function redactDeep(value: unknown): { value: unknown; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  const out = walk(value);
  return { value: out, count };
}
