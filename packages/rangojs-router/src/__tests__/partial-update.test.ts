import { describe, it, expect, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

// Mock startTransition to run callbacks synchronously
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    startTransition: (fn: () => void) => fn(),
  };
});

// Let merge helpers run as real code (pure logic)
// Mock assertSegmentStructure to suppress dev warnings
vi.mock("../browser/segment-structure-assert.js", () => ({
  assertSegmentStructure: vi.fn(),
}));

import { createPartialUpdater } from "../browser/partial-update";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seg(
  id: string,
  overrides?: Partial<ResolvedSegment>,
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
    ...overrides,
  } as any;
}

function createMockStore(opts?: {
  historyKey?: string;
  cachedSegments?: ResolvedSegment[];
  segmentIds?: string[];
  currentUrl?: string;
}) {
  const cache = new Map<
    string,
    { segments: ResolvedSegment[]; stale: boolean }
  >();
  const historyKey = opts?.historyKey ?? "/";
  if (opts?.cachedSegments) {
    cache.set(historyKey, { segments: opts.cachedSegments, stale: false });
  }

  let currentHistoryKey = historyKey;
  let interceptSourceUrl: string | null = null;

  return {
    getHistoryKey: vi.fn(() => currentHistoryKey),
    setHistoryKey: vi.fn((k: string) => {
      currentHistoryKey = k;
    }),
    getCachedSegments: vi.fn((key: string) => cache.get(key)),
    getSegmentState: vi.fn(() => ({
      path: "/",
      currentUrl: opts?.currentUrl ?? "http://localhost/",
      currentSegmentIds: opts?.segmentIds ?? [],
    })),
    setInterceptSourceUrl: vi.fn((url: string | null) => {
      interceptSourceUrl = url;
    }),
    getInterceptSourceUrl: vi.fn(() => interceptSourceUrl),
    // Stubs for methods not directly used in partial-update
    getState: vi.fn(() => ({ state: "idle" })),
    setState: vi.fn(),
    subscribe: vi.fn(),
    cacheSegmentsForHistory: vi.fn(),
    hasHistoryCache: vi.fn(() => false),
    setPath: vi.fn(),
    setCurrentUrl: vi.fn(),
    setSegmentIds: vi.fn(),
    markCacheAsStale: vi.fn(),
    clearHistoryCache: vi.fn(),
    markCacheAsStaleAndBroadcast: vi.fn(),
    broadcastCacheInvalidation: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
    addInflightAction: vi.fn(),
    removeInflightAction: vi.fn(),
    isActionInProgress: vi.fn(() => false),
    setActionInProgress: vi.fn(),
    updateCacheHandleData: vi.fn(),
    onUpdate: vi.fn(),
    emitUpdate: vi.fn(),
    getActionState: vi.fn(),
    setActionState: vi.fn(),
    subscribeToAction: vi.fn(),
  };
}

function createMockClient(
  payload: any,
  opts?: { hangStream?: boolean },
) {
  let resolveStream: () => void;
  // By default, streamComplete resolves immediately.
  // The async function's return Promise adopts streamComplete (JS promise flattening),
  // so a hanging stream would hang the entire await.
  const streamComplete = opts?.hangStream
    ? new Promise<void>((resolve) => {
        resolveStream = resolve;
      })
    : Promise.resolve();

  return {
    client: {
      fetchPartial: vi.fn(async () => ({
        payload,
        streamComplete,
      })),
    },
    resolveStream: () => resolveStream!(),
  };
}

