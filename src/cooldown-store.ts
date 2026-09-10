import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CooldownStore } from "./quota.js";

/** `$XDG_CACHE_HOME/claude-agy-mcp`, or `~/.cache/claude-agy-mcp`. */
export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "claude-agy-mcp");
}

/**
 * Cooldowns on disk, shared by every MCP client on the machine.
 *
 * A `Resets in 96h53m25s` lockout has to outlive the process that discovered it;
 * in memory it evaporated on restart and each client re-burned a call to learn
 * the same thing. Writes go to a temp file and are renamed into place, so a
 * concurrent reader sees either the old file or the new one, never a half-written one.
 */
export class FileCooldownStore implements CooldownStore {
  private readonly file: string;

  constructor(dir: string = cacheDir()) {
    this.file = path.join(dir, "cooldowns.json");
  }

  load(): Record<string, number> {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
        ),
      );
    } catch {
      return {};
    }
  }

  save(entries: Record<string, number>): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // A read-only cache dir degrades to in-process cooldowns; not fatal.
    }
  }
}
