import { describe, it, expect } from "vitest";
import { Admission, KeyedMutex, Semaphore } from "../src/concurrency.js";

/** A job that reports when it starts and finishes, and finishes on demand. */
function job(log: string[], name: string) {
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  return {
    finish,
    run: async () => {
      log.push(`start ${name}`);
      await done;
      log.push(`end ${name}`);
      return name;
    },
  };
}

describe("Semaphore", () => {
  it("never lets more than `limit` holders run at once", async () => {
    const sem = new Semaphore(2);
    const log: string[] = [];
    const jobs = ["a", "b", "c"].map((n) => job(log, n));
    const running = jobs.map((j) => sem.run(j.run));

    await Promise.resolve();
    expect(log).toEqual(["start a", "start b"]);
    expect(sem.inFlight).toBe(2);
    expect(sem.queued).toBe(1);

    jobs[0]!.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(["start a", "start b", "end a", "start c"]);

    jobs[1]!.finish();
    jobs[2]!.finish();
    expect(await Promise.all(running)).toEqual(["a", "b", "c"]);
    expect(sem.inFlight).toBe(0);
  });

  it("never overlaps holders, whichever microtask a new caller arrives on", async () => {
    // The handover from a releasing holder to a woken waiter spans several
    // microtasks. A caller arriving inside that window must not be able to take
    // the slot the waiter was already woken for, so the arrivals below are
    // deliberately spread across different points in it.
    const sem = new Semaphore(1);
    let live = 0;
    let peak = 0;
    const gates: (() => void)[] = [];
    const hold = () =>
      sem.run(async () => {
        live++;
        peak = Math.max(peak, live);
        await new Promise<void>((resolve) => gates.push(resolve));
        live--;
      });

    const running = [hold(), hold()];
    for (let hops = 0; hops < 4; hops++) {
      gates.shift()?.();
      for (let i = 0; i < hops; i++) await Promise.resolve();
      running.push(hold());
    }
    while (gates.length) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(running);
    expect(peak).toBe(1);
    expect(sem.inFlight).toBe(0);
  });

  it("releases the slot when the job throws", async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(sem.inFlight).toBe(0);
    await expect(sem.run(() => Promise.resolve("after"))).resolves.toBe("after");
  });
});

describe("KeyedMutex", () => {
  it("serialises jobs on the same key and overlaps different keys", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const a1 = job(log, "a1");
    const a2 = job(log, "a2");
    const b1 = job(log, "b1");

    const running = [mutex.run("a", a1.run), mutex.run("a", a2.run), mutex.run("b", b1.run)];

    await new Promise((r) => setTimeout(r, 0));
    expect(log.sort()).toEqual(["start a1", "start b1"]);

    a1.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toContain("start a2");

    a2.finish();
    b1.finish();
    await Promise.all(running);
  });

  it("a failed job does not poison the next one on the same key", async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run("k", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(mutex.run("k", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });
});

describe("Admission", () => {
  it("applies the global cap and the per-conversation lock together", async () => {
    const admission = new Admission(2);
    const log: string[] = [];
    const jobs = ["x", "y", "z"].map((n) => job(log, n));
    const running = [
      admission.run("conv", jobs[0]!.run),
      admission.run("conv", jobs[1]!.run),
      admission.run(undefined, jobs[2]!.run),
    ];

    await new Promise((r) => setTimeout(r, 0));
    // Two slots, but the first two share a conversation, so only one of them runs.
    expect([...log].sort()).toEqual(["start x", "start z"]);

    jobs[0]!.finish();
    jobs[2]!.finish();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toContain("start y");
    jobs[1]!.finish();
    await Promise.all(running);
    expect(admission.inFlight).toBe(0);
  });
});
