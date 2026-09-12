import { execFile, spawn } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AGY_STATE_DIR, confinedRoots } from "./confine.js";

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
 *   and mtime of every ignored entry, ignored directories walked the same way.
 *   A dependency or build tree at the repository top (`node_modules`, `.venv`,
 *   `dist`…) counts as one entry, so a `.env` or `build/out.js` written in plan
 *   mode is seen while a rewrite deep inside `node_modules` is not.
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

/** agy's state, or anything beneath it: agy writes there on every run. */
const insideState = (full: string) =>
  confinedRoots([AGY_STATE_DIR]).some((dir) => full === dir || full.startsWith(dir + path.sep));

/** Never descended into anywhere: git's own store changes on every read. */
const ALWAYS_SKIP = new Set([".git"]);
/**
 * Dependency and cache trees skipped at the top of a scan only. Skipped at every
 * depth, a write into `pkg/dist` or `app/.venv` went unseen.
 */
const TOP_SKIP = new Set(["node_modules", ".venv", "venv", "__pycache__", ".next", "dist"]);

/** A scan wide enough to catch a real edit, bounded so a huge tree cannot stall a run. */
const MAX_ENTRIES = 20_000;
/**
 * Entries walked inside one ignored directory before it is hashed as truncated.
 * A build tree can hold a hundred thousand files; the first thousand in name
 * order still catch most writes, and the cut is by count only, so both
 * snapshots of an unchanged tree cut at the same place.
 */
const IGNORED_DIR_ENTRIES = 1_000;
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

/** Budget for one snapshot: entries seen, the cap on them, and the moment it must be done by. */
interface Budget {
  seen: number;
  max: number;
  deadline: number;
}

/** Why a walk stopped: past its entry cap, or past the snapshot's deadline. */
type Stop = "entries" | "deadline";

/** Charges one entry to the budget; the reason when either limit is crossed. */
function overBudget(budget: Budget): Stop | undefined {
  if (++budget.seen > budget.max) return "entries";
  if (Date.now() > budget.deadline) return "deadline";
  return undefined;
}

const describe = (stop: Stop): string =>
  stop === "entries" ? `more than ${MAX_ENTRIES} entries` : `scan exceeded ${DEADLINE_MS / 1000}s`;

/** Hashes one entry's identity and metadata; a vanished entry hashes as missing. */
async function hashMeta(hash: Hash, full: string): Promise<void> {
  hash.update(full).update("\0");
  try {
    // lstat: a symlink is hashed as a link, never followed, so a loop cannot
    // trap a walk and a link out of the tree cannot widen it.
    const st = await lstat(full);
    hash.update(`${st.mode}:${st.size}:${st.mtimeMs}`);
  } catch {
    hash.update("missing");
  }
  hash.update("\0");
}

/**
 * Hashes the metadata of every entry under `dir`, depth first, in name order.
 * Returns why it stopped short, or undefined when it covered the whole tree.
 * `top` applies the dependency-tree skips, which hold at the first level only.
 */
async function walk(
  hash: Hash,
  dir: string,
  budget: Budget,
  top: boolean,
): Promise<Stop | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined; // an unreadable directory is not evidence of a change
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (ALWAYS_SKIP.has(e.name) || (top && TOP_SKIP.has(e.name))) continue;
    const over = overBudget(budget);
    if (over) return over;
    const full = path.join(dir, e.name);
    // agy writes its own state on every run, and a confined run may, so a root
    // holding it would otherwise always look changed.
    if (insideState(full)) continue;
    await hashMeta(hash, full);
    if (e.isDirectory()) {
      const incomplete = await walk(hash, full, budget, false);
      if (incomplete) return incomplete;
    }
  }
  return undefined;
}

/**
 * Hashes the paths git lists but will not read for us: untracked directories
 * (a nested repository), ignored files, and ignored directories. A file is one
 * lstat. A directory is walked by metadata up to IGNORED_DIR_ENTRIES, then
 * hashed as truncated, except a dependency or build tree at the repository top
 * (`node_modules`, `.venv`, `dist`…), which counts as a single entry: its mtime
 * moves when a direct child comes or goes, and a rewrite deeper inside it is
 * the accepted blind spot.
 */
