import { execFile, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Evidence about whether a run changed the workspace.
 *
 * The bridge cannot stop a plan-mode run from writing: `--mode plan` is
 * advisory, verified against agy 1.2.1 and 1.2.2 with the permission bypass on
 * and against 1.2.2 with it off. What it can do is notice. A read-only tool
 * that returns `changed: true` did something it said it would not, and the
 * caller is told rather than left to assume.
 *
 * What the fingerprint covers, and what it cannot:
 * - In a git repository: HEAD, the content and mode of every tracked change
 *   (staged or not), the content of every untracked file, and the mode, size
 *   and mtime of every ignored entry, a wholly ignored directory counting as
 *   one entry. A `.env` written in plan mode is seen; a rewrite of one file
 *   deep inside `node_modules` is not.
 * - Elsewhere: path, type, size, mode and mtime of every entry, bounded in
 *   count and time.
 * - Anything else writing to the same tree during the run — an editor, a
 *   watcher, another delegation — moves the fingerprint too. A change means the
 *   tree changed while the run was live, not proof of who changed it.
 *
 * `changed: undefined` means the snapshot could not cover the tree, which is
 * reported as unknown rather than as proof of either outcome.
 */
export interface TreeSnapshot {
  /** Opaque digest of the tree's observable state, or undefined when uncovered. */
  digest?: string;
  /** How the snapshot was taken, for the message the caller sees. */
  method: "git" | "scan" | "none";
  /**
   * The method of every root, when several were combined. Two snapshots taken
   * by different methods have incomparable digests.
   */
  methods?: string;
  /** Why coverage is incomplete, when it is. */
  reason?: string;
}

/** Never descended into anywhere: git's own store changes on every read. */
const ALWAYS_SKIP = new Set([".git"]);
/**
 * Dependency and cache trees skipped at the top of a scan only. Skipped at every
 * depth, a write into `pkg/dist` or `app/.venv` went unseen.
 */
const TOP_SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", ".next", "dist"]);

/** A scan wide enough to catch a real edit, bounded so a huge tree cannot stall a run. */
const MAX_ENTRIES = 20_000;
/** The whole fingerprint's time budget; past it the tree is reported uncovered. */
const DEADLINE_MS = 10_000;
/** Git output is hashed as it streams, so a big diff costs time, never memory. */
const GIT_TIMEOUT_MS = DEADLINE_MS;

/** Streams `git <args>` into `hash`; resolves false on any failure or timeout. */
function hashGit(cwd: string, args: string[], hash: Hash): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => hash.update(d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 && signal === null);
    });
  });
}

async function gitSnapshot(cwd: string): Promise<TreeSnapshot | undefined> {
  try {
    const { stdout: top } = await exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    const root = top.trim();
    const hash = createHash("sha256");
    // No commits yet is a valid repository; it simply has no HEAD to hash.
    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: GIT_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => "");
    hash.update(head).update("\0");
    // Content and mode of every tracked change against HEAD, staged or not.
    // Before the first commit there is no HEAD, and the index diff stands in.
    const diff = head
      ? ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-color"]
      : ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color"];
    if (!(await hashGit(root, diff, hash))) return undefined;
    hash.update("\0");
    if (!(await hashGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], hash))) {
      return undefined;
    }
    hash.update("\0");
    // Untracked files' contents: status names them, which misses a second edit.
    // `ls-files -o` hashed by `hash-object` covers what they now contain.
    const { stdout: untracked } = await exec(
      "git",
      ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    const files = untracked.split("\0").filter(Boolean);
    if (files.length > MAX_ENTRIES) return undefined;
    if (files.length) {
      const objects = await new Promise<boolean>((resolve) => {
        const child = spawn("git", ["--no-optional-locks", "hash-object", "--stdin-paths"], {
          cwd: root,
          stdio: ["pipe", "pipe", "ignore"],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
        child.stdin.on("error", () => {});
        child.stdout.on("data", (d: Buffer) => hash.update(d));
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          // A file removed between listing and hashing fails the call; that is a
          // change in flight, and reporting it uncovered is the honest answer.
          resolve(code === 0 && signal === null);
        });
        child.stdin.end(`${files.join("\n")}\n`);
      });
      if (!objects) return undefined;
    }
    // Ignored entries by metadata: git never reads their contents, so a `.env`
    // or a build output written in plan mode would otherwise pass unnoticed.
    // `--directory` collapses a wholly ignored directory to one entry, so
    // node_modules is a single lstat whose mtime moves when a direct child is
    // added or removed; a rewrite deeper inside it is the accepted blind spot.
    const { stdout: ignored } = await exec(
      "git",
      [
        "--no-optional-locks",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
      ],
      { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
    );
    const entries = ignored.split("\0").filter(Boolean);
    if (entries.length > MAX_ENTRIES) return undefined;
    for (const rel of entries) {
      hash.update(rel).update("\0");
      try {
        const st = await lstat(path.join(root, rel));
        hash.update(`${st.mode}:${st.size}:${st.mtimeMs}`);
      } catch {
        hash.update("missing");
      }
      hash.update("\0");
    }
    return { method: "git", digest: hash.digest("hex") };
  } catch {
    return undefined;
  }
}

