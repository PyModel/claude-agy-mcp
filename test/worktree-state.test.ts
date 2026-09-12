import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
});
