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

  it("respects a configured concurrency limit above the default", async () => {
    const { enqueuePrefetch, setPrefetchConcurrency } =
      await import("../browser/prefetch/queue");

    setPrefetchConcurrency(3);

    const started: string[] = [];
    const gates = [deferred(), deferred(), deferred(), deferred()];
    ["a", "b", "c", "d"].forEach((k, i) => {
      enqueuePrefetch(k, () => {
        started.push(k);
        return gates[i].promise;
      });
    });

    await flush();
    // 3 run concurrently now (was 2); the 4th waits for a slot.
    expect(started).toEqual(["a", "b", "c"]);

    gates[0].resolve();
    await flush();
    expect(started).toEqual(["a", "b", "c", "d"]);

    gates.forEach((g) => g.resolve());
    await flush();
  });

  it("ignores a sub-1 concurrency and keeps the default of 2", async () => {
    const { enqueuePrefetch, setPrefetchConcurrency } =
      await import("../browser/prefetch/queue");

    setPrefetchConcurrency(0); // invalid: default of 2 is kept

    const started: string[] = [];
    const gates = [deferred(), deferred(), deferred()];
    ["a", "b", "c"].forEach((k, i) => {
      enqueuePrefetch(k, () => {
        started.push(k);
        return gates[i].promise;
      });
    });

    await flush();
    expect(started).toEqual(["a", "b"]);

    gates.forEach((g) => g.resolve());
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

    // Wildcard key: "rangoState\0/target"
    enqueuePrefetch("v1:abc\0/product/a", (signal) => {
      signals.set("/product/a", signal);
      return a.promise;
    });
    enqueuePrefetch("v1:abc\0/product/b", (signal) => {
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

  it("cancelAllPrefetches keeps matching source-scoped prefetch (3-segment key)", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals = new Map<string, AbortSignal>();
    const a = deferred();
    const b = deferred();

    // Source-scoped key shape: "rangoState\0sourceHref\0/target".
    // The middle segment is the source URL — extracting it as the target
    // (old [1] indexing) would mismatch keepUrl and wrongly abort.
    enqueuePrefetch("v1:abc\0http://localhost/home\0/product/a", (signal) => {
      signals.set("/product/a", signal);
      return a.promise;
    });
    enqueuePrefetch("v1:abc\0http://localhost/home\0/product/b", (signal) => {
      signals.set("/product/b", signal);
      return b.promise;
    });

    await flush();
    expect(signals.size).toBe(2);

    cancelAllPrefetches("/product/b");

    expect(signals.get("/product/a")!.aborted).toBe(true);
    expect(signals.get("/product/b")!.aborted).toBe(false);

    a.resolve();
    b.resolve();
    await flush();
  });

  it("cancelAllPrefetches matches real keys with _rsc_* params (source-scoped)", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals = new Map<string, AbortSignal>();
    const a = deferred();
    const b = deferred();

    // Real-world shape: target segment includes the internal _rsc_* params
    // that prefetch/fetch.ts buildPrefetchUrl appends. keepUrl comes from
    // NavigationProvider's pendingUrl as a bare navigation URL — the match
    // must strip internal params on both sides before comparing.
    enqueuePrefetch(
      "v1:abc\0http://localhost/home\0/product/a?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1",
      (signal) => {
        signals.set("/product/a", signal);
        return a.promise;
      },
    );
    enqueuePrefetch(
      "v1:abc\0http://localhost/home\0/product/b?_rsc_partial=true&_rsc_segments=A0&_rsc_v=v1",
      (signal) => {
        signals.set("/product/b", signal);
        return b.promise;
      },
    );

    await flush();
    expect(signals.size).toBe(2);

    cancelAllPrefetches("/product/b");

    expect(signals.get("/product/a")!.aborted).toBe(true);
    expect(signals.get("/product/b")!.aborted).toBe(false);

    a.resolve();
    b.resolve();
    await flush();
  });

  it("cancelAllPrefetches preserves user-facing query params when matching", async () => {
    const { enqueuePrefetch, cancelAllPrefetches } =
      await import("../browser/prefetch/queue");

    const signals = new Map<string, AbortSignal>();
    const a = deferred();
    const b = deferred();

    // Two prefetches for the same pathname, different user search params.
    // keepUrl has user params but no internal params. Only the prefetch
    // whose non-internal search params match should be kept.
    enqueuePrefetch(
      "v1:abc\0/search?q=apples&_rsc_partial=true&_rsc_segments=A0",
      (signal) => {
        signals.set("apples", signal);
        return a.promise;
      },
    );
    enqueuePrefetch(
      "v1:abc\0/search?q=oranges&_rsc_partial=true&_rsc_segments=A0",
      (signal) => {
        signals.set("oranges", signal);
        return b.promise;
      },
    );

    await flush();
    expect(signals.size).toBe(2);

    cancelAllPrefetches("/search?q=oranges");

    expect(signals.get("apples")!.aborted).toBe(true);
    expect(signals.get("oranges")!.aborted).toBe(false);

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
