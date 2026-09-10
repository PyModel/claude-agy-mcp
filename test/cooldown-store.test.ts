import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheDir, FileCooldownStore } from "../src/cooldown-store.js";
import { CooldownRegistry } from "../src/quota.js";

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "cooldowns-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("cacheDir", () => {
  it("honours XDG_CACHE_HOME, falling back to ~/.cache", () => {
    expect(cacheDir({ XDG_CACHE_HOME: "/x" })).toBe("/x/claude-agy-mcp");
    expect(cacheDir({})).toMatch(/\.cache\/claude-agy-mcp$/);
  });
});

describe("FileCooldownStore", () => {
  it("reads back what another process wrote", () => {
    const { dir, cleanup } = scratch();
    try {
      new FileCooldownStore(dir).save({ Flash: 123 });
      expect(new FileCooldownStore(dir).load()).toEqual({ Flash: 123 });
    } finally {
      cleanup();
    }
  });

  it("leaves no temp file behind", () => {
    const { dir, cleanup } = scratch();
    try {
      new FileCooldownStore(dir).save({ Flash: 1 });
      expect(readdirSync(dir)).toEqual(["cooldowns.json"]);
    } finally {
      cleanup();
    }
  });

  it("treats a corrupt or missing file as empty rather than crashing", () => {
    const { dir, cleanup } = scratch();
    try {
      expect(new FileCooldownStore(dir).load()).toEqual({});
      writeFileSync(path.join(dir, "cooldowns.json"), "not json at all");
      expect(new FileCooldownStore(dir).load()).toEqual({});
    } finally {
      cleanup();
    }
  });

  it("drops entries that are not timestamps", () => {
    const { dir, cleanup } = scratch();
    try {
      writeFileSync(path.join(dir, "cooldowns.json"), '{"Flash":123,"Bad":"soon"}');
      expect(new FileCooldownStore(dir).load()).toEqual({ Flash: 123 });
    } finally {
      cleanup();
    }
  });

  it("degrades quietly when the cache dir cannot be written", () => {
    expect(() => new FileCooldownStore("/proc/nope/nope").save({ A: 1 })).not.toThrow();
  });
});

describe("CooldownRegistry over a file store", () => {
  it("survives a restart: a second registry sees the first one's cooldown", () => {
    const { dir, cleanup } = scratch();
    try {
      let now = 1_000_000;
      const store = new FileCooldownStore(dir);
      new CooldownRegistry(store, () => now).set("Flash", 3600);

      const afterRestart = new CooldownRegistry(new FileCooldownStore(dir), () => now);
      expect(afterRestart.cooling("Flash")).toBe(true);
      expect(afterRestart.describe("Flash")).toBe("1h");

      now += 3_601_000;
      expect(afterRestart.cooling("Flash")).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("forgets expired entries instead of growing the file forever", () => {
    const { dir, cleanup } = scratch();
    try {
      let now = 0;
      const reg = new CooldownRegistry(new FileCooldownStore(dir), () => now);
      reg.set("Old", 10);
      now = 20_000;
      reg.set("New", 10);
      expect(new FileCooldownStore(dir).load()).toEqual({ New: 30_000 });
    } finally {
      cleanup();
    }
  });

  it("lists active cooldowns longest-first for the status tool", () => {
    const reg = new CooldownRegistry(undefined, () => 0);
    reg.set("Short", 60);
    reg.set("Long", 3600);
    expect(reg.active()).toEqual([
      { model: "Long", secondsLeft: 3600 },
      { model: "Short", secondsLeft: 60 },
    ]);
  });
});
