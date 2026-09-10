import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Config } from "./config.js";
import type { Capabilities } from "./capabilities.js";
import {
  parseEnvelope,
  parseStreamEvents,
  EMPTY_USAGE,
  type AgyEnvelope,
  type AgyUsage,
  type DeniedAction,
} from "./envelope.js";
import { AgyFailure, classifyRun } from "./failure.js";
import { LogTail } from "./logtail.js";
import { detectQuota, QuotaError } from "./quota.js";

/** How much authority a single run is granted. */
export type RunMode = "plan" | "accept-edits";

export interface RunRequest {
  prompt: string;
  cwd: string;
  /** Extra workspace roots, each passed as its own --add-dir. */
  dirs?: string[];
  model?: string;
  /** Reasoning tier, separate from the model. */
  effort?: "low" | "medium" | "high";
  mode?: RunMode;
  sandbox?: boolean;
  /** Let agy expand the user's slash commands and skills. Off unless asked for. */
  slashCommands?: boolean;
  /** JSON schema string constraining the answer; fills `structuredOutput`. */
  jsonSchema?: string;
  conversationId?: string;
  /** How long this run may take, already resolved by `timeoutFor`. */
  timeoutSec: number;
  /** MCP cancellation signal — kills the agy process when aborted. */
  signal?: AbortSignal;
  /** Extra environment for the child, e.g. the delegation-depth counter. */
  env?: Record<string, string>;
  /** Called as agy streams; enables --output-format stream-json when supported. */
  onProgress?: (p: RunProgress) => void;
}

export interface RunProgress {
  /** Text agy has produced so far. */
  text: string;
  stepIndex: number;
  stepType: string;
  tokens: number;
}

export interface RunResult {
  output: string;
  conversationId?: string;
  /** Tool actions agy wanted and was refused — the proof of what it could not do. */
  deniedActions: DeniedAction[];
  usage: AgyUsage;
  structuredOutput?: unknown;
  numTurns: number;
  timedOut: boolean;
  /** Original length when the output was cut, absent when it was not. */
  truncatedFrom?: number;
}

