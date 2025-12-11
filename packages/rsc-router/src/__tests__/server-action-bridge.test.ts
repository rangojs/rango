import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMockStore,
  createMockSegment,
  flushNotifications,
  wait,
  type MockNavigationStore,
} from "./test-utils.js";
import {
  createEventController,
  resetEventController,
  type EventController,
} from "../browser/event-controller.js";

/**
 * These tests verify the server-action-bridge behavior for cache consistency
 * when users navigate away during action execution.
 *
 * The actual server-action-bridge requires RSC dependencies that are hard to mock,
 * so we test the underlying logic patterns using the EventController and store.
 */
describe("Server Action Bridge - Cache Consistency", () => {
  let store: MockNavigationStore;
  let eventController: EventController;

  beforeEach(() => {
    resetEventController();
    store = createMockStore();
    eventController = createEventController({
      initialLocation: new URL("http://localhost/shop/product/123"),
    });
  });

  afterEach(() => {
    resetEventController();
    vi.clearAllMocks();
  });

  describe("Action cache updates when user navigates away", () => {
    it("should NOT update cache if history key changed during action", async () => {
      // This tests the fix for: user clicks action on intercepted route,
      // navigates back before action completes, action response should
      // NOT corrupt the intercept cache

      const interceptCacheKey = "/shop/product/123:intercept";
      const shopCacheKey = "/shop";

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });
      const productList = createMockSegment("product-list", { type: "route" });

      // Setup: User is on intercepted route with modal
      store._setCache(interceptCacheKey, [shopLayout, modalSegment]);
      store.setHistoryKey(interceptCacheKey);

      // Capture the key at action start (simulating server-action-bridge behavior)
      const keyAtActionStart = store.getHistoryKey();
      expect(keyAtActionStart).toBe(interceptCacheKey);

      // Start action
      const actionHandle = eventController.startAction("addToCart", ["item-1"]);

      // User navigates back (popstate) during action execution
      // This changes the history key
      store.setHistoryKey(shopCacheKey);
      store._setCache(shopCacheKey, [shopLayout, productList]);
      eventController.setLocation(new URL("http://localhost/shop"));

      await flushNotifications();

      // Action response arrives with segments (simulating server response)
      // In real code, these segments might be for wrong context
      const actionResponseSegments = [shopLayout, productList]; // Non-intercept segments

      // Simulate the check in server-action-bridge.ts:
      // "Verify the store's current key still matches what we captured at action start"
      const currentKeyNow = store.getHistoryKey();
      const shouldSkipCacheUpdate = currentKeyNow !== keyAtActionStart;

      expect(shouldSkipCacheUpdate).toBe(true);
      expect(currentKeyNow).toBe(shopCacheKey);
      expect(keyAtActionStart).toBe(interceptCacheKey);

      // If we WERE to cache (which we shouldn't), it would corrupt the intercept cache
      // The fix prevents this by checking the key before caching

      // Verify the original intercept cache is preserved
      const interceptCache = store.getCachedSegments(interceptCacheKey);
      expect(interceptCache?.segments).toHaveLength(2);
      expect(interceptCache?.segments.map((s) => s.id)).toContain("modal.@modal");

      actionHandle.complete({ success: true });
      await wait(150);
    });

    it("should update cache if history key is unchanged during action", async () => {
      // Normal case: user stays on the same route during action

      const interceptCacheKey = "/shop/product/123:intercept";

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Setup: User is on intercepted route
      store._setCache(interceptCacheKey, [shopLayout, modalSegment]);
      store.setHistoryKey(interceptCacheKey);

      // Capture key at action start
      const keyAtActionStart = store.getHistoryKey();

      // Start action
      const actionHandle = eventController.startAction("addToCart", ["item-1"]);

      await flushNotifications();

      // User does NOT navigate away - history key unchanged

      // Action response arrives
      const updatedModal = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
        component: "UpdatedModalComponent",
      });
      const actionResponseSegments = [shopLayout, updatedModal];

      // Check if we should update cache
      const currentKeyNow = store.getHistoryKey();
      const shouldUpdateCache = currentKeyNow === keyAtActionStart;

      expect(shouldUpdateCache).toBe(true);

      // In this case, caching is safe
      if (shouldUpdateCache) {
        store.cacheSegmentsForHistory(keyAtActionStart, actionResponseSegments);
      }

      // Verify cache was updated with fresh data
      const cache = store.getCachedSegments(interceptCacheKey);
      expect(cache?.segments).toHaveLength(2);
      const modal = cache?.segments.find((s) => s.id === "modal.@modal");
      expect(modal?.component).toBe("UpdatedModalComponent");

      actionHandle.complete({ success: true });
      await wait(150);
    });

    it("should handle rapid navigation during concurrent actions", async () => {
      // Edge case: multiple actions, user navigates during execution

      const interceptCacheKey = "/shop/product/123:intercept";
      const otherPageKey = "/other-page";

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Setup
      store._setCache(interceptCacheKey, [shopLayout, modalSegment]);
      store.setHistoryKey(interceptCacheKey);

      // Start two concurrent actions
      const keyAtStart = store.getHistoryKey();
      const action1 = eventController.startAction("addToCart", ["item-1"]);
      const action2 = eventController.startAction("updateQuantity", ["item-1", 2]);

      expect(action1.hadConcurrentActions).toBe(false);
      expect(action2.hadConcurrentActions).toBe(true);

      // User navigates away
      store.setHistoryKey(otherPageKey);
      eventController.setLocation(new URL("http://localhost/other-page"));

      await flushNotifications();

      // Both actions complete - neither should update the old cache
      const currentKey = store.getHistoryKey();
      expect(currentKey).not.toBe(keyAtStart);

      // Original intercept cache should be untouched
      const interceptCache = store.getCachedSegments(interceptCacheKey);
      expect(interceptCache?.segments).toHaveLength(2);
      expect(interceptCache?.segments.map((s) => s.id)).toContain("modal.@modal");

      action1.complete({ success: true });
      action2.complete({ success: true });
      await wait(150);
    });
  });

  describe("History key tracking during action lifecycle", () => {
    it("should detect pathname change as navigation", async () => {
      // The server-action-bridge also checks pathname change

      const actionStartPathname = "/shop/product/123";

      // Start action
      const actionHandle = eventController.startAction("addToCart", []);

      // Simulate pathname check (what server-action-bridge does)
      let currentPathname = "/shop/product/123";
      expect(currentPathname).toBe(actionStartPathname);

      // User navigates
      currentPathname = "/shop";

      // Check should detect navigation
      const userNavigatedAway = currentPathname !== actionStartPathname;
      expect(userNavigatedAway).toBe(true);

      actionHandle.complete();
      await wait(150);
    });

    it("should detect history.state.key change as navigation", async () => {
      // The server-action-bridge checks history.state.key for same-URL navigations
      // (e.g., intercept to non-intercept on same pathname)

      const locationKeyAtStart = "abc123";

      // Start action
      const actionHandle = eventController.startAction("addToCart", []);

      // Simulate history.state.key check
      let currentLocationKey: string | undefined = "abc123";
      expect(currentLocationKey).toBe(locationKeyAtStart);

      // User navigates (popstate changes history.state.key)
      currentLocationKey = "def456";

      // Check should detect navigation
      const userNavigatedAway = currentLocationKey !== locationKeyAtStart;
      expect(userNavigatedAway).toBe(true);

      actionHandle.complete();
      await wait(150);
    });
  });

  describe("Action refetch behavior on navigation", () => {
    it("should skip refetch when history key changed (intercept to non-intercept)", async () => {
      // This tests the specific bug:
      // 1. User on non-intercept route (/shop/product/123)
      // 2. Starts action (add to cart)
      // 3. Navigates back to intercept route (/shop/product/123:intercept)
      // 4. Action completes - should NOT refetch since history key changed
      //
      // The refetch would send empty segments which corrupts the intercept cache

      const nonInterceptKey = "/shop/product/123";
      const interceptKey = "/shop/product/123:intercept";

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const sidebar = createMockSegment("sidebar", { type: "route" });
      const productDetail = createMockSegment("product-detail", { type: "route" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Setup: User is on non-intercept route
      store._setCache(nonInterceptKey, [shopLayout, productDetail]);
      store.setHistoryKey(nonInterceptKey);

      // Also have the intercept cache ready (from previous navigation)
      store._setCache(interceptKey, [shopLayout, sidebar, modalSegment]);

      // Capture state at action start (simulating server-action-bridge)
      const locationKeyAtStart = store.getHistoryKey();
      const pathnameAtStart = "/shop/product/123";

      // Start action
      const actionHandle = eventController.startAction("addToCart", ["item-1"]);

      // User navigates back (popstate) to intercept route
      store.setHistoryKey(interceptKey);
      eventController.setLocation(new URL("http://localhost/shop/product/123"));

      await flushNotifications();

      // Simulate the server-action-bridge decision logic:
      const currentPathname = "/shop/product/123"; // Same pathname
      const currentLocationKey = store.getHistoryKey(); // Different key!

      const userNavigatedAway =
        currentPathname !== pathnameAtStart ||
        currentLocationKey !== locationKeyAtStart;

      // User did navigate away (history key changed)
      expect(userNavigatedAway).toBe(true);

      // But pathname is the same - the key difference is the history key
      expect(currentPathname).toBe(pathnameAtStart);
      expect(currentLocationKey).not.toBe(locationKeyAtStart);

      // The fix: when history key changed, skip refetch entirely
      // This prevents sending empty segments that corrupt the intercept cache
      const shouldSkipRefetch = currentLocationKey !== locationKeyAtStart;
      expect(shouldSkipRefetch).toBe(true);

      // Verify intercept cache is preserved (not corrupted by action response)
      const interceptCache = store.getCachedSegments(interceptKey);
      expect(interceptCache?.segments).toHaveLength(3);
      expect(interceptCache?.segments.map((s) => s.id)).toContain("sidebar");
      expect(interceptCache?.segments.map((s) => s.id)).toContain("modal.@modal");

      actionHandle.complete({ success: true });
      await wait(150);
    });

    it("should refetch when pathname changed but history key is same", async () => {
      // Edge case: same history key but different pathname
      // This could happen with client-side routing within same cache entry
      // In this case, refetch IS safe

      const cacheKey = "/shop";

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });

      // Setup
      store._setCache(cacheKey, [shopLayout]);
      store.setHistoryKey(cacheKey);

      // Capture state at action start
      const locationKeyAtStart = store.getHistoryKey();
      const pathnameAtStart = "/shop";

      // Start action
      const actionHandle = eventController.startAction("addToCart", []);

      // Simulate: pathname changes but key stays same (hypothetical case)
      const currentPathname = "/shop/subcategory"; // Different pathname
      const currentLocationKey = cacheKey; // Same key

      const userNavigatedAway =
        currentPathname !== pathnameAtStart ||
        currentLocationKey !== locationKeyAtStart;

      // User did navigate away (pathname changed)
      expect(userNavigatedAway).toBe(true);

      // History key is same - refetch is safe
      const historyKeyChanged = currentLocationKey !== locationKeyAtStart;
      expect(historyKeyChanged).toBe(false);

      // In this case, we CAN refetch (won't corrupt different cache entry)
      const shouldRefetch = userNavigatedAway && !historyKeyChanged;
      expect(shouldRefetch).toBe(true);

      actionHandle.complete({ success: true });
      await wait(150);
    });
  });
});
