import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import type { CooldownStore } from "./quota.js";

/** `$XDG_CACHE_HOME/claude-agy-mcp`, or `~/.cache/claude-agy-mcp`. */
export function cacheDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.XDG_CACHE_HOME || path.join(homedir(), ".cache"), "claude-agy-mcp");
}

function parse(raw: string): Record<string, number> {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) return {};
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>).filter(
      (e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]),
    ),
  );
}

/** Both sets of cooldowns, keeping the later expiry where they disagree. */
function merge(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [model, until] of Object.entries(b)) {
    if (until > (out[model] ?? 0)) out[model] = until;
  }
  return out;
}

/**
 * Cooldowns on disk, shared by every MCP client on the machine.
 *
 * A `Resets in 96h53m25s` lockout has to outlive the process that discovered it;
 * in memory it evaporated on restart and each client re-burned a call to learn
 * the same thing.
 *
 * Two servers can learn different 429s at the same moment, so a save merges
 * with what is on disk rather than replacing it: a cooldown is only ever
 * extended by another writer, never lost. Writes go to a uniquely named temp
 * file and are renamed into place, so a reader sees a whole file or none. When
 * the file cannot be written at all, this process still keeps its own entries.
 */
export class FileCooldownStore implements CooldownStore {
  private readonly file: string;
  private own: Record<string, number> = {};

  constructor(dir: string = cacheDir()) {
    this.file = path.join(dir, "cooldowns.json");
  }

  private fromDisk(): Record<string, number> {
    try {
      return parse(readFileSync(this.file, "utf8"));
    } catch {
      return {};
    }
  }

  load(): Record<string, number> {
    return merge(this.fromDisk(), this.own);
  }

  save(entries: Record<string, number>, now: number): void {
    this.own = { ...entries };
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const merged = merge(this.fromDisk(), entries);
      // Entries the caller dropped as expired stay dropped, on the caller's clock.
      for (const [model, until] of Object.entries(merged)) if (until <= now) delete merged[model];
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(merged), "utf8");
      renameSync(tmp, this.file);
    } catch {
      // A read-only cache dir degrades to in-process cooldowns; not fatal.
    }
  }
}