export interface AgyProcess {
  stdout(): string;
  stderr(): string;
  /** Settles when the process is fully done (exit + closed pipes, or spawn error). */
  wait(): Promise<{ code: number | null; error?: NodeJS.ErrnoException }>;
  /** Signals the whole process group so web-search helpers can't outlive agy. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

/**
 * The one seam of this module: how an agy process comes into being. Two adapters
 * satisfy it — a detached child process in production, a fake agy in tests.
 */
export type SpawnAgy = (file: string, args: string[], opts: SpawnOptions) => AgyProcess;

/** Knobs, not seams: how long the supervisor waits at each stage. */
export interface RunTiming {
  /** How often to scan the run log for quota errors and drain streamed progress. */
  pollMs?: number;
  /** Extra wait beyond agy's own --print-timeout before we hard-kill. */
  graceMs?: number;
  /** Delay between SIGTERM and SIGKILL escalation. */
  killGraceMs?: number;
}

export interface RunnerDeps {
  spawn?: SpawnAgy;
  timing?: RunTiming;
}

const MAX_STDOUT_CHARS = 64 * 1024 * 1024;
const MAX_STDERR_CHARS = 1024 * 1024;

const spawnDetached: SpawnAgy = (file, args, opts) => {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    detached: true,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  child.stdin?.end();

  let out = "";
  let err = "";
  // A UTF-8 sequence can straddle two chunks; StringDecoder holds the partial
  // bytes instead of turning them into U+FFFD.
  const outDecoder = new StringDecoder("utf8");
  const errDecoder = new StringDecoder("utf8");
  child.stdout?.on("data", (d: Buffer) => {
    if (out.length < MAX_STDOUT_CHARS) out += outDecoder.write(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (err.length < MAX_STDERR_CHARS) err += errDecoder.write(d);
  });
  const flush = () => {
    out += outDecoder.end();
    err += errDecoder.end();
  };

  const done = new Promise<{ code: number | null; error?: NodeJS.ErrnoException }>((resolve) => {
    let exitCode: number | null = null;
    // "close" needs all pipes shut; orphaned grandchildren can hold them open
    // forever, so resolve from "exit" after a short grace if "close" never fires.
    let closeFallback: NodeJS.Timeout | undefined;
    child.on("exit", (code) => {
      exitCode = code;
      closeFallback = setTimeout(() => {
        flush();
        resolve({ code: exitCode });
      }, 2000);
      closeFallback.unref();
    });
    child.on("close", (code) => {
      if (closeFallback) clearTimeout(closeFallback);
      flush();
      resolve({ code: code ?? exitCode });
    });
    child.on("error", (e) => {
      flush();
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
};

function makeLogPath(): string {
  return path.join(tmpdir(), `claude-agy-mcp-${process.pid}-${randomUUID()}.log`);
}

/**
 * agy's own flag parser sees `-p <prompt>`; a prompt that itself starts with a
 * dash can be read as a flag. Prefixing a zero-width space would corrupt the
 * text, so the guard is explicit and refuses instead.
 */
export function assertPromptIsNotFlagLike(prompt: string): void {
  if (/^\s*-/.test(prompt)) {
    throw new Error(
      "Prompt starts with '-', which agy's argument parser would read as a flag. " +
        "Rephrase it, or quote the leading dash.",
    );
  }
}

export interface BuildArgsOptions {
  logPath: string;
  caps: Capabilities;
  /** "json" | "stream-json" | undefined for agy builds with no --output-format. */
  outputFormat?: "json" | "stream-json";
}

export function buildArgs(req: RunRequest, cfg: Config, opts: BuildArgsOptions): string[] {
  const { caps, logPath } = opts;
  const args: string[] = [];
  const push = (flag: string, ...values: string[]) => {
    if (caps.has(flag)) args.push(flag, ...values);
  };

  if (cfg.skipPermissions) push("--dangerously-skip-permissions");
  if (req.sandbox ?? cfg.sandbox) push("--sandbox");
  if (req.mode) push("--mode", req.mode);
  if (!req.slashCommands) push("--disable-slash-commands");

  args.push("--add-dir", req.cwd);
  for (const dir of req.dirs ?? []) if (dir !== req.cwd) args.push("--add-dir", dir);

  args.push("--log-file", logPath);
  if (req.conversationId) args.push("--conversation", req.conversationId);
  if (req.model) args.push("--model", req.model);
  if (req.effort) push("--effort", req.effort);
  if (req.jsonSchema) push("--json-schema", req.jsonSchema);
  if (opts.outputFormat) push("--output-format", opts.outputFormat);

  args.push("--print-timeout", `${req.timeoutSec}s`, "-p", req.prompt);
  return args;
}

export interface Truncation {
  text: string;
  /** Original length, present only when the text was cut. */
  from?: number;
}

/**
 * Cuts `text` to `max`, keeping both ends.
 *
 * Reviews and analyses put their conclusion last, so a head-only cut throws away
 * the part the caller most needs. The gap is stated in the text it returns.
 */
export function truncate(text: string, max: number): Truncation {
  if (text.length <= max) return { text };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  const dropped = text.length - max;
  return {
    text:
      `${text.slice(0, head)}\n\n[claude-agy-mcp: ${dropped} chars omitted here — output was ` +
      `${text.length} chars, limit ${max}. Ask a narrower question or raise AGY_MAX_OUTPUT_CHARS. ` +
      `The end of the output follows.]\n\n${text.slice(-tail)}`,
    from: text.length,
  };
}

/** Text agy produced, whichever output format it was asked for. */
function answerOf(envelope: AgyEnvelope | null, stdout: string): string {
  if (envelope) return envelope.response.trim();
  return stdout.trim();
}

function outputFormatFor(req: RunRequest, caps: Capabilities): "json" | "stream-json" | undefined {
  if (!caps.has("--output-format")) return undefined;
  return req.onProgress ? "stream-json" : "json";
}

export async function runAgy(
  req: RunRequest,
  cfg: Config,
  caps: Capabilities,
  deps: RunnerDeps = {},
): Promise<RunResult> {
  assertPromptIsNotFlagLike(req.prompt);

  const spawnAgy = deps.spawn ?? spawnDetached;
  const pollMs = deps.timing?.pollMs ?? 1000;
  const graceMs = deps.timing?.graceMs ?? 15_000;
  const killGraceMs = deps.timing?.killGraceMs ?? 5_000;
  const logPath = makeLogPath();
  const outputFormat = outputFormatFor(req, caps);
  const tail = new LogTail(logPath);
  let timedOut = false;
  let trailingLog = "";

  const finished = await new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawnAgy(cfg.agyPath, buildArgs(req, cfg, { logPath, caps, outputFormat }), {
        cwd: req.cwd,
        ...(req.env ? { env: req.env } : {}),
      });

      let settled = false;
      let polling = false;
      let streamCursor = 0;
      let streamRest = "";
      let streamedText = "";
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
        req.signal?.removeEventListener("abort", onAbort);
        fn();
      };

      const drainProgress = () => {
        if (!req.onProgress || outputFormat !== "stream-json") return;
        const all = child.stdout();
        if (all.length <= streamCursor) return;
        const chunk = streamRest + all.slice(streamCursor);
        streamCursor = all.length;
        const { events, rest } = parseStreamEvents(chunk);
        streamRest = rest;
        for (const ev of events) {
          if (ev.kind !== "step") continue;
          streamedText += ev.textDelta;
          req.onProgress({
            text: streamedText,
            stepIndex: ev.stepIndex,
            stepType: ev.stepType,
            tokens: ev.usage?.totalTokens ?? 0,
          });
        }
      };

      const poller = setInterval(async () => {
        if (polling || settled) return;
        polling = true;
        try {
          drainProgress();
          // agy only reports RESOURCE_EXHAUSTED to its log file, never to stdout.
          const appended = await tail.read();
          if (settled) return; // settled during the async read — don't kill a finished run
          const quota = appended && detectQuota(appended);
          if (quota) {
            killChild();
            finish(() => reject(new QuotaError(req.model, quota)));
          }
        } finally {
          polling = false;
        }
      }, pollMs);

      // Hard deadline independent of the child's pipes: agy's own --print-timeout
      // should fire first; if it doesn't, resolve with partial output.
      timers.push(
        setTimeout(
          () => {
            killChild();
            timedOut = true;
            finish(() => resolve({ stdout: child.stdout(), stderr: child.stderr(), code: 0 }));
          },
          req.timeoutSec * 1000 + graceMs,
        ),
      );

      const onAbort = () => {
        killChild();
        finish(() => reject(new Error("agy run cancelled by client.")));
      };
      if (req.signal?.aborted) {
        onAbort();
        return;
      }
      req.signal?.addEventListener("abort", onAbort, { once: true });

      void child.wait().then(({ code, error }) => {
        if (settled) return;
        drainProgress();
        if (error?.code === "ENOENT") {
          finish(() =>
            reject(
              new AgyFailure(
                "not_installed",
                `agy CLI not found at "${cfg.agyPath}". Install the Antigravity CLI ` +
                  `(https://antigravity.google/docs/cli-getting-started) or set AGY_PATH.`,
              ),
            ),
          );
          return;
        }
        if (error) {
          finish(() => reject(new AgyFailure("agy_error", `agy failed: ${error.message}`)));
          return;
        }
        finish(() => resolve({ stdout: child.stdout(), stderr: child.stderr(), code }));
      });
    },
  ).finally(async () => {
    // Drain before deleting: a 429 that lands between the last poll tick and the
    // exit only exists in this file, and the post-run check below needs it.
    trailingLog = await tail.flush();
    await rm(logPath, { force: true }).catch(() => {});
  });

  const envelope = parseEnvelope(finished.stdout);
  const answer = answerOf(envelope, finished.stdout);

  if (!timedOut) {
    const failure = classifyRun({
      envelope,
      exitCode: finished.code,
      stderr: finished.stderr,
    });
    if (failure) {
      // A quota 429 never reaches stdout, only the log — check what was left in it.
      const quota = detectQuota(trailingLog);
      if (quota) throw new QuotaError(req.model, quota);
      throw new AgyFailure(failure.kind, failure.message, req.model);
    }
  }

  const cut = truncate(answer, cfg.maxOutputChars);
  return {
    output: cut.text,
    ...(cut.from !== undefined ? { truncatedFrom: cut.from } : {}),
    ...(envelope?.conversationId ? { conversationId: envelope.conversationId } : {}),
    deniedActions: envelope?.deniedActions ?? [],
    usage: envelope?.usage ?? EMPTY_USAGE,
    ...(envelope && envelope.structuredOutput !== undefined
      ? { structuredOutput: envelope.structuredOutput }
      : {}),
    numTurns: envelope?.numTurns ?? 0,
    timedOut,
  };
}
