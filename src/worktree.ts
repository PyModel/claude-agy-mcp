import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Evidence about whether a run changed the workspace.
 *
 * The bridge cannot stop a plan-mode run from writing: `--mode plan` is
 * advisory once `--dangerously-skip-permissions` is on, verified against agy
 * 1.2.1 and again against 1.2.2. What it can do is notice. A read-only tool
 * that returns `changed: true` did something it said it would not, and the
 * caller is told rather than left to assume.
 *
 * `changed: undefined` means the snapshot could not cover the tree, which is
 * reported as unknown rather than as proof of either outcome.
 */
export interface TreeSnapshot {
  /** Opaque digest of the tree's observable state, or undefined when uncovered. */
  digest?: string;
  /** How the snapshot was taken, for the message the caller sees. */
  method: "git" | "scan" | "none";
  /** Why coverage is incomplete, when it is. */
  reason?: string;
}

/** Files a scan never descends into: churn that no delegation is responsible for. */
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist"]);

/** A scan wide enough to catch a real edit, bounded so a huge tree cannot stall a run. */
const MAX_ENTRIES = 20_000;

async function gitSnapshot(cwd: string): Promise<TreeSnapshot | undefined> {
  try {
    // --porcelain covers tracked edits and untracked files; HEAD covers a commit
    // the run might have made. Together they describe everything a write can do.
    const [status, head] = await Promise.all([
      exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd,
        timeout: 10_000,
        maxBuffer: 16 * 1024 * 1024,
      }),
      exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 }).catch(() => ({ stdout: "" })),
    ]);
    return {
      method: "git",
      digest: createHash("sha256")
        .update(head.stdout)
        .update("\0")
        .update(status.stdout)
        .digest("hex"),
    };
  } catch {
    return undefined;
  }
}

async function scanSnapshot(cwd: string): Promise<TreeSnapshot> {
  const hash = createHash("sha256");
  let seen = 0;
  const walk = async (dir: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return true; // an unreadable directory is not evidence of a change
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!(await walk(full))) return false;
        continue;
      }
      if (++seen > MAX_ENTRIES) return false;
      try {
        const st = await stat(full);
        hash
          .update(full)
          .update("\0")
          .update(String(st.size))
          .update("\0")
          .update(String(st.mtimeMs));
      } catch {
        hash.update(full).update("\0missing");
      }
    }
    return true;
  };
  const complete = await walk(cwd);
  if (!complete) {
    return { method: "none", reason: `more than ${MAX_ENTRIES} files; not fingerprinted` };
  }
  return { method: "scan", digest: hash.digest("hex") };
}

/**
 * Fingerprints `cwd` cheaply. Git when the directory is a repository, because it
 * is both faster and ignore-aware; a bounded stat walk otherwise.
 */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot> {
  return (await gitSnapshot(cwd)) ?? (await scanSnapshot(cwd));
}

/**
 * Compares two snapshots of the same tree.
 *
 * Returns undefined when either side could not be fingerprinted: "we did not
 * look" must never be reported as "nothing happened".
 */
export function treeChanged(before: TreeSnapshot, after: TreeSnapshot): boolean | undefined {
  if (!before.digest || !after.digest) return undefined;
  return before.digest !== after.digest;
}
