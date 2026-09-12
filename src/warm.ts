import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Capabilities } from "./capabilities.js";
import type { Confinement } from "./confine.js";
import type { Config } from "./config.js";
import { commandFor, MAX_STDOUT_CHARS } from "./runner.js";
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
  // A dead resident process is an expected condition, not a crash. Without a
  // listener, EPIPE on this stream is an unhandled 'error' event and Node exits
  // the whole bridge; the write path below reports it as a normal turn failure
  // so the caller falls back to a cold run.
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  // Nothing here needs the resident process's stderr, but an unread pipe fills
  // and agy then blocks on its next write, mid-turn, until the turn times out.
  child.stderr?.resume();
  return {
    write: (line) => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        throw new WarmUnavailable("resident session stdin is closed");
      }
      stdin.write(line, (err) => {
        // Asynchronous failures cannot reach the caller's try/catch; killing the
        // child turns the next turn into a clean cold run instead of a hang.
        if (err) child.kill("SIGTERM");
      });
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

/**
 * One turn's stream-JSON line cannot legitimately exceed what a cold run would
 * accept as its whole output; a smaller cap here failed large answers warm that
 * succeed cold.
 */
const MAX_SESSION_BUFFER = MAX_STDOUT_CHARS;

/** The driver could not answer this turn; the caller should run cold instead. */
/** Order and spelling of the roots do not change what a sandbox confines. */
function confinementKey(roots: string[] | undefined): string {
  return JSON.stringify([...new Set((roots ?? []).map((r) => resolvePath(r)))].sort());
}

export class WarmUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WarmUnavailable";
  }
}

/** The turn ran out of time. The session is gone; `text` is what it streamed. */
/**
 * The turn was already sent to agy and then interrupted, so nobody knows whether
 * it ran.
 *
 * This is deliberately *not* a `WarmUnavailable`: that means "nothing happened,
 * run cold instead", and the caller acts on it by re-sending the prompt. Re-sending
 * a turn agy may already have processed runs it twice, which for a write follow-up
 * means applying an edit twice. An ambiguous outcome has to be reported, not retried.
 */
export class WarmTurnUncertain extends Error {
  constructor(reason: string) {
    super(
      `The resident agy session was dropped (${reason}) after the turn had already been sent, ` +
        `so it may or may not have run. Not retrying automatically: inspect the working tree and ` +
        `the conversation before re-sending.`,
    );
    this.name = "WarmTurnUncertain";
  }
}

export class WarmTimeout extends Error {
  constructor(readonly text: string) {
    super("resident agy session exceeded the turn timeout");
    this.name = "WarmTimeout";
  }
}

interface Session {
  key: string;
  /** The directory this process was started in; a turn elsewhere must not reuse it. */
  cwd: string;
  /** The roots it is confined against, as one comparable string; empty when unconfined. */
  confinedTo: string;
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
    /** True once the prompt reached agy's stdin, so a replay would be a second run. */
    sent?: boolean;
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
  /** Carries out `TurnOptions.confineTo`. */
  confinement?: Confinement;
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
  /** Roots the resident process must be denied writes beneath, fixed for its whole life. */
  confineTo?: string[];
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
  /** Outstanding SIGKILL escalations, cleared on shutdown so nothing is left armed. */
  private readonly pendingKills = new Set<ReturnType<typeof setTimeout>>();
  private readonly killGraceMs = 2_000;

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

