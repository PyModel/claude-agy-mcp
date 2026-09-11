import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Which agy flags this installation actually understands.
 *
 * agy ships flags and renames models frequently. Passing a flag an older build
 * does not know turns every delegation into an argument error, so the bridge
 * probes once at startup and sends only what is supported, degrading loudly
 * rather than failing.
 */
export interface Capabilities {
  version: string;
  flags: ReadonlySet<string>;
  /** e.g. `has("--output-format")`. */
  has(flag: string): boolean;
  /** Flags this bridge wanted but the installed agy lacks. */
  missing: string[];
}

/** Flags the bridge uses beyond the ones agy has always had. */
export const WANTED_FLAGS = [
  "--output-format",
  "--input-format",
  "--json-schema",
  "--mode",
  "--effort",
  "--disable-slash-commands",
  "--add-dir",
  "--conversation",
  "--print-timeout",
  "--log-file",
  "--sandbox",
  "--dangerously-skip-permissions",
] as const;

export function parseFlags(help: string): Set<string> {
  const flags = new Set<string>();
  for (const m of help.matchAll(/(^|\s)(--[a-z0-9-]+)/gi)) flags.add(m[2]!);
  return flags;
}

export function parseVersion(out: string): string {
  return out.trim().split("\n")[0]?.trim() ?? "unknown";
}

export type ProbeExec = (args: string[]) => Promise<string>;

const realExec =
  (agyPath: string): ProbeExec =>
  async (args) => {
    const promise = execFileAsync(agyPath, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
    promise.child.stdin?.end();
    // `--help` exits non-zero on some builds; the text is what matters.
    return promise.then(
      ({ stdout, stderr }) => stdout || stderr,
      (err: { stdout?: string; stderr?: string }) => err.stdout || err.stderr || "",
    );
  };

/** Assumes nothing beyond the flags agy has always had. */
export function degradedCapabilities(reason: string): Capabilities {
  const flags = new Set(["--print-timeout", "--log-file", "--add-dir", "--conversation"]);
  return {
    version: `unknown (${reason})`,
    flags,
    has: (f) => flags.has(f),
    missing: WANTED_FLAGS.filter((f) => !flags.has(f)),
  };
}

export async function probeCapabilities(
  agyPath: string,
  exec: ProbeExec = realExec(agyPath),
): Promise<Capabilities> {
  try {
    const [version, help] = await Promise.all([exec(["--version"]), exec(["--help"])]);
    const flags = parseFlags(help);
    if (flags.size === 0) return degradedCapabilities("agy --help produced no flags");
    return {
      version: parseVersion(version),
      flags,
      has: (f) => flags.has(f),
      missing: WANTED_FLAGS.filter((f) => !flags.has(f)),
    };
  } catch (err) {
    return degradedCapabilities((err as Error).message);
  }
}
