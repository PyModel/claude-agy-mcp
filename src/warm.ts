import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { Capabilities } from "./capabilities.js";
import type { Config } from "./config.js";
import { parseStreamEvents, type AgyEnvelope } from "./envelope.js";

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
  onExit(cb: () => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnSession = (file: string, args: string[], cwd: string) => SessionProcess;

const spawnSessionProcess: SpawnSession = (file, args, cwd) => {
  const child = spawn(file, args, { cwd, detached: true });
  const decoder = new StringDecoder("utf8");
  return {
    write: (line) => {
      child.stdin?.write(line);
    },
    onData: (cb) => {
      child.stdout?.on("data", (d: Buffer) => cb(decoder.write(d)));
    },
    onExit: (cb) => {
      child.on("exit", cb);
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

interface Session {
  key: string;
  proc: SessionProcess;
  buffer: string;
  alive: boolean;
  busy: boolean;
  lastUsed: number;
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
  now?: () => number;
}

export interface WarmStats {
  resident: number;
  keys: string[];
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
   * needed. Throws `WarmUnavailable` whenever a cold run would be safer —
   * the caller treats that as "fall back", never as a failed delegation.
   */
  async turn(
    conversationId: string,
    cwd: string,
    prompt: string,
    onProgress?: (text: string) => void,
  ): Promise<AgyEnvelope> {
    if (!this.enabled) throw new WarmUnavailable("warm sessions are disabled");

    const session = this.sessions.get(conversationId) ?? this.start(conversationId, cwd);
    if (!session.alive) {
      this.drop(session, "process is gone");
      throw new WarmUnavailable("resident agy session had exited");
    }
    if (session.busy) throw new WarmUnavailable("session is already running a turn");

    session.busy = true;
    session.lastUsed = this.now();
    this.arm(session);

    try {
      return await new Promise<AgyEnvelope>((resolve, reject) => {
        session.pending = { resolve, reject, text: "", ...(onProgress ? { onProgress } : {}) };
        try {
          session.proc.write(turnMessage(prompt));
        } catch (err) {
          reject(new WarmUnavailable(`could not write to resident session: ${String(err)}`));
        }
      });
    } finally {
      session.busy = false;
      delete session.pending;
      session.lastUsed = this.now();
      this.arm(session);
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private start(conversationId: string, cwd: string): Session {
    this.evictIfFull();
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
    if (this.caps.has("--disable-slash-commands")) args.push("--disable-slash-commands");
    if (this.caps.has("--mode")) args.push("--mode", "plan");

    const spawnFn = this.deps.spawnSession ?? spawnSessionProcess;
    const session: Session = {
      key: conversationId,
      proc: spawnFn(this.cfg.agyPath, args, cwd),
      buffer: "",
      alive: true,
      busy: false,
      lastUsed: this.now(),
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

  private evictIfFull(): void {
    while (this.sessions.size >= this.cfg.warmMax) {
      let oldest: Session | undefined;
      for (const s of this.sessions.values()) {
        if (!s.busy && (!oldest || s.lastUsed < oldest.lastUsed)) oldest = s;
      }
      if (!oldest) return; // every resident session is busy; the caller runs cold
      this.drop(oldest, "evicted");
    }
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
