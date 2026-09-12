import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

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

/** Where agy keeps its own state. A root that contains it must not break agy. */
export const AGY_STATE_DIR = join(homedir(), ".gemini");

export interface ProfileShape {
  roots: number;
  ancestors: number;
  carveOuts: number;
}

/**
 * The profile names every path only by parameter. Paths go through `-D`, so a
 * root containing a quote or a parenthesis can never change the profile's text.
 *
 * Denying writes beneath a root is not enough on its own: renaming a directory
 * above the root moves the tree to a path no rule covers. So each ancestor is
 * also protected from being renamed or removed. Carve-outs come last because a
 * later rule wins, which keeps agy's own state writable when a root holds it.
 */
export function sandboxProfile(shape: ProfileShape): string {
  const rules = [
    ...Array.from(
      { length: shape.roots },
      (_, i) => `(deny file-write* (subpath (param "ROOT_${i}")))`,
    ),
    ...Array.from(
      { length: shape.ancestors },
      (_, i) => `(deny file-write-unlink (literal (param "ANCESTOR_${i}")))`,
    ),
    ...Array.from(
      { length: shape.carveOuts },
      (_, i) => `(allow file-write* (subpath (param "CARVE_${i}")))`,
    ),
  ];
  return ["(version 1)", "(allow default)", ...rules].join("\n");
}

/**
 * The kernel matches a rule against the resolved path, so a rule on /tmp/x never
 * fires for a write it sees as /private/tmp/x. A path that does not exist yet
 * resolves through its nearest existing ancestor.
 */
function resolvedSpelling(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) return abs;
    tail.unshift(basename(head));
    head = up;
  }
  try {
    return join(realpathSync(head), ...tail);
  } catch {
    return abs;
  }
}

/** Every root in both its given and its resolved spelling. */
export function confinedRoots(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    const abs = resolve(root);
    out.add(abs);
    out.add(resolvedSpelling(abs));
  }
  return [...out];
}

/** Every directory above any root, excluding the filesystem root itself. */
export function rootAncestors(roots: string[]): string[] {
  const out = new Set<string>();
  for (const root of roots) {
    for (let dir = dirname(root); dir !== dirname(dir); dir = dirname(dir)) out.add(dir);
  }
  return [...out];
}

const strictlyInside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
};

/** State directories that sit strictly inside a root, in every spelling. */
export function carveOuts(roots: string[], stateDirs: string[]): string[] {
  const out = new Set<string>();
  for (const dir of confinedRoots(stateDirs)) {
    if (roots.some((root) => strictlyInside(dir, root))) out.add(dir);
  }
  return [...out];
}

export function sandboxConfinement(stateDirs: string[] = [AGY_STATE_DIR]): Confinement {
  return {
    available: true,
    wrap(file, args, roots) {
      const resolved = confinedRoots(roots);
      if (!resolved.length) throw new Error("confinement needs at least one root");
      const ancestors = rootAncestors(resolved);
      const carved = carveOuts(resolved, stateDirs);
      const defines = [
        ...resolved.flatMap((p, i) => ["-D", `ROOT_${i}=${p}`]),
        ...ancestors.flatMap((p, i) => ["-D", `ANCESTOR_${i}=${p}`]),
        ...carved.flatMap((p, i) => ["-D", `CARVE_${i}=${p}`]),
      ];
      const profile = sandboxProfile({
        roots: resolved.length,
        ancestors: ancestors.length,
        carveOuts: carved.length,
      });
      return { file: SANDBOX_EXEC, args: [...defines, "-p", profile, file, ...args] };
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
 * Proves confinement works here: a trivial command must run under the real
 * profile, and a write into a confined root must be refused. A bridge that is
 * itself sandboxed cannot nest a second sandbox, so the binary's presence alone
 * proves nothing.
 */
export async function probeConfinement(
  platform: NodeJS.Platform = process.platform,
  run: ProbeRun = realRun,
): Promise<Confinement> {
  if (platform !== "darwin") {
    return unavailableConfinement(`no write confinement is implemented for ${platform}`);
  }
  const confinement = sandboxConfinement();
  const root = mkdtempSync(join(tmpdir(), "agy-confine-probe-"));
  const target = join(root, "probe");
  try {
    const ok = confinement.wrap("/usr/bin/true", [], [root]);
    await run(ok.file, ok.args);
    const write = confinement.wrap("/usr/bin/touch", [target], [root]);
    const wrote = await run(write.file, write.args).then(
      () => true,
      () => false,
    );
    if (wrote || existsSync(target)) {
      return unavailableConfinement(`${SANDBOX_EXEC} did not block a write in its probe`);
    }
    return confinement;
  } catch (err) {
    return unavailableConfinement(`${SANDBOX_EXEC} failed its probe: ${(err as Error).message}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