    const existing = this.sessions.get(conversationId);
    // SEC-M6. A resident process keeps the cwd and --add-dir it was started with.
    // Reusing it for a turn whose cwd is different runs that turn somewhere the
    // caller did not ask for and did not have containment-checked for this call.
    // A process keeps its sandbox for life, so a turn needing different
    // confinement must not borrow one started under another. Either mismatch
    // sends this turn cold, which leaves the resident's history behind, so an
    // idle resident is dropped rather than reused by a later turn.
    const confinedTo = confinementKey(opts.confineTo);
    const mismatch = !existing
      ? undefined
      : resolvePath(existing.cwd) !== resolvePath(cwd)
        ? "resident session belongs to a different working directory"
        : existing.confinedTo !== confinedTo
          ? "resident session was started with different write confinement"
          : undefined;
    if (existing && mismatch) {
      if (!existing.busy) this.drop(existing, mismatch);
      throw new WarmUnavailable(mismatch);
    }
    const session = existing ?? this.start(conversationId, cwd, opts.confineTo);
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
          if (session.pending) session.pending.sent = true;
        } catch (err) {
          // Nothing was accepted by the pipe, so a cold retry is safe.
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

  private start(conversationId: string, cwd: string, confineTo?: string[]): Session {
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
    let proc: SessionProcess;
    try {
      const command = commandFor(confineTo, this.cfg.agyPath, args, this.deps.confinement);
      proc = spawnFn(command.file, command.args, {
        cwd,
        ...(this.deps.env ? { env: this.deps.env } : {}),
      });
    } catch (err) {
      // Nothing started, so nothing ran: a cold run is the right fallback.
      throw new WarmUnavailable(`could not start a resident session: ${(err as Error).message}`);
    }
    const session: Session = {
      key: conversationId,
      cwd,
      confinedTo: confinementKey(confineTo),
      proc,
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
      // Sent means agy may have run it: that is uncertain, never "run it cold".
      session.pending?.reject(
        session.pending.sent
          ? new WarmTurnUncertain("process exited mid-turn")
          : new WarmUnavailable("resident agy session exited mid-turn"),
      );
      this.forget(session);
    });
    this.sessions.set(conversationId, session);
    this.arm(session);
    return session;
  }

  private consume(session: Session, chunk: string): void {
    session.buffer += chunk;
    // Bounded: agy emits newline-delimited JSON, so a buffer that grows past this
    // without yielding an event is malformed output, not a big answer. Left
    // unbounded it was a slow memory leak for the life of the resident session.
    if (session.buffer.length > MAX_SESSION_BUFFER) {
      this.drop(session, "resident session produced unparseable output");
      return;
    }
    const { events, rest } = parseStreamEvents(session.buffer);
    session.buffer = rest;
    for (const ev of events) {
      if (ev.kind === "step" && session.pending) {
        session.pending.text += ev.textDelta;
        try {
          session.pending.onProgress?.(session.pending.text);
        } catch {
          // This runs in a stream 'data' handler, where a throw crashes the bridge.
        }
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

  /**
   * Removes `session` from the map only if it is still the one registered. A
   * dropped process closes late; deleting by key then removed its replacement,
   * which shutdown could no longer find and so never killed.
   */
  private forget(session: Session): void {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
  }

  private drop(session: Session, why: string, hard = false): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.alive = false;
    this.forget(session);
    session.pending?.reject(
      session.pending.sent
        ? new WarmTurnUncertain(why)
        : new WarmUnavailable(`resident session dropped: ${why}`),
    );
    const signal = (sig: NodeJS.Signals) => {
      try {
        session.proc.kill(sig);
      } catch {
        // already gone
      }
    };
    if (hard) {
      // On the way out there is no one left to escalate later, and a deferred
      // timer would be unref'd or simply never reached. These children are
      // detached and run with permissions skipped, so leaving one behind means
      // leaving it behind forever: kill it outright rather than politely.
      signal("SIGTERM");
      signal("SIGKILL");
      return;
    }
    signal("SIGTERM");
    // Escalate like the cold path does, for a drop while the bridge keeps running.
    const escalate = setTimeout(() => {
      this.pendingKills.delete(escalate);
      signal("SIGKILL");
    }, this.killGraceMs);
    escalate.unref?.();
    this.pendingKills.add(escalate);
  }

  /** Stops every resident session. Safe to call more than once. */
  shutdown(): void {
    for (const t of this.pendingKills) clearTimeout(t);
    this.pendingKills.clear();
    for (const s of [...this.sessions.values()]) this.drop(s, "shutdown", true);
  }
}