async function scanSnapshot(cwd: string): Promise<TreeSnapshot> {
  const hash = createHash("sha256");
  const deadline = Date.now() + DEADLINE_MS;
  let seen = 0;
  const walk = async (dir: string, top: boolean): Promise<string | undefined> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined; // an unreadable directory is not evidence of a change
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ALWAYS_SKIP.has(e.name) || (top && TOP_SKIP.has(e.name))) continue;
      if (++seen > MAX_ENTRIES) return `more than ${MAX_ENTRIES} entries`;
      if (Date.now() > deadline) return `scan exceeded ${DEADLINE_MS / 1000}s`;
      const full = path.join(dir, e.name);
      try {
        // lstat: a symlink is hashed as a link, never followed, so a loop
        // cannot trap the walk and a link out of the tree cannot widen it.
        const st = await lstat(full);
        hash.update(full).update("\0").update(`${st.mode}:${st.size}:${st.mtimeMs}`).update("\0");
      } catch {
        hash.update(full).update("\0missing\0");
        continue;
      }
      if (e.isDirectory()) {
        const incomplete = await walk(full, false);
        if (incomplete) return incomplete;
      }
    }
    return undefined;
  };
  const incomplete = await walk(cwd, true);
  if (incomplete) return { method: "none", reason: `${incomplete}; not fingerprinted` };
  return { method: "scan", digest: hash.digest("hex") };
}

/**
 * Fingerprints `cwd`. Git when the directory is inside a repository, because
 * it is ignore-aware and content-exact; a bounded metadata walk otherwise.
 */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot> {
  return (await gitSnapshot(cwd)) ?? (await scanSnapshot(cwd));
}

/**
 * One snapshot over several roots, so a write into any directory agy was given
 * is seen, not only a write into `cwd`. Uncovered if any root is.
 */
export function combineSnapshots(snaps: TreeSnapshot[]): TreeSnapshot {
  const uncovered = snaps.find((s) => !s.digest);
  if (uncovered) {
    return { method: "none", ...(uncovered.reason ? { reason: uncovered.reason } : {}) };
  }
  if (snaps.length === 1) return snaps[0]!;
  const hash = createHash("sha256");
  for (const s of snaps) hash.update(s.method).update(":").update(s.digest!).update("\0");
  return {
    method: snaps[0]!.method,
    methods: snaps.map((s) => s.method).join(","),
    digest: hash.digest("hex"),
  };
}

/**
 * Compares two snapshots of the same tree.
 *
 * Returns undefined when either side could not be fingerprinted, or when the
 * two were taken by different methods (git timed out on one side, say), whose
 * digests cannot be compared: "we could not tell" must never be reported as
 * either "nothing happened" or "something did".
 */
export function treeChanged(before: TreeSnapshot, after: TreeSnapshot): boolean | undefined {
  if (!before.digest || !after.digest) return undefined;
  if ((before.methods ?? before.method) !== (after.methods ?? after.method)) return undefined;
  return before.digest !== after.digest;
}