async function hashListed(
  hash: Hash,
  root: string,
  rels: string[],
  budget: Budget,
): Promise<Stop | undefined> {
  for (const rel of rels) {
    const over = overBudget(budget);
    if (over) return over;
    const full = path.join(root, rel);
    if (insideState(full.replace(/\/$/, ""))) continue;
    await hashMeta(hash, full);
    if (!rel.endsWith("/")) continue;
    if (TOP_SKIP.has(path.basename(full)) && path.dirname(full) === root) continue;
    const inner: Budget = { seen: 0, max: IGNORED_DIR_ENTRIES, deadline: budget.deadline };
    const stop = await walk(hash, full, inner, false);
    budget.seen += inner.seen;
    if (stop === "deadline") return stop;
    if (stop === "entries") hash.update("truncated\0");
  }
  return undefined;
}

/** Pathspecs leaving agy's state out of every git listing, when the repository holds it. */
function stateExclusion(root: string): string[] {
  for (const dir of confinedRoots([AGY_STATE_DIR])) {
    const rel = path.relative(root, dir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return ["--", ".", `:(exclude,top,literal)${rel}`];
    }
  }
  return [];
}

/** `git ls-files --others` with the given selectors, NUL-split. */
async function listOthers(root: string, selectors: string[]): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z", ...selectors],
    { cwd: root, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.split("\0").filter(Boolean);
}

/** Streams the contents of `files` through `git hash-object` into `hash`. */
function hashContents(root: string, files: string[], hash: Hash): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
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
}

async function gitSnapshot(cwd: string): Promise<TreeSnapshot | undefined> {
  try {
    const budget: Budget = { seen: 0, max: MAX_ENTRIES, deadline: Date.now() + DEADLINE_MS };
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
    const skip = stateExclusion(root);
    const diff = head
      ? ["diff", "HEAD", "--binary", "--no-ext-diff", "--no-color", ...skip]
      : ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", ...skip];
    if (!(await hashGit(root, diff, hash))) return undefined;
    hash.update("\0");
    const status = ["status", "--porcelain=v1", "-z", "--untracked-files=all", ...skip];
    if (!(await hashGit(root, status, hash))) {
      return undefined;
    }
    hash.update("\0");
    // Untracked files' contents: status names them, which misses a second edit.
    // `ls-files -o` hashed by `hash-object` covers what they now contain. A
    // nested repository is listed as a directory, and a name with a newline
    // cannot cross hash-object's line-based stdin; both go by metadata instead.
    const untracked = await listOthers(root, skip);
    const byMeta = untracked.filter((f) => f.endsWith("/") || f.includes("\n"));
    const byContent = untracked.filter((f) => !byMeta.includes(f));
    if (byContent.length > MAX_ENTRIES) return undefined;
    if (byContent.length && !(await hashContents(root, byContent, hash))) return undefined;
    hash.update("\0");
    if (await hashListed(hash, root, byMeta, budget)) return undefined;
    hash.update("\0");
    // Ignored entries: git never reads their contents, so a `.env` or a build
    // output written in plan mode would otherwise pass unnoticed. `--directory`
    // collapses a wholly ignored directory to one entry; hashListed decides
    // whether to walk it.
    const ignored = await listOthers(root, ["--ignored", "--directory", ...skip]);
    if (await hashListed(hash, root, ignored, budget)) return undefined;
    return { method: "git", digest: hash.digest("hex") };
  } catch {
    return undefined;
  }
}

async function scanSnapshot(cwd: string): Promise<TreeSnapshot> {
  const hash = createHash("sha256");
  const budget: Budget = { seen: 0, max: MAX_ENTRIES, deadline: Date.now() + DEADLINE_MS };
  const stop = await walk(hash, cwd, budget, true);
  if (stop) return { method: "none", reason: `${describe(stop)}; not fingerprinted` };
  return { method: "scan", digest: hash.digest("hex") };
}

/**
 * Fingerprints `cwd`. Git when the directory is inside a repository, because
 * it is ignore-aware and content-exact; a bounded metadata walk otherwise.
 */
export async function snapshotTree(given: string): Promise<TreeSnapshot> {
  // Resolved once, so insideState's absolute comparison holds for a relative cwd.
  const cwd = path.resolve(given);
  if (insideState(cwd)) {
    return { method: "none", reason: "inside agy's own state directory; not fingerprinted" };
  }
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
