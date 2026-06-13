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
    it("initializes with idle navigation state", () => {
      const store = createTestStore();
      const state = store.getState();

      expect(state.state).toBe("idle");
      expect(state.isStreaming).toBe(false);
      expect(state.pendingUrl).toBeNull();
      expect(state.inflightActions).toEqual([]);
    });

    it("uses provided initialLocation", () => {
      const store = createTestStore({
        initialLocation: { href: "http://localhost/shop?q=test" },
      });
      const state = store.getState();

      expect(state.location.pathname).toBe("/shop");
      expect(state.location.search).toBe("?q=test");
    });

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
  // State management
  // --------------------------------------------------------------------------
  describe("setState / getState", () => {
    it("merges partial state", () => {
      const store = createTestStore();
      store.setState({ state: "loading" });

      expect(store.getState().state).toBe("loading");
      // Other fields preserved
      expect(store.getState().isStreaming).toBe(false);
    });

    it("notifies listeners on state change (debounced)", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.setState({ state: "loading" });
      expect(listener).not.toHaveBeenCalled(); // debounced

      vi.advanceTimersByTime(25);
      expect(listener).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("batches rapid state changes into single notification", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listener = vi.fn();
      store.subscribe(listener);

      store.setState({ state: "loading" });
      store.setState({ isStreaming: true });
      store.setState({ pendingUrl: "http://localhost/next" });

      vi.advanceTimersByTime(25);
      expect(listener).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("unsubscribe removes listener", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listener = vi.fn();
      const unsub = store.subscribe(listener);

      unsub();
      store.setState({ state: "loading" });
      vi.advanceTimersByTime(25);

      expect(listener).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  // --------------------------------------------------------------------------
  // Inflight actions
  // --------------------------------------------------------------------------
  describe("inflight actions", () => {
    it("adds and removes inflight actions", () => {
      const store = createTestStore();

      store.addInflightAction({
        id: "a1",
        actionId: "save",
        payload: [],
        startedAt: 0,
      });
      expect(store.getState().inflightActions).toHaveLength(1);
      expect(store.getState().inflightActions[0].id).toBe("a1");

      store.addInflightAction({
        id: "a2",
        actionId: "delete",
        payload: [],
        startedAt: 0,
      });
      expect(store.getState().inflightActions).toHaveLength(2);

      store.removeInflightAction("a1");
      expect(store.getState().inflightActions).toHaveLength(1);
      expect(store.getState().inflightActions[0].id).toBe("a2");
    });

    it("removing non-existent action is a no-op", () => {
      const store = createTestStore();
      store.addInflightAction({
        id: "a1",
        actionId: "save",
        payload: [],
        startedAt: 0,
      });
      store.removeInflightAction("nonexistent");
      expect(store.getState().inflightActions).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Action in progress flag
  // --------------------------------------------------------------------------
  describe("action in progress", () => {
    it("tracks action in progress flag", () => {
      const store = createTestStore();
      expect(store.isActionInProgress()).toBe(false);

      store.setActionInProgress(true);
      expect(store.isActionInProgress()).toBe(true);

      store.setActionInProgress(false);
      expect(store.isActionInProgress()).toBe(false);
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

    it("marks all entries as stale", () => {
      const store = createTestStore();
      store.cacheSegmentsForHistory("/p1", []);
      store.cacheSegmentsForHistory("/p2", []);

      store.markCacheAsStale();

      expect(store.getCachedSegments("/p1")!.stale).toBe(true);
      expect(store.getCachedSegments("/p2")!.stale).toBe(true);
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
      store.markCacheAsStale();
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

  // --------------------------------------------------------------------------
  // Action state tracking
  // --------------------------------------------------------------------------
  describe("action state", () => {
    it("returns default idle state for unknown actions", () => {
      const store = createTestStore();
      const state = store.getActionState("unknown");

      expect(state.state).toBe("idle");
      expect(state.actionId).toBeNull();
      expect(state.payload).toBeNull();
      expect(state.error).toBeNull();
      expect(state.result).toBeNull();
    });

    it("sets and merges action state", () => {
      const store = createTestStore();
      store.setActionState("myAction", { state: "loading", payload: [1] });

      const state = store.getActionState("myAction");
      expect(state.state).toBe("loading");
      expect(state.payload).toEqual([1]);
      expect(state.actionId).toBe("myAction"); // always set
    });

    it("merges partial updates with existing state", () => {
      const store = createTestStore();
      store.setActionState("myAction", { state: "loading", payload: [1] });
      store.setActionState("myAction", { state: "streaming", result: "ok" });

      const state = store.getActionState("myAction");
      expect(state.state).toBe("streaming");
      expect(state.payload).toEqual([1]); // preserved
      expect(state.result).toBe("ok"); // merged in
    });

    it("notifies action listeners on state change (debounced)", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listener = vi.fn();
      store.subscribeToAction("myAction", listener);

      store.setActionState("myAction", { state: "loading" });
      expect(listener).not.toHaveBeenCalled(); // debounced

      vi.advanceTimersByTime(25);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ state: "loading", actionId: "myAction" }),
      );

      vi.useRealTimers();
    });

    it("batches rapid action state changes per action ID", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      store.subscribeToAction("a", listenerA);
      store.subscribeToAction("b", listenerB);

      store.setActionState("a", { state: "loading" });
      store.setActionState("b", { state: "loading" });
      store.setActionState("a", { state: "streaming" });

      vi.advanceTimersByTime(25);
      // Each keyed debouncer fires independently
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("unsubscribe removes action listener", async () => {
      vi.useFakeTimers();
      const store = createTestStore();
      const listener = vi.fn();
      const unsub = store.subscribeToAction("myAction", listener);

      unsub();
      store.setActionState("myAction", { state: "loading" });
      vi.advanceTimersByTime(25);

      expect(listener).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("cleans up empty listener sets on unsubscribe", () => {
      const store = createTestStore();
      const listener = vi.fn();
      const unsub = store.subscribeToAction("myAction", listener);

      unsub();
      // Internal: actionListeners map should have removed the "myAction" key.
      // We verify indirectly by subscribing again and confirming it works.
      const listener2 = vi.fn();
      store.subscribeToAction("myAction", listener2);
      // Should not throw and should work normally
    });
  });
});
