import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import type { Config } from "./config.js";

const execFileAsync = promisify(execFile);

export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  conversationId?: string;
  /** Per-call timeout; falls back to cfg.timeoutSec. */
  timeoutSec?: number;
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

// agy reads stdin until EOF even in print mode; an open stdin pipe hangs it forever.
export const execWithClosedStdin: ExecFn = (file, args, options) => {
  const promise = execFileAsync(file, args, options);
  promise.child.stdin?.end();
  return promise;
};

const MAX_STDOUT_CHARS = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 1024 * 1024;

function spawnDetached(file: string, args: string[], cwd: string): ChildHandle {
  const child = spawn(file, args, { cwd, detached: true });
  child.stdin?.end();

  let out = "";
  let err = "";
  child.stdout?.on("data", (d: Buffer) => {
    if (out.length < MAX_STDOUT_CHARS) out += d.toString();
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (err.length < MAX_STDERR_CHARS) err += d.toString();
  });

  const done = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    let exitCode: number | null = null;
    // "close" needs all pipes shut; orphaned grandchildren can hold them open
    // forever, so resolve from "exit" after a short grace if "close" never fires.
    let closeFallback: NodeJS.Timeout | undefined;
    child.on("exit", (code) => {
      exitCode = code;
      closeFallback = setTimeout(() => resolve({ code: exitCode }), 2000);
      closeFallback.unref();
    });
    child.on("close", (code) => {
      if (closeFallback) clearTimeout(closeFallback);
      resolve({ code: code ?? exitCode });
    });
    child.on("error", (e) => {
      resolve({ code: null, error: e as NodeJS.ErrnoException });
    });
  });

  return {
    stdout: () => out,
    stderr: () => err,
    wait: () => done,
    kill: (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal); // whole process group
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    },
  };
}

export function buildArgs(req: RunRequest, cfg: Config, logPath: string): string[] {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const args: string[] = [];
  if (cfg.skipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.sandbox) args.push("--sandbox");
  args.push("--add-dir", req.cwd);
  args.push("--log-file", logPath);
  if (req.conversationId) args.push("--conversation", req.conversationId);
  if (req.model) args.push("--model", req.model);
  args.push("--print-timeout", `${timeoutSec}s`, "-p", req.prompt);
  return args;
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text:
      `${text.slice(0, max)}\n\n[claude-agy-mcp: output truncated at ${max} chars; ` +
      `full length was ${text.length} chars. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS.]`,
    truncated: true,
  };
}