function createMockTx(currentUrl = "http://localhost/") {
  return {
    currentUrl,
    startStreaming: vi.fn(() => ({ end: vi.fn() })),
    commit: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("partial-update", () => {
  describe("partial update (isPartial=true)", () => {
    it("merges server diff segments with cached segments", async () => {
      const cachedLayout = seg("L0", { type: "layout", component: "cached-layout" });
      const cachedRoute = seg("L0R0", { component: "cached-route" });
      const newRoute = seg("L0R0", { component: "new-route" });

      const store = createMockStore({
        cachedSegments: [cachedLayout, cachedRoute],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [newRoute],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      });

      const renderSegments = vi.fn(async (segs: any) => `tree-${segs.length}`);
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx);

      // renderSegments should be called with merged segments
      expect(renderSegments).toHaveBeenCalledTimes(1);
      const renderedSegments = renderSegments.mock.calls[0][0];
      expect(renderedSegments).toHaveLength(2);
      // L0 should come from cache (not in diff)
      expect(renderedSegments.find((s: any) => s.id === "L0").component).toBe(
        "cached-layout",
      );
      // L0R0 should come from server (in diff)
      expect(renderedSegments.find((s: any) => s.id === "L0R0").component).toBe(
        "new-route",
      );

      // tx.commit called with all segment IDs
      expect(tx.commit).toHaveBeenCalledWith(
        ["L0", "L0R0"],
        expect.any(Array),
        undefined,
      );

      // onUpdate called with rendered tree
      expect(onUpdate).toHaveBeenCalledWith({
        root: `tree-2`,
        metadata: expect.objectContaining({ isPartial: true }),
      });
    });

    it("preserves cached component when server returns null for layout", async () => {
      const cachedLayout = seg("L0", { type: "layout", component: "my-layout" });
      const newLayout = seg("L0", { type: "layout", component: null as any });
      const cachedRoute = seg("L0R0");

      const store = createMockStore({
        cachedSegments: [cachedLayout, cachedRoute],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [newLayout],
          matched: ["L0", "L0R0"],
          diff: ["L0"],
        },
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["L0", "L0R0"], false, undefined, tx);

      const rendered = (renderSegments.mock.calls as any[][])[0][0];
      const layout = rendered.find((s: any) => s.id === "L0");
      // Should preserve cached component, not null
      expect(layout.component).toBe("my-layout");
    });

    it("clears loading state for cached (unchanged) segments", async () => {
      const cached = seg("R0", { loading: "skeleton" as any });
      const store = createMockStore({ cachedSegments: [cached] });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      // No server segment for R0 in newSegmentMap, but it's in matched.
      // Since it's not found in newSegmentMap, it falls back to cache.
      // Actually, let me fix this: R0 is in diff but not in segments from server.
      // So newSegmentMap won't have R0. It'll use cache.
      // Actually - let me re-read. segments: [] means newSegmentMap has nothing.
      // matched: ["R0"] means we try to find R0 in newSegmentMap (miss) then cache (hit).
      // Cache has loading set → should be cleared to undefined.

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx);

      const rendered = (renderSegments.mock.calls as any[][])[0][0];
      expect(rendered[0].loading).toBeUndefined();
    });

    // BUG P0-1: cached segment loading cleared from false to undefined
    //
    // When a cached segment has loading=false (suppressed), navigating to a route
    // where the server doesn't re-render that segment (matched but not in diff)
    // should preserve loading=false. Instead, the current code unconditionally
    // sets it to undefined, which changes the React tree structure:
    //   loading: false     -> LoaderBoundary + OutletProvider (structural boundary)
    //   loading: undefined -> OutletProvider directly (no boundary)
    // This causes React to remount components, destroying client state.
    //
    // The correct behavior (see server-action-bridge.ts lines 439-445) preserves
    // the cached loading value instead of clearing it.
    it("preserves loading=false for cached segment (does not clear to undefined)", async () => {
      // Layout cached with loading=false (suppressed via { ssr: false } in loading())
      const cachedLayout = seg("L0", {
        type: "layout",
        component: "cached-layout",
        loading: false as any,
      });
      const cachedRoute = seg("L0R0", { component: "cached-route" });

      const store = createMockStore({
        cachedSegments: [cachedLayout, cachedRoute],
      });

      // Server returns a new route segment but NOT the layout.
      // The layout is in matched (server expects client to have it) but NOT in diff
      // (server decided it doesn't need re-rendering). This triggers the cache
      // fallback path where the bug exists.
      const newRoute = seg("L0R0", { component: "new-route" });
      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [newRoute],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      });

      const renderSegments = vi.fn(async (segs: any) => `tree-${segs.length}`);
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx);

      const rendered = renderSegments.mock.calls[0][0];
      const layout = rendered.find((s: any) => s.id === "L0");

      // The layout should preserve loading=false (suppressed boundary).
      // BUG: current code clears it to undefined, changing the tree structure.
      expect(layout.loading).toBe(false);
    });
  });

  describe("empty diff handling", () => {
    it("skips UI update when diff is empty (same-route revalidation)", async () => {
      const cached = seg("R0");
      const store = createMockStore({ cachedSegments: [cached] });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["R0"],
          diff: [],
        },
      });

      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx);

      // Should commit but NOT call onUpdate (no UI change)
      expect(tx.commit).toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("renders cached segments when navigating with targetCacheSegments", async () => {
      const targetSegs = [seg("L0", { type: "layout" }), seg("L0R0")];

      const store = createMockStore();
      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0", "L0R0"],
          diff: [],
        },
      });

      const renderSegments = vi.fn(async () => "cached-tree");
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/page", undefined, false, undefined, tx, {
        targetCacheSegments: targetSegs,
      });

      // Should render even with empty diff because targetCacheSegments provided
      expect(renderSegments).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ forceAwait: true }),
      );
      expect(onUpdate).toHaveBeenCalled();
    });

    it("forces re-render when leavingIntercept even with empty diff", async () => {
      const cached = seg("L0", { type: "layout" });
      const modal = seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" });
      const store = createMockStore({
        cachedSegments: [cached, modal],
        segmentIds: ["L0", "L0.@modal"],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0"],
          diff: [],
        },
      });

      const renderSegments = vi.fn(async () => "tree-no-modal");
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/", undefined, false, undefined, tx, {
        leavingIntercept: true,
      });

      // Should render and update UI to remove modal
      expect(renderSegments).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  describe("intercept with target cache segments", () => {
    // Regression test for REVIEW #29: The deleted dead-code block attempted to
    // rebuild currentSegmentMap from getCurrentSegmentMap() when an intercept
    // response arrived with targetCacheSegments. Because the reassignment came
    // AFTER all currentSegmentMap reads, it was dead and was removed.
    //
    // This test confirms: unmodified segments come from targetCacheSegments
    // (not the source page's cache) even when the server returns an intercept response.
    it("uses targetCacheSegments for unmodified layout when server returns intercept response", async () => {
      const sourceLayout = seg("L0", { type: "layout", component: "source-layout" });
      const sourceRoute = seg("L0R0", { component: "source-route" });
      const targetLayout = seg("L0", { type: "layout", component: "target-layout" });
      const targetRoute = seg("L0R0", { component: "target-route" });
      const modalSegment = seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" });

      // Source page is cached at the current history key
      const store = createMockStore({
        cachedSegments: [sourceLayout, sourceRoute],
        segmentIds: ["L0", "L0R0"],
      });

      // Server returns an intercept response: only the modal is in diff.
      // The layout is in matched but not re-rendered (should come from cache).
      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [modalSegment],
          matched: ["L0", "L0.@modal"],
          diff: ["L0.@modal"],
          slots: { "@modal": { active: true } },
        },
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater(
        "http://localhost/target",
        ["L0", "L0R0"],
        false,
        undefined,
        tx,
        { targetCacheSegments: [targetLayout, targetRoute] }
      );

      const mainSegs = (renderSegments.mock.calls as any[][])[0][0] as ResolvedSegment[];
      const layout = mainSegs.find((s) => s.id === "L0");

      // Layout must come from targetCacheSegments ("target-layout"),
      // not the source page's store cache ("source-layout").
      expect(layout?.component).toBe("target-layout");
    });
  });

  describe("intercept segment filtering", () => {
    it("filters intercept segments from segmentIds when leavingIntercept", async () => {
      const layout = seg("L0", { type: "layout" });
      const route = seg("L0R0");
      const modal = seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" });

      const store = createMockStore({
        segmentIds: ["L0", "L0R0", "L0.@modal"],
        cachedSegments: [layout, route, modal],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0"],
          diff: [],
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", undefined, false, undefined, tx, {
        leavingIntercept: true,
      });

      // fetchPartial should be called with filtered segments (no intercept namespace segments)
      const fetchCall = (client.fetchPartial as any).mock.calls[0][0];
      expect(fetchCall.segmentIds).toEqual(["L0", "L0R0"]);
      expect(fetchCall.segmentIds).not.toContain("L0.@modal");
    });

    it("separates intercept segments from main segments for rendering", async () => {
      const layout = seg("L0", { type: "layout" });
      const route = seg("L0R0");
      const modal = seg("L0.@modal", { type: "parallel", namespace: "intercept:modal" });

      const store = createMockStore({ cachedSegments: [layout, route] });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [layout, route, modal],
          matched: ["L0", "L0R0", "L0.@modal"],
          diff: ["L0", "L0R0", "L0.@modal"],
          slots: { "@modal": { active: true } },
        },
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/modal", ["L0", "L0R0"], false, undefined, tx);

      // renderSegments should receive main segments and intercept segments separately
      const call = (renderSegments.mock.calls as any[][])[0];
      const mainSegs = call[0] as ResolvedSegment[];
      const opts = call[1] as { interceptSegments?: ResolvedSegment[] };

      // Main segments should NOT include the parallel intercept
      expect(mainSegs.find((s) => s.id === "L0.@modal")).toBeUndefined();
      // Intercept segments should be passed via options
      expect(opts?.interceptSegments).toHaveLength(1);
      expect(opts?.interceptSegments![0].id).toBe("L0.@modal");
    });
  });

  describe("stale navigation detection", () => {
    it("returns early when signal is aborted before processing", async () => {
      const store = createMockStore();
      const controller = new AbortController();
      controller.abort();

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: [],
          diff: ["R0"],
        },
      });

      const renderSegments = vi.fn();
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/", [], false, controller.signal, tx);

      // Should not render or update
      expect(renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("skips UI update for stale revalidation when history key changed", async () => {
      const store = createMockStore({ historyKey: "/page1" });
      // Simulate history key changing mid-request
      let callCount = 0;
      store.getHistoryKey.mockImplementation(() => {
        callCount++;
        return callCount <= 1 ? "/page1" : "/page2";
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [seg("R0")],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/page1", [], false, undefined, tx, {
        staleRevalidation: true,
      });

      // Should render but NOT call onUpdate because history key changed
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe("full update fallback", () => {
    it("renders all segments client-side when isPartial=false", async () => {
      const serverSegments = [
        seg("L0", { type: "layout" }),
        seg("L0R0"),
      ];

      const store = createMockStore();
      const { client } = createMockClient({
        metadata: {
          isPartial: false,
          segments: serverSegments,
        },
      });

      const renderSegments = vi.fn(async () => "full-tree");
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/new", [], false, undefined, tx);

      // Should render ALL segments (not merge with cache)
      expect(renderSegments).toHaveBeenCalledWith(serverSegments);

      // Commit with segment IDs from server
      expect(tx.commit).toHaveBeenCalledWith(
        ["L0", "L0R0"],
        serverSegments,
      );

      expect(onUpdate).toHaveBeenCalledWith({
        root: "full-tree",
        metadata: expect.objectContaining({ isPartial: false }),
      });
    });

    it("returns early for full update when signal is aborted", async () => {
      const controller = new AbortController();
      controller.abort();

      const store = createMockStore();
      const { client } = createMockClient({
        metadata: {
          isPartial: false,
          segments: [seg("R0")],
        },
      });

      const renderSegments = vi.fn();
      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/", [], false, controller.signal, tx);

      expect(renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe("HMR resilience", () => {
    it("retries with empty segments when matched IDs are missing from cache", async () => {
      // No cached segments → server's matched["L0", "L0R0"] won't be found
      const store = createMockStore({ cachedSegments: [] });

      // First call: partial with missing segments
      // Second call (retry): full update
      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      });

      // Override to return full update on retry
      let callCount = 0;
      client.fetchPartial.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            payload: {
              metadata: {
                isPartial: true,
                segments: [],
                matched: ["L0", "L0R0"],
                diff: ["L0R0"],
              },
            },
            streamComplete: Promise.resolve(),
          };
        }
        return {
          payload: {
            metadata: {
              isPartial: false,
              segments: [
                seg("L0", { type: "layout" }),
                seg("L0R0"),
              ],
            },
          },
          streamComplete: Promise.resolve(),
        };
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/page", [], false, undefined, tx);

      // Should have fetched twice: first partial (missing), then retry with empty segments
      expect(client.fetchPartial).toHaveBeenCalledTimes(2);
      const retryCall = (client.fetchPartial.mock.calls as any[][])[1][0];
      expect(retryCall.segmentIds).toEqual([]);
    });

    it("throws on retry failure", async () => {
      const store = createMockStore({ cachedSegments: [] });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0"],
          diff: ["L0"],
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      // isRetry=true, missing segments → should throw
      await expect(
        updater("http://localhost/", [], true, undefined, tx),
      ).rejects.toThrow("Failed to fetch segments after retry");
    });
  });

  describe("isAction and staleRevalidation options", () => {
    it("wraps onUpdate in startTransition when isAction=true", async () => {
      const store = createMockStore({
        cachedSegments: [seg("R0")],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [seg("R0", { component: "updated" })],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        isAction: true,
      });

      // Our mocked startTransition runs synchronously, so onUpdate should be called
      expect(onUpdate).toHaveBeenCalled();
    });

    it("passes forceAwait to renderSegments when staleRevalidation=true", async () => {
      const store = createMockStore({
        cachedSegments: [seg("R0")],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [seg("R0", { component: "updated" })],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        staleRevalidation: true,
      });

      expect(renderSegments).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ forceAwait: true }),
      );
    });
  });

  describe("structural preservation on server-returned segments", () => {
    // The loading() helper with { ssr: false } produces different values
    // depending on how the page was loaded:
    //   - Document request (SSR): loading=false (suppressed boundary)
    //   - Partial navigation:     loading=<skeleton> (active boundary)
    //
    // When an action fires, the server re-resolves with isSSR=false, always
    // returning loading=<skeleton>. The merge layer must preserve the cached
    // value to keep the React tree structure consistent. Without this,
    // tree depth changes cause component remounts, destroying useActionState.

    describe("after document request (SSR entry)", () => {
      // SSR sets loading=false via loading(skeleton, { ssr: false }) + isSSR=true.
      // Action revalidation re-resolves with isSSR=false, producing loading=skeleton.
      // Merge must preserve cached false to prevent tree depth change.

      it("preserves cached loading=false when action returns loading=skeleton", async () => {
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: false as any,
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: "skeleton" as any,
        });
        const serverRoute = seg("L0R0", { component: "updated-route" });

        const store = createMockStore({
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const { client } = createMockClient({
          metadata: {
            isPartial: true,
            segments: [serverLayout, serverRoute],
            matched: ["L0", "L0R0"],
            diff: ["L0", "L0R0"],
          },
        });

        const renderSegments = vi.fn(async () => "tree");
        const tx = createMockTx();

        const updater = createPartialUpdater({
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx, {
          isAction: true,
        });

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        // loading must be preserved from cache (false), not server (skeleton)
        // false = LoaderBoundary+Outlet, skeleton = LoaderBoundary+Outlet+RouteContentWrapper
        expect(layout.loading).toBe(false);
        // Route component should come from server (updated)
        const route = rendered.find((s: any) => s.id === "L0R0");
        expect(route.component).toBe("updated-route");
      });

      it("preserves all structural properties together during action", async () => {
        // Combined scenario after SSR: loading=false, component cached,
        // server returns different loading + null component
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: false as any,
          mountPath: "/shop",
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: null as any,      // null = don't re-render
          loading: "skeleton" as any,   // different from cached
          mountPath: "/shop",           // same (mountPath is always consistent)
        });
        const serverRoute = seg("L0R0", { component: "updated" });

        const store = createMockStore({
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const { client } = createMockClient({
          metadata: {
            isPartial: true,
            segments: [serverLayout, serverRoute],
            matched: ["L0", "L0R0"],
            diff: ["L0", "L0R0"],
          },
        });

        const renderSegments = vi.fn(async () => "tree");
        const tx = createMockTx();

        const updater = createPartialUpdater({
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx, {
          isAction: true,
        });

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        expect(layout.component).toBe("my-layout");  // preserved (server sent null)
        expect(layout.loading).toBe(false);           // preserved (server sent skeleton)
        expect(layout.mountPath).toBe("/shop");       // unchanged (same in both)
      });
    });

    describe("after partial navigation (client-side entry)", () => {
      // Partial navigation resolves with isSSR=false, so loading=<skeleton>.
      // Action revalidation also uses isSSR=false, producing loading=<skeleton>.
      // Values match - no preservation needed, tree stays consistent.

      it("keeps loading=skeleton when action also returns loading=skeleton", async () => {
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: "skeleton" as any,
          mountPath: "/shop",
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: "skeleton" as any,
          mountPath: "/shop",
        });
        const serverRoute = seg("L0R0", { component: "updated-route" });

        const store = createMockStore({
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const { client } = createMockClient({
          metadata: {
            isPartial: true,
            segments: [serverLayout, serverRoute],
            matched: ["L0", "L0R0"],
            diff: ["L0", "L0R0"],
          },
        });

        const renderSegments = vi.fn(async () => "tree");
        const tx = createMockTx();

        const updater = createPartialUpdater({
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx, {
          isAction: true,
        });

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        // Both cached and server have skeleton - values match, no change needed
        expect(layout.loading).toBe("skeleton");
        expect(layout.mountPath).toBe("/shop");
        // Route component updated from server
        const route = rendered.find((s: any) => s.id === "L0R0");
        expect(route.component).toBe("updated-route");
      });

      it("preserves null component for layout when server returns null", async () => {
        // After navigation, layout has component. Action returns null for it
        // (no re-render needed). Must preserve cached component.
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: "skeleton" as any,
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: null as any,
          loading: "skeleton" as any,
        });
        const serverRoute = seg("L0R0", { component: "updated" });

        const store = createMockStore({
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const { client } = createMockClient({
          metadata: {
            isPartial: true,
            segments: [serverLayout, serverRoute],
            matched: ["L0", "L0R0"],
            diff: ["L0", "L0R0"],
          },
        });

        const renderSegments = vi.fn(async () => "tree");
        const tx = createMockTx();

        const updater = createPartialUpdater({
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx, {
          isAction: true,
        });

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        expect(layout.component).toBe("my-layout");  // preserved from cache
        expect(layout.loading).toBe("skeleton");      // same in both, no change
      });
    });

    describe("mountPath defense-in-depth", () => {
      // mountPath is set from include() scope at route definition time,
      // not affected by isSSR. Both SSR and action should produce the same
      // value. This test verifies the preservation code handles a hypothetical
      // mismatch as defense-in-depth.

      it("preserves cached mountPath if server returns different value", async () => {
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          mountPath: undefined,
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          mountPath: "/shop",
        });

        const store = createMockStore({
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const { client } = createMockClient({
          metadata: {
            isPartial: true,
            segments: [serverLayout],
            matched: ["L0", "L0R0"],
            diff: ["L0"],
          },
        });

        const renderSegments = vi.fn(async () => "tree");
        const tx = createMockTx();

        const updater = createPartialUpdater({
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater("http://localhost/page", ["L0", "L0R0"], false, undefined, tx);

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        expect(layout.mountPath).toBeUndefined();
      });
    });
  });

  describe("intercept context tracking", () => {
    it("sets intercept source URL when slots are active", async () => {
      const store = createMockStore({
        cachedSegments: [seg("L0", { type: "layout" }), seg("L0R0")],
        currentUrl: "http://localhost/shop",
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [
            seg("L0", { type: "layout" }),
            seg("L0R0"),
          ],
          matched: ["L0", "L0R0"],
          diff: ["L0", "L0R0"],
          slots: { "@modal": { active: true } },
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/modal", ["L0", "L0R0"], false, undefined, tx);

      // Should set intercept source URL from current URL (segmentState.currentUrl)
      expect(store.setInterceptSourceUrl).toHaveBeenCalledWith(
        "http://localhost/shop",
      );
    });

    it("clears intercept source URL for non-intercept navigation", async () => {
      const store = createMockStore({
        cachedSegments: [seg("R0")],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [seg("R0", { component: "updated" })],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/page", ["R0"], false, undefined, tx);

      expect(store.setInterceptSourceUrl).toHaveBeenCalledWith(null);
    });

    it("does not update intercept context for actions", async () => {
      const store = createMockStore({
        cachedSegments: [seg("R0")],
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [seg("R0")],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        isAction: true,
      });

      expect(store.setInterceptSourceUrl).not.toHaveBeenCalled();
    });
  });

  describe("streaming lifecycle", () => {
    it("starts and ends streaming token", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const endFn = vi.fn();

      const { client, resolveStream } = createMockClient(
        {
          metadata: {
            isPartial: true,
            segments: [seg("R0")],
            matched: ["R0"],
            diff: ["R0"],
          },
        },
        { hangStream: true },
      );

      const tx = createMockTx();
      tx.startStreaming.mockReturnValue({ end: endFn });

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      // Don't await directly since stream hangs (promise flattening blocks it).
      // Instead, capture the promise and resolve the stream, then await.
      const resultPromise = updater(
        "http://localhost/",
        ["R0"],
        false,
        undefined,
        tx,
      );

      // Let microtasks run so the function progresses to the return statement
      await new Promise((r) => setTimeout(r, 10));

      // startStreaming called
      expect(tx.startStreaming).toHaveBeenCalled();

      // end not called yet (stream still open)
      expect(endFn).not.toHaveBeenCalled();

      // Resolve stream
      resolveStream();
      await resultPromise;

      // end called after stream completes
      expect(endFn).toHaveBeenCalled();
    });

    it("ends streaming token when fetchPartial throws", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const endFn = vi.fn();

      const fetchError = new Error("network failure");
      const client = {
        fetchPartial: vi.fn(async () => {
          throw fetchError;
        }),
      };

      const tx = createMockTx();
      tx.startStreaming.mockReturnValue({ end: endFn });

      const updater = createPartialUpdater({
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      // fetchPartial throws, so the updater should re-throw
      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).rejects.toThrow("network failure");

      // startStreaming was called before the fetch
      expect(tx.startStreaming).toHaveBeenCalled();

      // streamingToken.end() must be called even though fetchPartial threw,
      // otherwise isStreaming is permanently stuck as true
      expect(endFn).toHaveBeenCalled();
    });
  });
});
