import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Capabilities } from "./capabilities.js";
import type { Config } from "./config.js";
import { parseStreamEvents, type AgyEnvelope, type AgyUsage } from "./envelope.js";

/**
 * A resident agy process that answers one turn per NDJSON line on its stdin.
 *
 * agy's own words for why this exists: stream-json "runs one turn per message in
 * a single conversation, so a driver can keep a session open". Every follow-up
 * otherwise repays a full process spawn and model warm-up.
 */

/** The exact line agy accepts as a turn. Anything else is rejected on stderr. */
export function turnMessage(prompt: string): string {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

export interface SessionProcess {
  write(line: string): void;
  onData(cb: (chunk: string) => void): void;
  /** Fires once the process is gone and its stdout is fully delivered. */
  onExit(cb: () => void): void;
  kill(signal: NodeJS.Signals): void;
}

export interface SessionSpawnOptions {
  cwd: string;
  env?: Record<string, string>;
}

export type SpawnSession = (
  file: string,
  args: string[],
  opts: SessionSpawnOptions,
) => SessionProcess;

const spawnSessionProcess: SpawnSession = (file, args, opts) => {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    detached: true,
    ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
  });
  const decoder = new StringDecoder("utf8");
  return {
    write: (line) => {
      child.stdin?.write(line);
    },
    onData: (cb) => {
      child.stdout?.on("data", (d: Buffer) => cb(decoder.write(d)));
    },
    onExit: (cb) => {
      // "close", not "exit": the result line can still be in the pipe when the
      // process has already exited, and it must reach onData before this fires.
      child.on("close", cb);
      child.on("error", cb);
    },
    kill: (signal) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    },
  };
};

/** The driver could not answer this turn; the caller should run cold instead. */
export class WarmUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WarmUnavailable";
  }
}

/** The turn ran out of time. The session is gone; `text` is what it streamed. */
export class WarmTimeout extends Error {
  constructor(readonly text: string) {
    super("resident agy session exceeded the turn timeout");
    this.name = "WarmTimeout";
  }
}

interface Session {
  key: string;
  proc: SessionProcess;
  buffer: string;
  alive: boolean;
  busy: boolean;
  lastUsed: number;
  /** agy reports usage cumulatively per conversation; this is the previous turn's total. */
  usageSoFar: AgyUsage;
  idleTimer?: NodeJS.Timeout;
  /** Set while a turn is in flight. */
  pending?: {
    resolve(envelope: AgyEnvelope): void;
    reject(err: Error): void;
    onProgress?: (text: string) => void;
    text: string;
  };
}

export interface WarmDeps {
  /** Named apart from the runner's `spawn`: a session process is a different seam. */
  spawnSession?: SpawnSession;
  /** Extra environment for every resident process, e.g. the delegation-depth counter. */
  env?: Record<string, string>;
  now?: () => number;
}

export interface WarmStats {
  resident: number;
  keys: string[];
}

