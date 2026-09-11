import { describe, it, expect } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LogTail } from "../src/logtail.js";

function scratch(): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "logtail-"));
  return {
    file: path.join(dir, "run.log"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("LogTail", () => {
  it("returns nothing when the file does not exist yet", async () => {
    const { file, cleanup } = scratch();
    try {
      expect(await new LogTail(file).read()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("returns only what was appended since the previous read", async () => {
    const { file, cleanup } = scratch();
    try {
      const tail = new LogTail(file);
      writeFileSync(file, "one\ntwo\n");
      expect(await tail.read()).toBe("one\ntwo\n");
      expect(await tail.read()).toBe("");
      appendFileSync(file, "three\n");
      expect(await tail.read()).toBe("three\n");
    } finally {
      cleanup();
    }
  });

  it("holds back a half-written line so a 429 is not split in two", async () => {
    const { file, cleanup } = scratch();
    try {
      const tail = new LogTail(file);
      writeFileSync(file, "RESOURCE_EXHAU");
      expect(await tail.read()).toBe("");
      appendFileSync(file, "STED (code 429)\n");
      expect(await tail.read()).toBe("RESOURCE_EXHAUSTED (code 429)\n");
    } finally {
      cleanup();
    }
  });

  it("flush returns a final line that never got its newline", async () => {
    const { file, cleanup } = scratch();
    try {
      const tail = new LogTail(file);
      writeFileSync(file, "done\nno newline here");
      expect(await tail.read()).toBe("done\n");
      expect(await tail.flush()).toBe("no newline here");
      expect(await tail.flush()).toBe("");
    } finally {
      cleanup();
    }
  });

  it("starts over when the file is truncated underneath it", async () => {
    const { file, cleanup } = scratch();
    try {
      const tail = new LogTail(file);
      writeFileSync(file, "aaaa\nbbbb\n");
      expect(await tail.read()).toBe("aaaa\nbbbb\n");
      writeFileSync(file, "cc\n");
      expect(await tail.read()).toBe("cc\n");
    } finally {
      cleanup();
    }
  });
});
