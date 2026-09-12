/**
 * Admission control for agy runs.
 *
 * MCP clients fire tool calls in parallel. The quota pool is shared across all
 * of them, and agy keeps a per-conversation presence lock of its own, so two
 * runs against one conversation are a corruption risk rather than a speedup.
 */

type Release = () => void;

/** A call that was cancelled before it ever started running. */
export class AbortError extends Error {
  constructor() {
    super("agy run cancelled by client.");
    this.name = "AbortError";
  }
}

/** Counting semaphore: at most `limit` holders at a time, FIFO. */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) throw new AbortError();
    if (this.active < this.limit) {
      this.active++;
      return this.releaseOnce();
    }
    // The slot is handed over on release, so it is already ours when we wake:
    // decrementing first would let a fresh caller take it before we resumed.
    //
    // A queued waiter that is cancelled leaves the queue instead of keeping its
    // place: without this it still held its FIFO position, delayed everyone
    // behind it, and then spawned a full agy process only to kill it.
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(waiter);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new AbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
    });
    return this.releaseOnce();
  }

  private releaseOnce(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** One mutex per key, created on demand and dropped when nothing holds it. */
export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  get held(): number {
    return this.chains.size;
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    // Swallow the predecessor's rejection: a failed run must not fail the next.
    const mine = previous.catch(() => {}).then(fn);
    this.chains.set(
      key,
      mine.catch(() => {}),
    );
    try {
      return await mine;
    } finally {
      // Only the last waiter clears the slot, so an in-flight chain is kept.
      if (this.chains.get(key) !== undefined) {
        const current = this.chains.get(key);
        void Promise.resolve(current).then(() => {
          if (this.chains.get(key) === current) this.chains.delete(key);
        });
      }
    }
  }
}

/** Both gates a delegation must pass: the global cap, then its conversation. */
export class Admission {
  readonly semaphore: Semaphore;
  private readonly mutex = new KeyedMutex();

  constructor(limit: number) {
    this.semaphore = new Semaphore(limit);
  }

  get inFlight(): number {
    return this.semaphore.inFlight;
  }

  get queued(): number {
    return this.semaphore.queued;
  }

  /**
   * Note that a fan-out whose legs share one `conversationId` runs strictly
   * sequentially, whatever `AGY_MAX_CONCURRENCY` says. That is intended, not a
   * throughput bug: agy keeps a per-conversation presence lock, so two
   * simultaneous turns against one conversation corrupt it rather than finishing
   * sooner. Fan out across conversations to get parallelism.
   */
  run<T>(
    conversationId: string | undefined,
    fn: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const guarded = () => this.semaphore.run(fn, signal);
    return conversationId ? this.mutex.run(conversationId, guarded) : guarded();
  }
}
