import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type Effort = "low" | "medium" | "high";

/** The model and tier the user chose once for this machine. */
export interface ModelPreference {
  /** A display name agy accepts, e.g. "Gemini 3.8 Flash (High)". */
  model: string;
  effort?: Effort;
  /** ISO timestamp of when it was chosen. */
  setAt: string;
}

export interface PreferenceStore {
  load(): ModelPreference | null;
  save(pref: ModelPreference | null): void;
}

/** `$XDG_CONFIG_HOME/claude-agy-mcp`, or `~/.config/claude-agy-mcp`. */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "claude-agy-mcp");
}

function isEffort(v: unknown): v is Effort {
  return v === "low" || v === "medium" || v === "high";
}

/**
 * The preference on disk, shared by every MCP client on the machine.
 *
 * "Ask once, then that's it" only holds if the answer outlives the process
 * that asked. Writes go to a temp file and are renamed into place, so a
 * concurrent reader never sees a half-written file.
 */
export class FilePreferenceStore implements PreferenceStore {
  private readonly file: string;

  constructor(dir: string = configDir()) {
    this.file = path.join(dir, "preferences.json");
  }

  load(): ModelPreference | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof raw !== "object" || raw === null) return null;
      const o = raw as Record<string, unknown>;
      if (typeof o.model !== "string" || !o.model.trim()) return null;
      return {
        model: o.model,
        ...(isEffort(o.effort) ? { effort: o.effort } : {}),
        setAt: typeof o.setAt === "string" ? o.setAt : "",
      };
    } catch {
      return null;
    }
  }

  save(pref: ModelPreference | null): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(pref ?? {}, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}

export class MemoryPreferenceStore implements PreferenceStore {
  private pref: ModelPreference | null = null;
  load(): ModelPreference | null {
    return this.pref ? { ...this.pref } : null;
  }
  save(pref: ModelPreference | null): void {
    this.pref = pref ? { ...pref } : null;
  }
}
