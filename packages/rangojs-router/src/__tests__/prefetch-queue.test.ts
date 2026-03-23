import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Mock resource-ready — resolve immediately by default.
// Individual tests can override via mockReturnValueOnce.
const mockWaitForIdle = vi.fn((_timeout?: number) => Promise.resolve());
const mockWaitForViewportImages = vi.fn(() => Promise.resolve());
const mockWait = vi.fn(
  (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
);

vi.mock("../browser/prefetch/resource-ready", () => ({
  waitForIdle: (timeout?: number) => mockWaitForIdle(timeout),
  waitForViewportImages: () => mockWaitForViewportImages(),
  wait: (ms: number) => mockWait(ms),
}));

/**
 * Flush pending microtasks and macrotasks so the queue's drain() runs.
 * Multiple rounds handle microtask → macrotask chaining
 * (e.g., .finally() schedules scheduleDrain which schedules idle wait).
 */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("prefetch queue", () => {
  beforeEach(() => {
    vi.resetModules();
    mockWaitForIdle.mockClear().mockImplementation(() => Promise.resolve());
    mockWaitForViewportImages
      .mockClear()
      .mockImplementation(() => Promise.resolve());
    mockWait
      .mockClear()
      .mockImplementation(
        (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
      );
  });

  afterEach(async () => {
    const { abortAllPrefetches } = await import("../browser/prefetch/queue");
    abortAllPrefetches();
  });

  it("defers execution until idle and images are ready", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    const started: string[] = [];
    const a = deferred();

    enqueuePrefetch("a", () => {
      started.push("a");
      return a.promise;
    });

    // Nothing starts synchronously — deferred to idle + images
    expect(started).toEqual([]);

    await flush();
    expect(started).toEqual(["a"]);
    expect(mockWaitForIdle).toHaveBeenCalled();
    expect(mockWaitForViewportImages).toHaveBeenCalled();

    a.resolve();
    await flush();
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

    await flush();
    expect(started).toEqual(["a", "b"]);

    a.resolve();
    await flush();

    expect(started).toEqual(["a", "b", "c"]);

    b.resolve();
    c.resolve();
    await flush();
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

    await flush();
    expect(calls).toBe(1);

    d.resolve();
    await flush();

    enqueuePrefetch("dup", () => {
      calls++;
      return Promise.resolve();
    });
    await flush();

    expect(calls).toBe(2);
  });

  it("cancelAllPrefetches aborts non-matching in-flight and clears queue", async () => {
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

    await flush();
    expect(signals).toHaveLength(2);

    // No keepUrl — all in-flight prefetches are aborted
    cancelAllPrefetches();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queuedFn).not.toHaveBeenCalled();

    a.resolve();
    b.resolve();
    await flush();

    const followUp = vi.fn(() => Promise.resolve());
    enqueuePrefetch("d", followUp);
    await flush();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("cancelAllPrefetches keeps in-flight prefetch matching keepUrl", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals = new Map<string, AbortSignal>();
    const a = deferred();
    const b = deferred();

    // Keys use format "source\0target" — simulate real cache keys
    enqueuePrefetch("http://localhost/\0/product/a", (signal) => {
      signals.set("/product/a", signal);
      return a.promise;
    });
    enqueuePrefetch("http://localhost/\0/product/b", (signal) => {
      signals.set("/product/b", signal);
      return b.promise;
    });

    await flush();
    expect(signals.size).toBe(2);

    // Navigation to /product/b — keep that prefetch, abort the other
    cancelAllPrefetches("/product/b");

    expect(signals.get("/product/a")!.aborted).toBe(true);
    expect(signals.get("/product/b")!.aborted).toBe(false);

    a.resolve();
    b.resolve();
    await flush();
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

    await flush();
    expect(signals).toHaveLength(2);

    abortAllPrefetches();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queuedFn).not.toHaveBeenCalled();

    a.resolve();
    b.resolve();
    await flush();

    const followUp = vi.fn(() => Promise.resolve());
    enqueuePrefetch("d", followUp);
    await flush();
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it("stale drain after cancelAllPrefetches does not execute new items", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    // Hold idle gate open — drain is waiting
    const idleGate = deferred();
    mockWaitForIdle.mockReturnValueOnce(idleGate.promise);

    const firstFn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("a", firstFn);

    // Cancel while the drain is still waiting on idle
    cancelAllPrefetches();

    // Enqueue new work — this schedules a fresh drain
    const secondFn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("b", secondFn);

    // Release the OLD idle gate — stale drain should be a no-op
    idleGate.resolve();
    await flush();

    // Only the fresh drain should have executed "b"
    expect(firstFn).not.toHaveBeenCalled();
    expect(secondFn).toHaveBeenCalledTimes(1);
  });

  it("stale drain after abortAllPrefetches does not execute new items", async () => {
    const { enqueuePrefetch, abortAllPrefetches } =
      await import("../browser/prefetch/queue");

    const idleGate = deferred();
    mockWaitForIdle.mockReturnValueOnce(idleGate.promise);

    const firstFn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("a", firstFn);

    abortAllPrefetches();

    const secondFn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("b", secondFn);

    idleGate.resolve();
    await flush();

    expect(firstFn).not.toHaveBeenCalled();
    expect(secondFn).toHaveBeenCalledTimes(1);
  });

  it("waits for viewport images before draining", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    const imageGate = deferred();
    mockWaitForViewportImages.mockReturnValueOnce(imageGate.promise);
    // Make the timeout race very long so it doesn't interfere
    mockWait.mockReturnValueOnce(new Promise(() => {}));

    const fn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("a", fn);

    // Idle resolves immediately, but images are still loading
    await flush();
    expect(fn).not.toHaveBeenCalled();

    // Images finish
    imageGate.resolve();
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("proceeds after timeout if images are slow", async () => {
    const { enqueuePrefetch } = await import("../browser/prefetch/queue");

    // Images never resolve
    mockWaitForViewportImages.mockReturnValueOnce(new Promise(() => {}));
    // Timeout resolves immediately (simulating 2s elapsed)
    mockWait.mockReturnValueOnce(Promise.resolve());

    const fn = vi.fn(() => Promise.resolve());
    enqueuePrefetch("a", fn);

    await flush();
    // Should have proceeded via the timeout race winner
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
