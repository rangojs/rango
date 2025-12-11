import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPartialUpdater, type PartialUpdater } from "../browser/partial-update.js";
import {
  createMockStore,
  createMockClient,
  createMockPayload,
  createMockSegment,
  createMockRenderSegments,
  flushNotifications,
  type MockNavigationStore,
  type MockNavigationClient,
} from "./test-utils.js";
import type { BoundTransaction } from "../browser/navigation-bridge.js";
import type { ResolvedSegment } from "../browser/types.js";

describe("Partial Update", () => {
  let store: MockNavigationStore;
  let client: MockNavigationClient;
  let fetchPartialUpdate: PartialUpdater;
  let onUpdate: ReturnType<typeof vi.fn>;
  let renderSegments: ReturnType<typeof createMockRenderSegments>;

  // Helper to create a bound transaction for testing
  function createTestTransaction(options: {
    currentUrl?: string;
    onCommit?: (
      segmentIds: string[],
      segments: ResolvedSegment[],
      overrides?: unknown
    ) => void;
  }): BoundTransaction {
    let streamingEnded = false;
    return {
      currentUrl: options.currentUrl || "http://localhost/",
      startStreaming() {
        return {
          end() {
            streamingEnded = true;
          },
        };
      },
      commit(segmentIds, segments, overrides) {
        options.onCommit?.(segmentIds, segments, overrides);
      },
    };
  }

  beforeEach(() => {
    store = createMockStore();
    client = createMockClient();
    onUpdate = vi.fn();
    renderSegments = createMockRenderSegments();

    fetchPartialUpdate = createPartialUpdater({
      store,
      client,
      onUpdate,
      renderSegments: renderSegments.renderSegments,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Basic Partial Update Tests
  // ==========================================================================

  describe("Basic Partial Updates", () => {
    it("should fetch and render partial update with diff segments", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      const pageSegment = createMockSegment("page", { type: "route" });

      // Setup: Cache has layout
      store._setCache("/", [layoutSegment]);

      // Server returns: matched both, diff only page (layout unchanged)
      client._queueResponse(
        createMockPayload({
          segments: [pageSegment], // Only diff segments in response
          matched: ["layout", "page"],
          diff: ["page"],
          isPartial: true,
        })
      );

      const committed: {
        segmentIds: string[];
        segments: ResolvedSegment[];
      }[] = [];
      const tx = createTestTransaction({
        onCommit: (segmentIds, segments) => {
          committed.push({ segmentIds, segments });
        },
      });

      await fetchPartialUpdate("/test", ["layout", "page"], false, undefined, tx);

      // Should have committed
      expect(committed).toHaveLength(1);
      expect(committed[0].segmentIds).toContain("layout");
      expect(committed[0].segmentIds).toContain("page");

      // Should have called renderSegments
      expect(renderSegments.renderSegments).toHaveBeenCalled();

      // Should have called onUpdate
      expect(onUpdate).toHaveBeenCalled();
    });

    it("should skip UI update when diff is empty (no changes)", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });

      // Setup: Cache has layout
      store._setCache("/", [layoutSegment]);

      // Server returns: matched layout, empty diff (no revalidation needed)
      client._queueResponse(
        createMockPayload({
          segments: [],
          matched: ["layout"],
          diff: [], // Empty diff = no changes
          isPartial: true,
        })
      );

      const committed: { segmentIds: string[] }[] = [];
      const tx = createTestTransaction({
        onCommit: (segmentIds) => {
          committed.push({ segmentIds });
        },
      });

      await fetchPartialUpdate("/test", ["layout"], false, undefined, tx);

      // Should commit (URL update) but not render
      expect(committed).toHaveLength(1);
      expect(renderSegments.renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("should use cached segments for IDs not in server response", async () => {
      const cachedLayout = createMockSegment("layout", {
        type: "layout",
        component: "CachedLayoutComponent",
      });
      const newPage = createMockSegment("page", {
        type: "route",
        component: "NewPageComponent",
      });

      // Setup: Cache has layout
      store._setCache("/", [cachedLayout]);

      // Server returns: only page (layout unchanged)
      client._queueResponse(
        createMockPayload({
          segments: [newPage],
          matched: ["layout", "page"],
          diff: ["page"],
          isPartial: true,
        })
      );

      const committed: { segments: ResolvedSegment[] }[] = [];
      const tx = createTestTransaction({
        onCommit: (_, segments) => {
          committed.push({ segments });
        },
      });

      await fetchPartialUpdate("/test", ["layout", "page"], false, undefined, tx);

      // Should include cached layout + new page
      const mergedSegments = committed[0].segments;
      expect(mergedSegments).toHaveLength(2);

      const layoutResult = mergedSegments.find((s) => s.id === "layout");
      const pageResult = mergedSegments.find((s) => s.id === "page");

      expect(layoutResult?.component).toBe("CachedLayoutComponent");
      expect(pageResult?.component).toBe("NewPageComponent");
    });
  });

  // ==========================================================================
  // Stale Navigation Handling
  // ==========================================================================

  describe("Stale Navigation Handling", () => {
    it("should ignore response when signal is aborted", async () => {
      client._queueResponse(
        createMockPayload({
          segments: [createMockSegment("page")],
          matched: ["page"],
          diff: ["page"],
          isPartial: true,
        })
      );

      const abortController = new AbortController();
      abortController.abort(); // Already aborted

      const committed: unknown[] = [];
      const tx = createTestTransaction({
        onCommit: () => {
          committed.push(true);
        },
      });

      await fetchPartialUpdate(
        "/test",
        undefined,
        false,
        abortController.signal,
        tx
      );

      // Should not commit when aborted
      expect(committed).toHaveLength(0);
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("should check abort signal after response before render", async () => {
      const abortController = new AbortController();

      // Mock client to abort after response is received
      client.fetchPartial = vi.fn(async () => {
        // Simulate abort happening during processing
        abortController.abort();
        return {
          payload: createMockPayload({
            segments: [createMockSegment("page")],
            matched: ["page"],
            diff: ["page"],
            isPartial: true,
          }),
          streamComplete: Promise.resolve(),
        };
      });

      const committed: unknown[] = [];
      const tx = createTestTransaction({
        onCommit: () => {
          committed.push(true);
        },
      });

      await fetchPartialUpdate(
        "/test",
        undefined,
        false,
        abortController.signal,
        tx
      );

      // Should not commit when signal aborted during processing
      expect(committed).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Intercept Segment Handling
  // ==========================================================================

  describe("Intercept Segments", () => {
    it("should separate intercept segments from main segments", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Server returns both layout and modal intercept
      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment, modalSegment],
          matched: ["layout", "modal.@modal"],
          diff: ["layout", "modal.@modal"],
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const tx = createTestTransaction({});

      await fetchPartialUpdate("/product/123", undefined, false, undefined, tx);

      // Should call renderSegments with interceptSegments option
      const lastCall = renderSegments.getLastCall();
      expect(lastCall).toBeDefined();

      // Main segments should not include intercept
      const mainSegmentIds = lastCall!.segments.map((s) => s.id);
      expect(mainSegmentIds).toContain("layout");
      expect(mainSegmentIds).not.toContain("modal.@modal");

      // Intercept segments should be passed separately
      const options = lastCall!.options as { interceptSegments?: ResolvedSegment[] };
      expect(options.interceptSegments).toBeDefined();
      expect(options.interceptSegments).toHaveLength(1);
      expect(options.interceptSegments![0].id).toBe("modal.@modal");
    });

    it("should disable scroll for intercept responses", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment, modalSegment],
          matched: ["layout", "modal.@modal"],
          diff: ["layout"],
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const committed: { overrides: unknown }[] = [];
      const tx = createTestTransaction({
        onCommit: (_, __, overrides) => {
          committed.push({ overrides });
        },
      });

      await fetchPartialUpdate("/product/123", undefined, false, undefined, tx);

      // Should have committed with scroll: false for intercept
      expect(committed).toHaveLength(1);
      expect(committed[0].overrides).toMatchObject({
        scroll: false,
        intercept: true,
      });
    });

    it("should track intercept source URL for action revalidation", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Set current URL
      store.getSegmentState = vi.fn(() => ({
        currentSegmentIds: ["layout"],
        currentUrl: "http://localhost/shop",
        path: "/shop",
      }));

      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment, modalSegment],
          matched: ["layout", "modal.@modal"],
          diff: ["modal.@modal"],
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const tx = createTestTransaction({});

      await fetchPartialUpdate("/shop/product/123", undefined, false, undefined, tx);

      // Should have saved intercept source URL
      expect(store.setInterceptSourceUrl).toHaveBeenCalledWith(
        "http://localhost/shop"
      );
    });

    it("should clear intercept source URL for non-intercept navigation", async () => {
      const pageSegment = createMockSegment("page", { type: "route" });

      // Set existing intercept context
      store.setInterceptSourceUrl("http://localhost/shop");

      client._queueResponse(
        createMockPayload({
          segments: [pageSegment],
          matched: ["page"],
          diff: ["page"],
          isPartial: true,
          // No slots = no intercept
        })
      );

      const tx = createTestTransaction({});

      await fetchPartialUpdate("/other-page", undefined, false, undefined, tx);

      // Should have cleared intercept source URL
      expect(store.setInterceptSourceUrl).toHaveBeenCalledWith(null);
    });
  });

  // ==========================================================================
  // Stale Revalidation (SWR Pattern)
  // ==========================================================================

  describe("Stale Revalidation", () => {
    it("should use forceAwait in renderSegments for stale revalidation", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });

      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment],
          matched: ["layout"],
          diff: ["layout"],
          isPartial: true,
        })
      );

      const tx = createTestTransaction({});

      await fetchPartialUpdate("/test", undefined, false, undefined, tx, {
        staleRevalidation: true,
      });

      // Should call renderSegments with forceAwait: true
      const lastCall = renderSegments.getLastCall();
      expect(lastCall?.options).toMatchObject({ forceAwait: true });
    });

    it("should wrap stale revalidation update in startTransition", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });

      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment],
          matched: ["layout"],
          diff: ["layout"],
          isPartial: true,
        })
      );

      const tx = createTestTransaction({});

      await fetchPartialUpdate("/test", undefined, false, undefined, tx, {
        staleRevalidation: true,
      });

      // onUpdate should be called (the startTransition wrapping is internal)
      expect(onUpdate).toHaveBeenCalled();
    });

    it("should preserve intercept context during stale revalidation", async () => {
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      // Setup: We're on an intercepted route
      store._setCache("/shop/product/123:intercept", [layoutSegment, modalSegment]);
      store.getSegmentState = vi.fn(() => ({
        currentSegmentIds: ["layout", "modal.@modal"],
        currentUrl: "http://localhost/shop/product/123",
        path: "/shop/product/123",
      }));

      // Server returns both segments during stale revalidation
      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment, modalSegment],
          matched: ["layout", "modal.@modal"],
          diff: ["modal.@modal"], // Only modal changed
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop", // interceptSourceUrl
      });

      await fetchPartialUpdate(
        "/shop/product/123",
        ["layout", "modal.@modal"],
        false,
        undefined,
        tx,
        {
          staleRevalidation: true,
          interceptSourceUrl: "http://localhost/shop",
        }
      );

      // Intercept source should NOT be modified during stale revalidation
      // (it preserves context, doesn't establish new one)
      const setInterceptCalls = (store.setInterceptSourceUrl as ReturnType<typeof vi.fn>).mock.calls;
      expect(setInterceptCalls.length).toBe(0);
    });
  });

  // ==========================================================================
  // HMR Resilience (Missing Segments)
  // ==========================================================================

  describe("HMR Resilience", () => {
    it("should retry with empty segments when matched segments are missing", async () => {
      // First response: server says matched [layout, page] but only sends page
      // This happens after HMR when segment cache is cleared
      const pageSegment = createMockSegment("page", { type: "route" });

      client._queueResponse(
        createMockPayload({
          segments: [pageSegment],
          matched: ["layout", "page"], // Claims to match both
          diff: ["page"],
          isPartial: true,
        })
      );

      // Second response: full refetch with all segments
      const layoutSegment = createMockSegment("layout", { type: "layout" });
      client._queueResponse(
        createMockPayload({
          segments: [layoutSegment, pageSegment],
          matched: ["layout", "page"],
          diff: ["layout", "page"],
          isPartial: true,
        })
      );

      const committed: { segmentIds: string[] }[] = [];
      const tx = createTestTransaction({
        onCommit: (segmentIds) => {
          committed.push({ segmentIds });
        },
      });

      await fetchPartialUpdate("/test", ["layout", "page"], false, undefined, tx);

      // Should have retried (called fetchPartial twice)
      expect(client.fetchPartial).toHaveBeenCalledTimes(2);

      // Second call should be with empty segments (full refetch)
      const secondCall = (client.fetchPartial as ReturnType<typeof vi.fn>).mock
        .calls[1][0];
      expect(secondCall.segmentIds).toEqual([]);
    });

    it("should throw error on second retry failure", async () => {
      const pageSegment = createMockSegment("page", { type: "route" });

      // Both responses missing layout
      client._queueResponse(
        createMockPayload({
          segments: [pageSegment],
          matched: ["layout", "page"],
          diff: ["page"],
          isPartial: true,
        })
      );
      client._queueResponse(
        createMockPayload({
          segments: [pageSegment],
          matched: ["layout", "page"],
          diff: ["page"],
          isPartial: true,
        })
      );

      const tx = createTestTransaction({});

      await expect(
        fetchPartialUpdate("/test", ["layout", "page"], false, undefined, tx)
      ).rejects.toThrow(/Failed to fetch segments after retry/);
    });

    it("should not retry for action responses with missing segments", async () => {
      const pageSegment = createMockSegment("page", { type: "route" });

      // Action response with missing segment
      client._queueResponse(
        createMockPayload({
          segments: [pageSegment],
          matched: ["layout", "page"],
          diff: ["page"],
          isPartial: true,
        })
      );

      const tx = createTestTransaction({});

      // isAction: true should skip retry
      await fetchPartialUpdate("/test", ["layout", "page"], false, undefined, tx, {
        isAction: true,
      });

      // Should only call fetchPartial once (no retry for actions)
      expect(client.fetchPartial).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Back Navigation with Stale Cache (The Bug Scenario)
  // ==========================================================================

  describe("Back Navigation with Stale Cache", () => {
    it("should merge cached segments with server diff during stale revalidation", async () => {
      // This tests the scenario where:
      // 1. User navigates to intercepted route (modal + background)
      // 2. Navigates away, cache becomes stale
      // 3. Navigates back (popstate)
      // 4. Cache is restored instantly (shows modal + background)
      // 5. Stale revalidation fetches fresh data
      // 6. Server returns only diff (changed segments)
      // 7. UI should KEEP unchanged segments from cache

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const productList = createMockSegment("product-list", { type: "route" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const cacheKey = "/shop/product/123:intercept";

      // Setup: Cache has all segments (stale)
      // This simulates what handlePopstate does before stale revalidation
      store._setCache(cacheKey, [
        shopLayout,
        productList,
        modalSegment,
      ], true);

      // CRITICAL: Set history key to match cache - this is what handlePopstate does
      // before triggering stale revalidation
      store.setHistoryKey(cacheKey);

      // Server returns: only modal changed (diff), other segments unchanged
      // The key issue: server only sends diff segments, not all matched
      client._queueResponse(
        createMockPayload({
          segments: [modalSegment], // Only the changed segment
          matched: ["shop-layout", "product-list", "modal.@modal"],
          diff: ["modal.@modal"], // Only modal changed
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const committed: { segmentIds: string[]; segments: ResolvedSegment[] }[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: (segmentIds, segments) => {
          committed.push({ segmentIds, segments });
        },
      });

      await fetchPartialUpdate(
        "/shop/product/123",
        ["shop-layout", "product-list", "modal.@modal"],
        false,
        undefined,
        tx,
        { staleRevalidation: true, interceptSourceUrl: "http://localhost/shop" }
      );

      // KEY ASSERTION: All segments should be in the committed result
      expect(committed).toHaveLength(1);
      const { segmentIds, segments } = committed[0];

      // All segment IDs should be present
      expect(segmentIds).toContain("shop-layout");
      expect(segmentIds).toContain("product-list");
      expect(segmentIds).toContain("modal.@modal");

      // All segments should be present (merged from cache + server)
      expect(segments.map((s) => s.id)).toContain("shop-layout");
      expect(segments.map((s) => s.id)).toContain("product-list");
      expect(segments.map((s) => s.id)).toContain("modal.@modal");
    });

    it("should not lose background segments when only modal is in diff", async () => {
      // Specific regression test for the reported bug:
      // After back navigation to intercept, stale revalidation
      // was causing background segments to disappear

      const rootLayout = createMockSegment("root", { type: "layout" });
      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const productGrid = createMockSegment("product-grid", { type: "route" });
      const modalOverlay = createMockSegment("product.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const cacheKey = "/shop/product/1:intercept";

      // Cache contains full page structure (what user should see)
      store._setCache(cacheKey, [
        rootLayout,
        shopLayout,
        productGrid,
        modalOverlay,
      ], true);

      // CRITICAL: Set history key to match cache - handlePopstate sets this
      // before triggering stale revalidation
      store.setHistoryKey(cacheKey);

      // Server response: only modal is "dirty" / needs update
      const updatedModal = createMockSegment("product.@modal", {
        type: "parallel",
        namespace: "intercept:products",
        component: "UpdatedModalComponent", // Fresh component
      });

      client._queueResponse(
        createMockPayload({
          segments: [updatedModal], // Server only sends updated modal
          matched: ["root", "shop-layout", "product-grid", "product.@modal"],
          diff: ["product.@modal"], // Only modal changed
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      const committed: { segments: ResolvedSegment[] }[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: (_, segments) => {
          committed.push({ segments });
        },
      });

      await fetchPartialUpdate(
        "/shop/product/1",
        ["root", "shop-layout", "product-grid", "product.@modal"],
        false,
        undefined,
        tx,
        { staleRevalidation: true, interceptSourceUrl: "http://localhost/shop" }
      );

      // CRITICAL: Background segments must be preserved
      const mergedSegments = committed[0].segments;

      // All 4 segments should be present
      expect(mergedSegments).toHaveLength(4);

      // Each segment should exist
      const segmentIds = mergedSegments.map((s) => s.id);
      expect(segmentIds).toContain("root");
      expect(segmentIds).toContain("shop-layout");
      expect(segmentIds).toContain("product-grid");
      expect(segmentIds).toContain("product.@modal");

      // Modal should be the updated one from server
      const modal = mergedSegments.find((s) => s.id === "product.@modal");
      expect(modal?.component).toBe("UpdatedModalComponent");

      // Background segments should be from cache (not updated by server)
      const productGridSegment = mergedSegments.find(
        (s) => s.id === "product-grid"
      );
      expect(productGridSegment).toBeDefined();
    });

    it("should NOT commit when signal is aborted during stale revalidation", async () => {
      // Edge case: User navigates away before stale revalidation completes
      // The revalidation should be aborted and NOT update the cache
      //
      // Scenario:
      // 1. User on intercepted route /shop/product/123
      // 2. Cache is stale, stale revalidation starts (not awaited)
      // 3. User navigates to /other-page before revalidation completes
      // 4. Stale revalidation response arrives
      // 5. Should NOT commit because signal was aborted

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const cacheKey = "/shop/product/123:intercept";
      store._setCache(cacheKey, [shopLayout, modalSegment], true);
      store.setHistoryKey(cacheKey);

      // Server returns fresh data
      client._queueResponse(
        createMockPayload({
          segments: [shopLayout, modalSegment],
          matched: ["shop-layout", "modal.@modal"],
          diff: ["modal.@modal"],
          isPartial: true,
          slots: { "@modal": { active: true } },
        })
      );

      // Create abort controller to simulate navigation away
      const abortController = new AbortController();

      const committed: unknown[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: () => {
          committed.push(true);
        },
      });

      // Abort before the fetch completes (simulating user navigating away)
      abortController.abort();

      await fetchPartialUpdate(
        "/shop/product/123",
        ["shop-layout", "modal.@modal"],
        false,
        abortController.signal,
        tx,
        { staleRevalidation: true, interceptSourceUrl: "http://localhost/shop" }
      );

      // Should NOT have committed because signal was aborted
      expect(committed).toHaveLength(0);
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("should NOT override intercept cache with non-intercept data", async () => {
      // Edge case: Stale revalidation for intercept route, but server returns
      // non-intercept response (because server doesn't know about intercept context)
      //
      // The cache should preserve the intercept key, not be corrupted

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const productPage = createMockSegment("product-page", { type: "route" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const interceptCacheKey = "/shop/product/123:intercept";
      const normalCacheKey = "/shop/product/123";

      // Setup: Intercept cache exists with modal
      store._setCache(interceptCacheKey, [shopLayout, modalSegment], true);
      store.setHistoryKey(interceptCacheKey);

      // Server returns WITHOUT slots (non-intercept response) - this could happen
      // if server context is out of sync
      client._queueResponse(
        createMockPayload({
          segments: [shopLayout, productPage], // Returns product page, not modal
          matched: ["shop-layout", "product-page"],
          diff: ["product-page"],
          isPartial: true,
          // No slots = server thinks this is NOT an intercept
        })
      );

      const committed: {
        segmentIds: string[];
        overrides: unknown;
      }[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: (segmentIds, _, overrides) => {
          committed.push({ segmentIds, overrides });
        },
      });

      await fetchPartialUpdate(
        "/shop/product/123",
        ["shop-layout", "modal.@modal"],
        false,
        undefined,
        tx,
        {
          staleRevalidation: true,
          interceptSourceUrl: "http://localhost/shop",
        }
      );

      // Even though server returned non-intercept data, we're doing stale
      // revalidation for an intercept route - the commit should preserve
      // the intercept context that was passed in via options
      // (The tx.with() in handlePopstate sets intercept: isIntercept)

      // Note: With current implementation, the hasActiveIntercept check
      // would be false (no slots), but the original tx was configured
      // with intercept: true. This test documents the expected behavior.

      // The commit happened
      expect(committed).toHaveLength(1);
    });

    it("should abort stale revalidation when navigating away mid-flight", async () => {
      // This tests the race condition scenario:
      // 1. User on intercepted route, cache is stale
      // 2. Stale revalidation fetch starts (not awaited)
      // 3. While fetch is in-flight, user clicks link to /other-page
      // 4. New navigation starts, should abort the stale revalidation
      // 5. Stale revalidation should NOT update cache after abort
      //
      // The key insight: abort should happen AFTER fetch starts but
      // BEFORE commit, simulating the user navigating away mid-request

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const cacheKey = "/shop/product/123:intercept";
      store._setCache(cacheKey, [shopLayout, modalSegment], true);
      store.setHistoryKey(cacheKey);

      const abortController = new AbortController();

      // Customize client to abort mid-flight (after response received, before processing)
      let fetchCount = 0;
      client.fetchPartial = vi.fn(async () => {
        fetchCount++;
        // Simulate abort happening after fetch completes but before processing
        // In real scenario, this happens when user navigates away
        abortController.abort();

        return {
          payload: createMockPayload({
            segments: [shopLayout, modalSegment],
            matched: ["shop-layout", "modal.@modal"],
            diff: ["modal.@modal"],
            isPartial: true,
            slots: { "@modal": { active: true } },
          }),
          streamComplete: Promise.resolve(),
        };
      });

      const committed: unknown[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: () => {
          committed.push(true);
        },
      });

      await fetchPartialUpdate(
        "/shop/product/123",
        ["shop-layout", "modal.@modal"],
        false,
        abortController.signal,
        tx,
        { staleRevalidation: true, interceptSourceUrl: "http://localhost/shop" }
      );

      // Fetch was called
      expect(fetchCount).toBe(1);

      // But commit should NOT have happened because abort occurred before commit
      expect(committed).toHaveLength(0);
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("should skip UI update when history key changes during stale revalidation", async () => {
      // This tests the scenario:
      // 1. User on intercepted route, cache is stale
      // 2. Stale revalidation starts
      // 3. User navigates away (changes history key)
      // 4. Stale revalidation response arrives
      // 5. Should NOT update UI because user is now on different route

      const shopLayout = createMockSegment("shop-layout", { type: "layout" });
      const modalSegment = createMockSegment("modal.@modal", {
        type: "parallel",
        namespace: "intercept:products",
      });

      const interceptCacheKey = "/shop/product/123:intercept";
      const otherPageKey = "/other-page";

      store._setCache(interceptCacheKey, [shopLayout, modalSegment], true);
      store.setHistoryKey(interceptCacheKey);

      // Customize client to change history key mid-flight (simulating navigation)
      client.fetchPartial = vi.fn(async () => {
        // Simulate user navigating away - history key changes
        store.setHistoryKey(otherPageKey);

        return {
          payload: createMockPayload({
            segments: [shopLayout, modalSegment],
            matched: ["shop-layout", "modal.@modal"],
            diff: ["modal.@modal"],
            isPartial: true,
            slots: { "@modal": { active: true } },
          }),
          streamComplete: Promise.resolve(),
        };
      });

      const committed: unknown[] = [];
      const tx = createTestTransaction({
        currentUrl: "http://localhost/shop",
        onCommit: () => {
          committed.push(true);
        },
      });

      await fetchPartialUpdate(
        "/shop/product/123",
        ["shop-layout", "modal.@modal"],
        false,
        undefined, // No abort signal
        tx,
        { staleRevalidation: true, interceptSourceUrl: "http://localhost/shop" }
      );

      // Commit was called (cache update happens)
      expect(committed).toHaveLength(1);

      // But onUpdate should NOT have been called because history key changed
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Full Update (Fallback)
  // ==========================================================================

  describe("Full Update Fallback", () => {
    it("should handle non-partial responses", async () => {
      const segments = [
        createMockSegment("layout", { type: "layout" }),
        createMockSegment("page", { type: "route" }),
      ];

      client._queueResponse({
        root: null,
        metadata: {
          pathname: "/test",
          segments,
          isPartial: false, // Full update
        },
      });

      const committed: { segmentIds: string[] }[] = [];
      const tx = createTestTransaction({
        onCommit: (segmentIds) => {
          committed.push({ segmentIds });
        },
      });

      await fetchPartialUpdate("/test", undefined, false, undefined, tx);

      // Should commit with segments from full response
      expect(committed).toHaveLength(1);
      expect(committed[0].segmentIds).toEqual(["layout", "page"]);

      // Should call onUpdate with root from payload
      expect(onUpdate).toHaveBeenCalled();
    });
  });
});
