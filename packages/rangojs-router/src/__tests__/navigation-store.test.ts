import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createNavigationStore,
  generateHistoryKey,
} from "../browser/navigation-store";

// All tests use crossTabSync: false to avoid BroadcastChannel dependency.
// The store factory accepts an initialLocation so no window.location needed.

function createTestStore(
  overrides?: Parameters<typeof createNavigationStore>[0],
) {
  return createNavigationStore({
    initialLocation: { href: "http://localhost/" },
    crossTabSync: false,
    ...overrides,
  });
}

describe("navigation-store", () => {
  // --------------------------------------------------------------------------
  // generateHistoryKey
  // --------------------------------------------------------------------------
  describe("generateHistoryKey", () => {
    it("extracts pathname + search from a full URL", () => {
      expect(generateHistoryKey("http://example.com/blog?page=2")).toBe(
        "/blog?page=2",
      );
    });

    it("strips hash fragment", () => {
      expect(generateHistoryKey("http://example.com/about#team")).toBe(
        "/about",
      );
    });

    it("appends :intercept suffix when requested", () => {
      expect(
        generateHistoryKey("http://example.com/shop", { intercept: true }),
      ).toBe("/shop:intercept");
    });

    it("handles relative paths using localhost base", () => {
      expect(generateHistoryKey("/products?sort=price")).toBe(
        "/products?sort=price",
      );
    });

    it("returns / for root URL", () => {
      expect(generateHistoryKey("http://example.com/")).toBe("/");
    });
  });

  // --------------------------------------------------------------------------
  // createNavigationStore — initial state
  // --------------------------------------------------------------------------
  describe("initial state", () => {
    it("uses provided initialSegmentIds", () => {
      const store = createTestStore({
        initialSegmentIds: ["L0", "L0R0"],
      });

      expect(store.getSegmentState().currentSegmentIds).toEqual(["L0", "L0R0"]);
    });

    it("caches initial segments if both key and segments provided", () => {
      const segments = [{ id: "R0" }] as any;
      const store = createTestStore({
        initialHistoryKey: "/",
        initialSegments: segments,
      });

      const cached = store.getCachedSegments("/");
      expect(cached).toBeDefined();
      expect(cached!.segments).toBe(segments);
      expect(cached!.stale).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Segment state
  // --------------------------------------------------------------------------
  describe("segment state", () => {
    it("manages path, URL, and segment IDs independently", () => {
      const store = createTestStore({
        initialLocation: { href: "http://localhost/initial" },
      });

      store.setPath("/new-path");
      expect(store.getSegmentState().path).toBe("/new-path");

      store.setCurrentUrl("http://localhost/new-path?q=1");
      expect(store.getSegmentState().currentUrl).toBe(
        "http://localhost/new-path?q=1",
      );

      store.setSegmentIds(["L0", "L0R1"]);
      expect(store.getSegmentState().currentSegmentIds).toEqual(["L0", "L0R1"]);
    });
  });

  // --------------------------------------------------------------------------
  // History cache (FIFO with size limit)
  // --------------------------------------------------------------------------
  describe("history cache", () => {
    it("caches and retrieves segments by key", () => {
      const store = createTestStore();
      const segments = [{ id: "R0" }] as any;

      store.cacheSegmentsForHistory("/page", segments);
      const cached = store.getCachedSegments("/page");

      expect(cached).toBeDefined();
      expect(cached!.segments).toEqual(segments);
      expect(cached!.stale).toBe(false);
    });

    it("returns undefined for uncached keys", () => {
      const store = createTestStore();
      expect(store.getCachedSegments("/unknown")).toBeUndefined();
    });

    it("hasHistoryCache returns correct status", () => {
      const store = createTestStore();
      expect(store.hasHistoryCache("/page")).toBe(false);

      store.cacheSegmentsForHistory("/page", []);
      expect(store.hasHistoryCache("/page")).toBe(true);
    });

    it("updates existing entry in-place", () => {
      const store = createTestStore();
      const segments1 = [{ id: "R0" }] as any;
      const segments2 = [{ id: "R1" }] as any;

      store.cacheSegmentsForHistory("/page", segments1);
      store.cacheSegmentsForHistory("/page", segments2);

      const cached = store.getCachedSegments("/page");
      expect(cached!.segments).toEqual(segments2);
      expect(cached!.stale).toBe(false);
    });

    it("evicts oldest entries when exceeding cache size", () => {
      const store = createTestStore({ cacheSize: 3 });

      store.cacheSegmentsForHistory("/p1", []);
      store.cacheSegmentsForHistory("/p2", []);
      store.cacheSegmentsForHistory("/p3", []);
      store.cacheSegmentsForHistory("/p4", []);

      // p1 should be evicted (FIFO)
      expect(store.getCachedSegments("/p1")).toBeUndefined();
      // p2, p3, p4 should remain
      expect(store.getCachedSegments("/p2")).toBeDefined();
      expect(store.getCachedSegments("/p3")).toBeDefined();
      expect(store.getCachedSegments("/p4")).toBeDefined();
    });

    it("markHistoryCacheStale marks every entry stale (history-only)", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/p1", []);
      store.cacheSegmentsForHistory("/p2", []);

      store.markHistoryCacheStale();

      expect(store.getCachedSegments("/p1")!.stale).toBe(true);
      expect(store.getCachedSegments("/p2")!.stale).toBe(true);
    });

    it("re-caching a stale entry makes it fresh", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", []);
      store.markHistoryCacheStale();
      expect(store.getCachedSegments("/page")!.stale).toBe(true);

      // Re-cache with new data
      store.cacheSegmentsForHistory("/page", [{ id: "new" }] as any);
      expect(store.getCachedSegments("/page")!.stale).toBe(false);
    });

    it("stores and clones handleData", () => {
      const store = createTestStore();
      const handleData = { meta: { seg1: [{ title: "Hello" }] } };

      store.cacheSegmentsForHistory("/page", [], handleData);
      const cached = store.getCachedSegments("/page");

      expect(cached!.handleData).toEqual(handleData);
      // Should be a clone, not the same reference
      expect(cached!.handleData).not.toBe(handleData);
    });

    it("updateCacheHandleData updates handleData for existing entry", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });

      store.updateCacheHandleData("/page", { b: { s2: [2] } });
      const cached = store.getCachedSegments("/page");

      expect(cached!.handleData).toEqual({ b: { s2: [2] } });
    });

    it("updateCacheHandleData is no-op for missing entry", () => {
      const store = createTestStore();
      // Should not throw
      store.updateCacheHandleData("/missing", { a: { s1: [1] } });
    });

    it("updateCacheHandleData preserves the stale flag when stale is omitted", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });
      store.markHistoryCacheStale();
      expect(store.getCachedSegments("/page")!.stale).toBe(true);

      // No stale arg -> current stale flag is preserved.
      store.updateCacheHandleData("/page", { b: { s2: [2] } });
      const cached = store.getCachedSegments("/page");
      expect(cached!.handleData).toEqual({ b: { s2: [2] } });
      expect(cached!.stale).toBe(true);
    });

    it("updateCacheHandleData can mark a single entry stale (deferred-Meta invalidate)", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });
      expect(store.getCachedSegments("/page")!.stale).toBe(false);

      store.updateCacheHandleData("/page", { a: { s1: [1] } }, true);
      expect(store.getCachedSegments("/page")!.stale).toBe(true);
    });

    it("updateCacheHandleData can clear a single entry's stale flag (deferred-Meta resolved)", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });
      store.updateCacheHandleData("/page", { a: { s1: [1] } }, true);
      expect(store.getCachedSegments("/page")!.stale).toBe(true);

      store.updateCacheHandleData("/page", { a: { s1: [9] } }, false);
      const cached = store.getCachedSegments("/page");
      expect(cached!.handleData).toEqual({ a: { s1: [9] } });
      expect(cached!.stale).toBe(false);
    });

    it("fresh commits are not handlesPending", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });
      expect(store.getCachedSegments("/page")!.handlesPending).toBe(false);
    });

    it("updateCacheHandleData sets and clears handlesPending (deferred-Meta pending then resolved)", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });

      // Deferred Meta pending: mark stale + handlesPending.
      store.updateCacheHandleData("/page", { a: { s1: [1] } }, true, true);
      let cached = store.getCachedSegments("/page");
      expect(cached!.stale).toBe(true);
      expect(cached!.handlesPending).toBe(true);

      // Deferred Meta resolved: clear both.
      store.updateCacheHandleData("/page", { a: { s1: [2] } }, false, false);
      cached = store.getCachedSegments("/page");
      expect(cached!.handleData).toEqual({ a: { s1: [2] } });
      expect(cached!.stale).toBe(false);
      expect(cached!.handlesPending).toBe(false);
    });

    it("updateCacheHandleData preserves handlesPending when the flag is omitted", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/page", [], { a: { s1: [1] } });
      store.updateCacheHandleData("/page", { a: { s1: [1] } }, true, true);
      expect(store.getCachedSegments("/page")!.handlesPending).toBe(true);

      // Source re-cache on navigate-away updates only handleData; both flags
      // must survive so a popstate return still forces the full-render reval.
      store.updateCacheHandleData("/page", { a: { s1: [3] } });
      const cached = store.getCachedSegments("/page");
      expect(cached!.handleData).toEqual({ a: { s1: [3] } });
      expect(cached!.stale).toBe(true);
      expect(cached!.handlesPending).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Nav-instance token (per-commit identity; guards URL-only history keys)
  // --------------------------------------------------------------------------
  describe("nav-instance token", () => {
    it("getNavInstance advances on each commit", () => {
      const store = createTestStore();
      const before = store.getNavInstance();
      store.cacheSegmentsForHistory("/a", []);
      const afterA = store.getNavInstance();
      store.cacheSegmentsForHistory("/b", []);
      const afterB = store.getNavInstance();
      expect(afterA).toBeGreaterThan(before);
      expect(afterB).toBeGreaterThan(afterA);
    });

    it("updateCacheHandleData preserves the nav-instance token", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/a", [], { a: { s1: [1] } });
      const token = store.getNavInstance();

      store.updateCacheHandleData("/a", { a: { s1: [2] } }, true);
      expect(store.getNavInstance()).toBe(token);
    });
  });

  // --------------------------------------------------------------------------
  // History key
  // --------------------------------------------------------------------------
  describe("history key", () => {
    it("uses initialHistoryKey when provided", () => {
      const store = createTestStore({ initialHistoryKey: "/custom-key" });
      expect(store.getHistoryKey()).toBe("/custom-key");
    });

    it("setHistoryKey updates the current key", () => {
      const store = createTestStore();
      store.setHistoryKey("/new-key");
      expect(store.getHistoryKey()).toBe("/new-key");
    });
  });

  // --------------------------------------------------------------------------
  // Intercept source URL
  // --------------------------------------------------------------------------
  describe("intercept source URL", () => {
    it("starts as null", () => {
      const store = createTestStore();
      expect(store.getInterceptSourceUrl()).toBeNull();
    });

    it("can be set and cleared", () => {
      const store = createTestStore();
      store.setInterceptSourceUrl("/shop");
      expect(store.getInterceptSourceUrl()).toBe("/shop");

      store.setInterceptSourceUrl(null);
      expect(store.getInterceptSourceUrl()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // UI update subscribers
  // --------------------------------------------------------------------------
  describe("update subscribers", () => {
    it("emits updates to subscribers", () => {
      const store = createTestStore();
      const callback = vi.fn();
      store.onUpdate(callback);

      const update = { root: "test" } as any;
      store.emitUpdate(update);

      expect(callback).toHaveBeenCalledWith(update);
    });

    it("unsubscribe prevents further updates", () => {
      const store = createTestStore();
      const callback = vi.fn();
      const unsub = store.onUpdate(callback);

      unsub();
      store.emitUpdate({ root: "test" } as any);

      expect(callback).not.toHaveBeenCalled();
    });

    it("notifies multiple subscribers", () => {
      const store = createTestStore();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      store.onUpdate(cb1);
      store.onUpdate(cb2);

      store.emitUpdate({ root: "x" } as any);

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });
});
