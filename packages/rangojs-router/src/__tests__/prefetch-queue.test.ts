import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Flush rAF callbacks and pending microtasks so the queue's drain() runs.
 * Multiple rounds handle microtask → macrotask chaining
 * (e.g., .finally() schedules scheduleDrain which schedules rAF).
 */
async function flushRaf() {
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("prefetch queue", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { abortAllPrefetches } = await import("../browser/prefetch/queue");
    abortAllPrefetches();
  });

  it("defers execution to next animation frame", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    const started: string[] = [];
    const a = deferred();

    enqueuePrefetch("a", () => {
      started.push("a");
      return a.promise;
    });

    // Nothing starts synchronously — deferred to rAF
    expect(started).toEqual([]);

    await flushRaf();
    expect(started).toEqual(["a"]);

    a.resolve();
    await flushRaf();
  });

  it("runs at most 2 tasks concurrently and drains FIFO", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    const started: string[] = [];
    const a = deferred();
    const b = deferred();
    const c = deferred();

    enqueuePrefetch("a", () => {
      started.push("a");
      return a.promise;
    });
    enqueuePrefetch("b", () => {
      started.push("b");
      return b.promise;
    });
    enqueuePrefetch("c", () => {
      started.push("c");
      return c.promise;
    });

    // Flush rAF to start first batch
    await flushRaf();
    expect(started).toEqual(["a", "b"]);

    // Complete "a", flush rAF for next batch
    a.resolve();
    await flushRaf();

    expect(started).toEqual(["a", "b", "c"]);

    b.resolve();
    c.resolve();
    await flushRaf();
  });

  it("deduplicates queued and executing keys", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    let calls = 0;
    const d = deferred();

    enqueuePrefetch("dup", () => {
      calls++;
      return d.promise;
    });
    enqueuePrefetch("dup", () => {
      calls++;
      return Promise.resolve();
    });

    await flushRaf();
    expect(calls).toBe(1);

    d.resolve();
    await flushRaf();

    enqueuePrefetch("dup", () => {
      calls++;
      return Promise.resolve();
    });
    await flushRaf();

    expect(calls).toBe(2);
  });

  it("cancelAllPrefetches clears queue but leaves executing tasks running", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals: AbortSignal[] = [];
    const a = deferred();
    const b = deferred();
    const queuedFn = vi.fn();

    enqueuePrefetch("a", (signal) => {
      signals.push(signal);
      return a.promise;
    });
    enqueuePrefetch("b", (signal) => {
      signals.push(signal);
      return b.promise;
    });
    enqueuePrefetch("c", () => {
      queuedFn();
      return Promise.resolve();
    });

    // Start the first batch
    await flushRaf();
    expect(signals).toHaveLength(2);

    cancelAllPrefetches();

    // Executing tasks are NOT aborted
    expect(signals.every((signal) => signal.aborted)).toBe(false);
    // Queued task never starts
    expect(queuedFn).not.toHaveBeenCalled();

    a.resolve();
    b.resolve();
    await flushRaf();

    // Queue accepts new items after cancel
    const followUp = vi.fn(() => Promise.resolve());
    enqueuePrefetch("d", followUp);
    await flushRaf();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("abortAllPrefetches aborts executing tasks and clears queue", async () => {
    const { enqueuePrefetch, abortAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals: AbortSignal[] = [];
    const a = deferred();
    const b = deferred();
    const queuedFn = vi.fn();

    enqueuePrefetch("a", (signal) => {
      signals.push(signal);
      return a.promise;
    });
    enqueuePrefetch("b", (signal) => {
      signals.push(signal);
      return b.promise;
    });
    enqueuePrefetch("c", () => {
      queuedFn();
      return Promise.resolve();
    });

    await flushRaf();
    expect(signals).toHaveLength(2);

    abortAllPrefetches();

    // Executing tasks ARE aborted
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    // Queued task never starts
    expect(queuedFn).not.toHaveBeenCalled();

    a.resolve();
    b.resolve();
    await flushRaf();

    // Queue accepts new items after abort
    const followUp = vi.fn(() => Promise.resolve());
    enqueuePrefetch("d", followUp);
    await flushRaf();
    expect(followUp).toHaveBeenCalledTimes(1);
  });
});