export interface TurnOptions {
  /** How long the turn may take; the session is dropped when it elapses. */
  timeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

function usageDelta(now: AgyUsage, before: AgyUsage): AgyUsage {
  const d = (a: number, b: number) => Math.max(0, a - b);
  return {
    inputTokens: d(now.inputTokens, before.inputTokens),
    outputTokens: d(now.outputTokens, before.outputTokens),
    thinkingTokens: d(now.thinkingTokens, before.thinkingTokens),
    cacheReadTokens: d(now.cacheReadTokens, before.cacheReadTokens),
    totalTokens: d(now.totalTokens, before.totalTokens),
  };
}

export class WarmSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly cfg: Config,
    private readonly caps: Capabilities,
    private readonly deps: WarmDeps = {},
  ) {}

  get enabled(): boolean {
    return (
      this.cfg.warmSessions && this.caps.has("--input-format") && this.caps.has("--output-format")
    );
  }

  stats(): WarmStats {
    return { resident: this.sessions.size, keys: [...this.sessions.keys()] };
  }

  /**
   * Runs one turn against the session for `conversationId`, starting it if
   * needed. Throws `WarmUnavailable` whenever a cold run would be safer — the
   * caller treats that as "fall back", never as a failed delegation — and
   * `WarmTimeout` when the turn itself ran out of time.
   *
   * The envelope's `usage` is this turn's alone: agy reports the conversation's
   * running total on every result, verified on agy 1.2.1.
   */
  async turn(
    conversationId: string,
    cwd: string,
    prompt: string,
    opts: TurnOptions,
  ): Promise<AgyEnvelope> {
    if (!this.enabled) throw new WarmUnavailable("warm sessions are disabled");
    if (opts.signal?.aborted) throw new Error("agy run cancelled by client.");

    const session = this.sessions.get(conversationId) ?? this.start(conversationId, cwd);
    if (!session.alive) {
      this.drop(session, "process is gone");
      throw new WarmUnavailable("resident agy session had exited");
    }
    if (session.busy) throw new WarmUnavailable("session is already running a turn");

    session.busy = true;
    session.lastUsed = this.now();
    this.arm(session);

    let deadline: NodeJS.Timeout | undefined;
    const onAbort = () => {
      session.pending?.reject(new Error("agy run cancelled by client."));
      this.drop(session, "cancelled");
    };
    try {
      const envelope = await new Promise<AgyEnvelope>((resolve, reject) => {
        session.pending = {
          resolve,
          reject,
          text: "",
          ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        };
        deadline = setTimeout(() => {
          reject(new WarmTimeout(session.pending?.text ?? ""));
          this.drop(session, "turn timed out");
        }, opts.timeoutMs);
        deadline.unref?.();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          session.proc.write(turnMessage(prompt));
        } catch (err) {
          reject(new WarmUnavailable(`could not write to resident session: ${String(err)}`));
        }
      });
      const usage = usageDelta(envelope.usage, session.usageSoFar);
      session.usageSoFar = envelope.usage;
      return { ...envelope, usage };
    } finally {
      if (deadline) clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
      session.busy = false;
      delete session.pending;
      session.lastUsed = this.now();
      if (session.alive) this.arm(session);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private start(conversationId: string, cwd: string): Session {
    if (!this.evictIfFull()) {
      throw new WarmUnavailable(`all ${this.cfg.warmMax} resident sessions are busy`);
    }
    const args = [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--conversation",
      conversationId,
      "--add-dir",
      cwd,
    ];
    if (this.cfg.skipPermissions && this.caps.has("--dangerously-skip-permissions")) {
      args.push("--dangerously-skip-permissions");
    }
    if (this.cfg.sandbox && this.caps.has("--sandbox")) args.push("--sandbox");
    if (this.caps.has("--disable-slash-commands")) args.push("--disable-slash-commands");
    if (this.caps.has("--mode")) args.push("--mode", "plan");

    const spawnFn = this.deps.spawnSession ?? spawnSessionProcess;
    const session: Session = {
      key: conversationId,
      proc: spawnFn(this.cfg.agyPath, args, {
        cwd,
        ...(this.deps.env ? { env: this.deps.env } : {}),
      }),
      buffer: "",
      alive: true,
      busy: false,
      lastUsed: this.now(),
      usageSoFar: {
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
      },
    };
    session.proc.onData((chunk) => this.consume(session, chunk));
    session.proc.onExit(() => {
      session.alive = false;
      session.pending?.reject(new WarmUnavailable("resident agy session exited mid-turn"));
      this.sessions.delete(session.key);
    });
    this.sessions.set(conversationId, session);
    this.arm(session);
    return session;
  }

  private consume(session: Session, chunk: string): void {
    session.buffer += chunk;
    const { events, rest } = parseStreamEvents(session.buffer);
    session.buffer = rest;
    for (const ev of events) {
      if (ev.kind === "step" && session.pending) {
        session.pending.text += ev.textDelta;
        session.pending.onProgress?.(session.pending.text);
      }
      if (ev.kind === "result") session.pending?.resolve(ev.envelope);
    }
  }

  private arm(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.busy) this.drop(session, "idle");
    }, this.cfg.warmIdleSec * 1000);
    session.idleTimer.unref?.();
  }

  /** Makes room for one more session; false when every resident one is mid-turn. */
  private evictIfFull(): boolean {
    while (this.sessions.size >= this.cfg.warmMax) {
      let oldest: Session | undefined;
      for (const s of this.sessions.values()) {
        if (!s.busy && (!oldest || s.lastUsed < oldest.lastUsed)) oldest = s;
      }
      if (!oldest) return false;
      this.drop(oldest, "evicted");
    }
    return true;
  }

  private drop(session: Session, why: string): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.alive = false;
    this.sessions.delete(session.key);
    session.pending?.reject(new WarmUnavailable(`resident session dropped: ${why}`));
    try {
      session.proc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }

  shutdown(): void {
    for (const s of [...this.sessions.values()]) this.drop(s, "shutdown");
  }
}
