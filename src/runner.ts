import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "./config.js";
import { detectQuota, QuotaError } from "./quota.js";

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
  timedOut?: boolean;
}

export interface ChildHandle {
  stdout(): string;
  stderr(): string;
  /** Settles when the process is fully done (exit + closed pipes, or spawn error). */
  wait(): Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  /** Signals the whole process group so web-search helpers can't outlive agy. */
  kill(signal: NodeJS.Signals): void;
}

export interface RunnerDeps {
  spawnChild(file: string, args: string[], cwd: string): ChildHandle;
  readLog(logPath: string): Promise<string>;
  removeLog(logPath: string): Promise<void>;
  readSessionsFile(): Promise<string>;
  makeLogPath(): string;
  /** How often to scan the run log for quota errors. */
  pollMs?: number;
  /** Extra wait beyond agy's own --print-timeout before we hard-kill. */
  graceMs?: number;
  /** Delay between SIGTERM and SIGKILL escalation. */
  killGraceMs?: number;
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

export const defaultDeps: RunnerDeps = {
  spawnChild: spawnDetached,
  readLog: async (logPath) => {
    try {
      return await readFile(logPath, "utf8");
    } catch {
      return "";
    }
  },
  removeLog: (logPath) => rm(logPath, { force: true }),
  readSessionsFile: () => readFile(SESSIONS_FILE, "utf8"),
  makeLogPath: () => path.join(tmpdir(), `claude-agy-mcp-${process.pid}-${randomUUID()}.log`),
};

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

export async function runAgy(
  req: RunRequest,
  cfg: Config,
  deps: RunnerDeps = defaultDeps,
): Promise<RunResult> {
  const timeoutSec = req.timeoutSec ?? cfg.timeoutSec;
  const pollMs = deps.pollMs ?? 1000;
  const graceMs = deps.graceMs ?? 15_000;
  const killGraceMs = deps.killGraceMs ?? 5_000;
  const logPath = deps.makeLogPath();
  let timedOut = false;

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = deps.spawnChild(cfg.agyPath, buildArgs(req, cfg, logPath), req.cwd);

    let settled = false;
    let polling = false;
    const timers: NodeJS.Timeout[] = [];

    const killChild = () => {
      child.kill("SIGTERM");
      // Escalation must survive finish()'s cleanup, and unref keeps it from
      // holding the process open.
      const escalate = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      escalate.unref?.();
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poller);
      for (const t of timers) clearTimeout(t);
      fn();
    };

    const poller = setInterval(async () => {
      if (polling || settled) return;
      polling = true;
      try {
        const log = await deps.readLog(logPath);
        if (settled) return; // settled during the async read — don't kill a finished run
        const quota = detectQuota(log);
        if (quota) {
          killChild();
          finish(() => reject(new QuotaError(req.model, quota)));
        }
      } finally {
        polling = false;
      }
    }, pollMs);

    // Hard deadline independent of the child's pipes: agy's own --print-timeout
    // should fire first; if it doesn't, resolve with partial output without waiting for "close".
    timers.push(
      setTimeout(
        () => {
          killChild();
          timedOut = true;
          finish(() => resolve(child.stdout().trim()));
        },
        timeoutSec * 1000 + graceMs,
      ),
    );

    void child.wait().then(async ({ code, error }) => {
      if (settled) return;
      if (error?.code === "ENOENT") {
        finish(() =>
          reject(
            new Error(
              `agy CLI not found at "${cfg.agyPath}". Install the Antigravity CLI ` +
                `(https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.`,
            ),
          ),
        );
        return;
      }
      if (error) {
        finish(() => reject(new Error(`agy failed: ${error.message}`)));
        return;
      }
      const out = child.stdout().trim();
      if (code !== 0) {
        const stderr = child.stderr().trim();
        finish(() =>
          reject(new Error(stderr ? `agy failed: ${stderr}` : `agy exited with code ${code}.`)),
        );
        return;
      }
      if (!out) {
        // agy swallows quota errors and exits 0 with empty output after its
        // print-timeout — check the log before reporting anything as success.
        const quota = detectQuota(await deps.readLog(logPath));
        finish(() =>
          reject(
            quota
              ? new QuotaError(req.model, quota)
              : new Error(
                  "agy returned empty output (likely hit its print-timeout without a response).",
                ),
          ),
        );
        return;
      }
      finish(() => resolve(out));
    });
  }).finally(() => void deps.removeLog(logPath).catch(() => {}));

  const { text, truncated } = truncate(stdout, cfg.maxOutputChars);
  return { output: text, truncated, ...(timedOut ? { timedOut: true } : {}) };
}
