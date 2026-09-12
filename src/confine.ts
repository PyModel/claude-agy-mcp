import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Blocks agy, and every process it starts, from writing inside given roots.
 *
 * agy's plan mode is advisory, so a read-only run cannot be trusted to stay
 * read-only on agy's word. On macOS the kernel sandbox can make it so: agy runs
 * under `sandbox-exec` with a profile that allows everything except writes
 * beneath the workspace roots. agy's own state under the home directory stays
 * writable, so it still runs normally.
 *
 * The boundary is narrow on purpose. It covers direct writes by agy and its
 * descendants. A process agy asks launchd or another app to start runs outside
 * the sandbox, which is why the working-tree fingerprint stays on as a backstop.
 */
export interface Confinement {
  /** True when runs can actually be confined on this machine. */
  readonly available: boolean;
  /** Why confinement is unavailable, for the response header and agy_status. */
  readonly reason?: string;
  /** The command that runs `file args` with writes under `roots` denied. */
  wrap(file: string, args: string[], roots: string[]): { file: string; args: string[] };
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * The profile names the roots only by parameter. Paths go through `-D`, so a
 * root containing a quote or a parenthesis can never change the profile's text.
 */
export function sandboxProfile(count: number): string {
  const rules = Array.from(
    { length: count },
    (_, i) => `(deny file-write* (subpath (param "ROOT_${i}")))`,
  );
  return ["(version 1)", "(allow default)", ...rules].join("\n");
}

/**
 * A subpath rule matches the resolved path only: a rule on /tmp/x never fires
 * for a write that the kernel sees as /private/tmp/x. Every root is resolved
 * first, and both spellings are kept when they differ.
 */
export function confinedRoots(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    const abs = resolve(root);
    out.add(abs);
    try {
      out.add(realpathSync(abs));
    } catch {
      // A root that does not exist yet still gets its literal rule.
    }
  }
  return [...out];
}

export function sandboxConfinement(): Confinement {
  return {
    available: true,
    wrap(file, args, roots) {
      const resolved = confinedRoots(roots);
      if (!resolved.length) throw new Error("confinement needs at least one root");
      const defines = resolved.flatMap((root, i) => ["-D", `ROOT_${i}=${root}`]);
      return {
        file: SANDBOX_EXEC,
        args: [...defines, "-p", sandboxProfile(resolved.length), file, ...args],
      };
    },
  };
}

export function unavailableConfinement(reason: string): Confinement {
  return {
    available: false,
    reason,
    wrap() {
      throw new Error(`read-only confinement is unavailable: ${reason}`);
    },
  };
}

export type ProbeRun = (file: string, args: string[]) => Promise<void>;

const realRun: ProbeRun = (file, args) =>
  new Promise((ok, fail) => {
    execFile(file, args, { timeout: 10_000 }, (err) => (err ? fail(err) : ok()));
  });

/**
 * Proves confinement works here by running a trivial command under the real
 * profile. A bridge that is itself sandboxed cannot nest a second sandbox, and
 * sandbox-exec then fails at run time, so presence of the binary proves nothing.
 */
export async function probeConfinement(
  platform: NodeJS.Platform = process.platform,
  run: ProbeRun = realRun,
): Promise<Confinement> {
  if (platform !== "darwin") {
    return unavailableConfinement(`no write confinement is implemented for ${platform}`);
  }
  const probe = sandboxConfinement().wrap("/usr/bin/true", [], ["/nonexistent-agy-probe-root"]);
  try {
    await run(probe.file, probe.args);
    return sandboxConfinement();
  } catch (err) {
    return unavailableConfinement(`${SANDBOX_EXEC} failed its probe: ${(err as Error).message}`);
  }
}
