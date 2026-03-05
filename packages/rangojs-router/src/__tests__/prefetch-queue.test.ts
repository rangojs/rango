import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("prefetch queue", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { cancelAllPrefetches } = await import("../browser/prefetch/queue");
    cancelAllPrefetches();
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

    expect(started).toEqual(["a", "b"]);

    a.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toEqual(["a", "b", "c"]);

    b.resolve();
    c.resolve();
    await Promise.resolve();
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

    expect(calls).toBe(1);

    d.resolve();
    await Promise.resolve();
    await Promise.resolve();

    enqueuePrefetch("dup", () => {
      calls++;
      return Promise.resolve();
    });
    await Promise.resolve();

    expect(calls).toBe(2);
  });

  it("aborts active tasks and clears queued tasks on cancel", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals: AbortSignal[] = [];
    const a = deferred();
    const b = deferred();
    const queued = vi.fn();

    enqueuePrefetch("a", (signal) => {
      signals.push(signal);
      return a.promise;
    });
    enqueuePrefetch("b", (signal) => {
      signals.push(signal);
      return b.promise;
    });
    enqueuePrefetch("c", () => {
      queued();
      return Promise.resolve();
    });

    cancelAllPrefetches();

    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queued).not.toHaveBeenCalled();

    a.resolve();
    b.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const followUp = vi.fn(() => Promise.resolve());
    enqueuePrefetch("d", followUp);
    await Promise.resolve();

    expect(followUp).toHaveBeenCalledTimes(1);
  });
});
