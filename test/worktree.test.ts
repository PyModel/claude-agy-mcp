import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotTree, treeChanged } from "../src/worktree.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agy-worktree-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("snapshotTree / treeChanged", () => {
  it("reports no change when nothing happened", async () => {
    await writeFile(path.join(dir, "a.txt"), "hello");
    const before = await snapshotTree(dir);
    const after = await snapshotTree(dir);
    expect(treeChanged(before, after)).toBe(false);
  });

  it("detects a file created after the snapshot", async () => {
    const before = await snapshotTree(dir);
    await writeFile(path.join(dir, "PROBE.txt"), "OK");
    expect(treeChanged(before, await snapshotTree(dir))).toBe(true);
  });

  it("detects an edit to an existing file", async () => {
    const f = path.join(dir, "a.txt");
    await writeFile(f, "one");
    const before = await snapshotTree(dir);
    await writeFile(f, "one and a bit more");
    expect(treeChanged(before, await snapshotTree(dir))).toBe(true);
  });

  it("detects a file created in a subdirectory", async () => {
    await mkdir(path.join(dir, "src"));
    const before = await snapshotTree(dir);
    await writeFile(path.join(dir, "src", "new.ts"), "x");
    expect(treeChanged(before, await snapshotTree(dir))).toBe(true);
  });

  it("reports unknown rather than 'unchanged' when a side could not be fingerprinted", () => {
    // "we did not look" must never be reported as "nothing happened".
    expect(treeChanged({ method: "none" }, { method: "scan", digest: "a" })).toBeUndefined();
    expect(treeChanged({ method: "scan", digest: "a" }, { method: "none" })).toBeUndefined();
  });

  it("ignores churn directories that no delegation is responsible for", async () => {
    await mkdir(path.join(dir, "node_modules"));
    const before = await snapshotTree(dir);
    await writeFile(path.join(dir, "node_modules", "junk"), "x");
    expect(treeChanged(before, await snapshotTree(dir))).toBe(false);
  });
});
