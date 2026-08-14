import { homedir } from "node:os";
import path from "node:path";

export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  conversationId?: string;
}

export interface RunResult {
  output: string;
  truncated: boolean;
}

export interface ChildHandle {
  stdout(): string;
  stderr(): string;
  /** Settles when the process is fully done (exit + closed pipes, or spawn error). */
  wait(): Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  /** Signals the whole process group so web-search helpers can't outlive agy. */
  kill(signal: NodeJS.Signals): void;
}

export type ExecFn = (
  file: string,
  args: string[],
  options: { cwd: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export const SESSIONS_FILE = path.join(
  homedir(),
  ".gemini",
  "antigravity-cli",
  "cache",
  "last_conversations.json",
);
