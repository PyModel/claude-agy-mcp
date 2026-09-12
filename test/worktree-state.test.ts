import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect, vi } from "vitest";

// agy's state directory is resolved from HOME when the module loads.
const home = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(require("node:path").join(tmpdir(), "home-"));
  process.env.HOME = dir;
  return dir;
});

const { snapshotTree, treeChanged } = await import("../src/worktree.js");

describe("snapshotTree and agy's state directory", () => {
  it("ignores agy writing its own state under a root, and still sees other writes", async () => {
    mkdirSync(join(home, ".gemini"));
    const before = await snapshotTree(home);
    writeFileSync(join(home, ".gemini", "state.db"), "x");
    expect(treeChanged(before, await snapshotTree(home))).toBe(false);
    writeFileSync(join(home, "notes.txt"), "x");
    expect(treeChanged(before, await snapshotTree(home))).toBe(true);
  });

  it("does not fingerprint a root inside agy's state, rather than always reporting a change", async () => {
    mkdirSync(join(home, ".gemini", "skills"), { recursive: true });
    const snap = await snapshotTree(join(home, ".gemini", "skills"));
    expect(snap.method).toBe("none");
    expect(snap.digest).toBeUndefined();
  });

  it("recognizes a relative spelling of a root inside agy's state", async () => {
    const snap = await snapshotTree(relative(process.cwd(), join(home, ".gemini", "skills")));
    expect(snap.method).toBe("none");
  });

  it("ignores agy's state tracked in a git repository at the root", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: home });
    git("init", "-q");
    writeFileSync(join(home, ".gemini", "tracked.json"), "1");
    git("add", "-A");
    git("commit", "-qm", "init");
    const before = await snapshotTree(home);
    expect(before.method).toBe("git");
    writeFileSync(join(home, ".gemini", "tracked.json"), "2");
    writeFileSync(join(home, ".gemini", "untracked.db"), "x");
    expect(treeChanged(before, await snapshotTree(home))).toBe(false);
    writeFileSync(join(home, "notes.txt"), "changed");
    expect(treeChanged(before, await snapshotTree(home))).toBe(true);
  });
});
