import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("prefetch cache invalidation subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("notifies the current subscribers asynchronously", async () => {
    const {
      notifyPrefetchCacheInvalidated,
      subscribeToPrefetchCacheInvalidation,
    } = await import("../browser/prefetch/invalidation.js");
    const listener = vi.fn();
    const cleanup = subscribeToPrefetchCacheInvalidation(listener);

    notifyPrefetchCacheInvalidated();
    expect(listener).not.toHaveBeenCalled();

    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    cleanup();
  });

  it("skips stale subscriptions and listeners added after invalidation", async () => {
    const {
      notifyPrefetchCacheInvalidated,
      subscribeToPrefetchCacheInvalidation,
    } = await import("../browser/prefetch/invalidation.js");
    const stale = vi.fn();
    const cleanupStale = subscribeToPrefetchCacheInvalidation(stale);

    notifyPrefetchCacheInvalidated();
    cleanupStale();
    cleanupStale();
    const late = vi.fn();
    const cleanupLate = subscribeToPrefetchCacheInvalidation(late);

    await Promise.resolve();
    expect(stale).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
    cleanupLate();
  });

  it("notifies later subscribers before surfacing a callback failure", async () => {
    vi.stubGlobal("queueMicrotask", (callback: () => void) => callback());
    const {
      notifyPrefetchCacheInvalidated,
      subscribeToPrefetchCacheInvalidation,
    } = await import("../browser/prefetch/invalidation.js");
    const failure = new Error("listener failed");
    const cleanupThrowing = subscribeToPrefetchCacheInvalidation(() => {
      throw failure;
    });
    const later = vi.fn();
    const cleanupLater = subscribeToPrefetchCacheInvalidation(later);

    expect(() => notifyPrefetchCacheInvalidated()).toThrow(failure);
    expect(later).toHaveBeenCalledOnce();
    cleanupThrowing();
    cleanupLater();
  });
});
