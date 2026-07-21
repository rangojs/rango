import { afterEach, describe, it, expect, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";
import { ServerRedirect } from "../errors";

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
  opts?: { hangStream?: boolean; fullyPrefetched?: boolean },
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
        // fetchPartial returns fullyPrefetched only for a warm prefetch hit
        // whose stream already drained; default off (cold / fresh fetch).
        ...(opts?.fullyPrefetched !== undefined && {
          fullyPrefetched: opts.fullyPrefetched,
        }),
      })),
    },
    resolveStream: () => resolveStream!(),
  };
}

function createMockTx(currentUrl = "http://localhost/") {
  return {
    currentUrl,
    startStreaming: vi.fn(() => ({ end: vi.fn() })),
    commit: vi.fn(() => ({ scroll: undefined })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("partial-update", () => {
  describe("partial update (isPartial=true)", () => {
    it("merges server diff segments with cached segments", async () => {
      const cachedLayout = seg("L0", {
        type: "layout",
        component: "cached-layout",
      });
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater(
        "http://localhost/page",
        ["L0", "L0R0"],
        false,
        undefined,
        tx,
      );

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
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          root: `tree-2`,
          metadata: expect.objectContaining({ isPartial: true }),
        }),
      );
    });

    it("preserves cached component when server returns null for layout", async () => {
      const cachedLayout = seg("L0", {
        type: "layout",
        component: "my-layout",
      });
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
        getVersion: () => undefined,
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

    it("preserves loading state for cached (unchanged) segments", async () => {
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

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx);

      const rendered = (renderSegments.mock.calls as any[][])[0][0];
      expect(rendered[0].loading).toBe("skeleton");
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater(
        "http://localhost/page",
        ["L0", "L0R0"],
        false,
        undefined,
        tx,
      );

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
        getVersion: () => undefined,
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/page", undefined, false, undefined, tx, {
        type: "navigate",
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
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/", undefined, false, undefined, tx, {
        type: "leave-intercept",
      });

      // Should render and update UI to remove modal
      expect(renderSegments).toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalled();
    });

    it("uses segmentState.currentUrl as previousUrl for leave-intercept (popstate safety)", async () => {
      // Popstate updates window.location.href before our handler runs, so
      // tx.currentUrl captures the destination URL. segmentState.currentUrl
      // still holds the intercept URL the segments render. The server needs
      // the intercept URL as the "from" to compute the right diff.
      const cached = seg("L0", { type: "layout" });
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
      const store = createMockStore({
        cachedSegments: [cached, modal],
        segmentIds: ["L0", "L0.@modal"],
        currentUrl: "http://localhost/shop/product/42", // pre-popstate intercept URL
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [],
          matched: ["L0"],
          diff: [],
        },
      });

      const tx = createMockTx("http://localhost/shop?page=5"); // popstate destination
      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater(
        "http://localhost/shop?page=5",
        undefined,
        false,
        undefined,
        tx,
        { type: "leave-intercept" },
      );

      const fetchCall = (client.fetchPartial as any).mock.calls[0][0];
      expect(fetchCall.previousUrl).toBe("http://localhost/shop/product/42");
    });
  });

  describe("redirect payload validation", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("throws ServerRedirect for same-origin redirect payload", async () => {
      vi.stubGlobal("window", {
        location: { origin: "http://localhost" },
      });

      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient({
        metadata: {
          redirect: { url: "/target" },
          locationState: { __rsc_ls_flash: "ok" },
        },
      });

      const tx = createMockTx();
      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).rejects.toMatchObject({
        name: "ServerRedirect",
        url: "http://localhost/target",
      } satisfies Partial<ServerRedirect>);
    });

    it("ignores cross-origin redirect payload", async () => {
      vi.stubGlobal("window", {
        location: { origin: "http://localhost" },
      });

      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient({
        metadata: {
          redirect: { url: "https://evil.example/phish" },
          locationState: { __rsc_ls_flash: "blocked" },
        },
      });

      const onUpdate = vi.fn();
      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).resolves.toBeUndefined();

      expect(tx.commit).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(renderSegments).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });

    it("hard-navigates an external:true redirect payload via location.assign", async () => {
      const assign = vi.fn();
      vi.stubGlobal("window", {
        location: { origin: "http://localhost", assign },
      });

      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient({
        metadata: {
          redirect: {
            url: "https://accounts.example.com/oauth",
            external: true,
          },
        },
      });

      const onUpdate = vi.fn();
      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      // External opt-in: a hard navigation, NOT a ServerRedirect throw, and no
      // same-origin validation block.
      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).resolves.toBeUndefined();

      expect(assign).toHaveBeenCalledWith("https://accounts.example.com/oauth");
      expect(renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    // Finding #2 regression: external:true waives the same-origin check, NOT
    // scheme safety. A javascript: target (forged payload, or a mistaken
    // redirect(..., { external: true })) must NEVER reach location.assign.
    it("does NOT location.assign an external:true payload with a javascript: scheme", async () => {
      const assign = vi.fn();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      vi.stubGlobal("window", {
        location: { origin: "http://localhost", assign },
      });

      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient({
        metadata: {
          redirect: {
            url: "javascript:alert(document.cookie)",
            external: true,
          },
        },
      });

      const onUpdate = vi.fn();
      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).resolves.toBeUndefined();

      // Blocked: no scriptable navigation, no render, console.error logged.
      expect(assign).not.toHaveBeenCalled();
      expect(renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
    });
  });

  describe("router id integrity guard", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("discards a partial response whose routerId does not match the client and reloads", async () => {
      vi.stubGlobal("window", {
        location: { origin: "http://localhost", href: "http://localhost/" },
      });

      const store = createMockStore({ cachedSegments: [seg("R0")] });
      // Defense in depth: the server redirects on a cross-app mismatch, so a
      // partial whose routerId differs from this client's should never arrive.
      // If one does (stale/edge cache, proxy mixing apps, server bug), it must
      // NOT be merged into this document.
      (store as any).getRouterId = vi.fn(() => "client-app");

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          routerId: "other-app",
          segments: [seg("R0", { component: "foreign" })],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const onUpdate = vi.fn();
      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await expect(
        updater("http://localhost/page", ["R0"], false, undefined, tx),
      ).resolves.toBeUndefined();

      // Not merged; reloaded to the target so the server re-establishes the
      // authoritative document for this URL.
      expect(onUpdate).not.toHaveBeenCalled();
      expect(renderSegments).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalled();
      expect((window as any).location.href).toBe("http://localhost/page");
    });

    it("applies a partial response whose routerId matches the client", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });
      (store as any).getRouterId = vi.fn(() => "client-app");

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          routerId: "client-app",
          segments: [seg("R0", { component: "fresh" })],
          matched: ["R0"],
          diff: ["R0"],
        },
      });

      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx);

      // Matching routerId: the guard must not fire and the update is applied.
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
      const sourceLayout = seg("L0", {
        type: "layout",
        component: "source-layout",
      });
      const sourceRoute = seg("L0R0", { component: "source-route" });
      const targetLayout = seg("L0", {
        type: "layout",
        component: "target-layout",
      });
      const targetRoute = seg("L0R0", { component: "target-route" });
      const modalSegment = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });

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
        getVersion: () => undefined,
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
        { type: "navigate", targetCacheSegments: [targetLayout, targetRoute] },
      );

      const mainSegs = (
        renderSegments.mock.calls as any[][]
      )[0][0] as ResolvedSegment[];
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
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });

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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", undefined, false, undefined, tx, {
        type: "leave-intercept",
      });

      // fetchPartial should be called with filtered segments (no intercept namespace segments)
      const fetchCall = (client.fetchPartial as any).mock.calls[0][0];
      expect(fetchCall.segmentIds).toEqual(["L0", "L0R0"]);
      expect(fetchCall.segmentIds).not.toContain("L0.@modal");
    });

    it("separates intercept segments from main segments for rendering", async () => {
      const layout = seg("L0", { type: "layout" });
      const route = seg("L0R0");
      const modal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });

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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater(
        "http://localhost/modal",
        ["L0", "L0R0"],
        false,
        undefined,
        tx,
      );

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
        getVersion: () => undefined,
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/page1", [], false, undefined, tx, {
        type: "stale-revalidation",
      });

      // Should render but NOT call onUpdate because history key changed
      expect(onUpdate).not.toHaveBeenCalled();
    });
  });

  describe("full update fallback", () => {
    it("renders all segments client-side when isPartial=false", async () => {
      const serverSegments = [seg("L0", { type: "layout" }), seg("L0R0")];

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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/new", [], false, undefined, tx);

      // Should render ALL segments (not merge with cache)
      expect(renderSegments).toHaveBeenCalledWith(serverSegments);

      // Commit with segment IDs from server
      expect(tx.commit).toHaveBeenCalledWith(["L0", "L0R0"], serverSegments);

      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          root: "full-tree",
          metadata: expect.objectContaining({ isPartial: false }),
        }),
      );
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/", [], false, controller.signal, tx);

      expect(renderSegments).not.toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    /**
     * F2: the full-update fallback (isPartial=false) stale-revalidation path
     * must apply the same history-key staleness guard the partial branch has.
     * A background stale-revalidation that finishes after the user navigated
     * away (history key changed) must NOT clobber the freshly committed UI.
     * The guard runs after `await rawStreamComplete` — a real async suspension
     * during which a new navigation can land.
     */
    it("skips full-update UI commit for stale revalidation when history key changed", async () => {
      const store = createMockStore({ historyKey: "/page1" });
      // Key matches when captured at start, then changes (user navigated away)
      // by the time the post-stream guard re-reads it.
      let callCount = 0;
      store.getHistoryKey.mockImplementation(() => {
        callCount++;
        return callCount <= 1 ? "/page1" : "/page2";
      });

      const { client } = createMockClient({
        metadata: {
          isPartial: false,
          segments: [seg("R0")],
        },
      });

      const onUpdate = vi.fn();
      const renderSegments = vi.fn(async () => "full-tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments,
      });

      await updater("http://localhost/page1", [], false, undefined, tx, {
        type: "stale-revalidation",
      });

      // Renders, but onUpdate must NOT fire because the history key changed.
      expect(renderSegments).toHaveBeenCalled();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it("applies full-update stale revalidation when history key is unchanged", async () => {
      const store = createMockStore({ historyKey: "/page1" });

      const { client } = createMockClient({
        metadata: {
          isPartial: false,
          segments: [seg("R0")],
        },
      });

      const onUpdate = vi.fn();
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "full-tree"),
      });

      await updater("http://localhost/page1", [], false, undefined, tx, {
        type: "stale-revalidation",
      });

      // Key unchanged: the update is applied.
      expect(onUpdate).toHaveBeenCalled();
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
              segments: [seg("L0", { type: "layout" }), seg("L0R0")],
            },
          },
          streamComplete: Promise.resolve(),
        };
      });

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
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
        getVersion: () => undefined,
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        type: "action",
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        type: "stale-revalidation",
      });

      expect(renderSegments).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ forceAwait: true }),
      );
    });
  });

  /**
   * Fully-prefetched commit branch.
   *
   * A fully-prefetched navigation must render with `forceAwait` (so the
   * already-resolved ROUTER loader data lands with no fallback frame) AND commit
   * inside a bare startTransition (no addTransitionType) so the current UI is
   * held across the synchronous resolution — no fallback flash anywhere.
   * Deliberate trade-off (#622 introduced this, #624 reverted it for client
   * mount-suspense, then reinstated): a client component that suspends during
   * its first render under an already-revealed boundary holds the old content
   * until it resolves — it renders pre-commit inside the transition, so its
   * effects cannot run first.
   *
   * A cold/partial nav (fullyPrefetched=false) must NOT forceAwait and commits
   * normally, so its fallbacks stream like a cold load. An explicit transition()
   * route still commits via the hasTransition branch (addTransitionType
   * "navigation").
   */
  describe("fully-prefetched commit branch (#622 follow-up)", () => {
    it("renders with forceAwait when fullyPrefetched=true", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient(
        {
          metadata: {
            isPartial: true,
            segments: [seg("R0", { component: "updated" })],
            matched: ["R0"],
            diff: ["R0"],
          },
        },
        { fullyPrefetched: true },
      );

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();
      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        type: "navigate",
      });

      expect(renderSegments).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({ forceAwait: true }),
      );
    });

    it("commits inside a bare startTransition when fullyPrefetched=true", async () => {
      const captured: Array<(...args: any[]) => any> = [];
      const React = await import("react");
      const spy = vi.spyOn(React, "startTransition").mockImplementation(((
        fn: () => void,
      ) => {
        captured.push(fn);
        fn();
      }) as any);

      try {
        const store = createMockStore({ cachedSegments: [seg("R0")] });
        const { client } = createMockClient(
          {
            metadata: {
              isPartial: true,
              segments: [seg("R0", { component: "updated" })],
              matched: ["R0"],
              diff: ["R0"],
            },
          },
          { fullyPrefetched: true },
        );

        const onUpdate = vi.fn();
        const tx = createMockTx();
        const updater = createPartialUpdater({
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate,
          renderSegments: vi.fn(async () => "tree"),
        });

        await updater("http://localhost/", ["R0"], false, undefined, tx, {
          type: "navigate",
        });

        // Transition commit: onUpdate ran exactly once, wrapped in
        // startTransition (the spy captures the callback before running it).
        expect(onUpdate).toHaveBeenCalledOnce();
        expect(captured.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
    });

    it("does NOT forceAwait a cold nav (fullyPrefetched=false) so its fallbacks stream", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });
      const { client } = createMockClient(
        {
          metadata: {
            isPartial: true,
            segments: [seg("R0", { component: "updated" })],
            matched: ["R0"],
            diff: ["R0"],
          },
        },
        { fullyPrefetched: false },
      );

      const renderSegments = vi.fn(async () => "tree");
      const tx = createMockTx();
      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments,
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        type: "navigate",
      });

      const opts = (renderSegments.mock.calls as any[][])[0][1];
      expect(opts.forceAwait).toBeFalsy();
    });

    it("an explicit transition() route still holds content (startTransition + addTransitionType)", async () => {
      const captured: Array<(...args: any[]) => any> = [];
      const React = await import("react");
      const spy = vi.spyOn(React, "startTransition").mockImplementation(((
        fn: () => void,
      ) => {
        captured.push(fn);
        fn();
      }) as any);

      try {
        // A transition-tagged segment drives shouldStartViewTransition=true, so
        // the hasTransition branch wins regardless of fullyPrefetched: a
        // transition() route is the documented content-hold opt-in.
        const store = createMockStore({
          cachedSegments: [seg("R0", { transition: true } as any)],
        });
        const { client } = createMockClient(
          {
            metadata: {
              isPartial: true,
              segments: [
                seg("R0", { component: "updated", transition: true } as any),
              ],
              matched: ["R0"],
              diff: ["R0"],
            },
          },
          { fullyPrefetched: true },
        );

        const onUpdate = vi.fn();
        const tx = createMockTx();
        const updater = createPartialUpdater({
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate,
          renderSegments: vi.fn(async () => "tree"),
        });

        await updater("http://localhost/", ["R0"], false, undefined, tx, {
          type: "navigate",
        });

        // Held in a transition (content-hold opt-in), unlike the plain
        // fully-prefetched normal commit above.
        expect(onUpdate).toHaveBeenCalledOnce();
        expect(captured.length).toBe(1);
      } finally {
        spy.mockRestore();
      }
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
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater(
          "http://localhost/page",
          ["L0", "L0R0"],
          false,
          undefined,
          tx,
          {
            type: "action",
          },
        );

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
          component: null as any, // null = don't re-render
          loading: "skeleton" as any, // different from cached
          mountPath: "/shop", // same (mountPath is always consistent)
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
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater(
          "http://localhost/page",
          ["L0", "L0R0"],
          false,
          undefined,
          tx,
          {
            type: "action",
          },
        );

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        expect(layout.component).toBe("my-layout"); // preserved (server sent null)
        expect(layout.loading).toBe(false); // preserved (server sent skeleton)
        expect(layout.mountPath).toBe("/shop"); // unchanged (same in both)
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
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater(
          "http://localhost/page",
          ["L0", "L0R0"],
          false,
          undefined,
          tx,
          {
            type: "action",
          },
        );

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
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater(
          "http://localhost/page",
          ["L0", "L0R0"],
          false,
          undefined,
          tx,
          {
            type: "action",
          },
        );

        const rendered = (renderSegments.mock.calls as any[][])[0][0];
        const layout = rendered.find((s: any) => s.id === "L0");

        expect(layout.component).toBe("my-layout"); // preserved from cache
        expect(layout.loading).toBe("skeleton"); // same in both, no change
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
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate: vi.fn(),
          renderSegments,
        });

        await updater(
          "http://localhost/page",
          ["L0", "L0R0"],
          false,
          undefined,
          tx,
        );

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
          segments: [seg("L0", { type: "layout" }), seg("L0R0")],
          matched: ["L0", "L0R0"],
          diff: ["L0", "L0R0"],
          slots: { "@modal": { active: true } },
        },
      });

      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater(
        "http://localhost/modal",
        ["L0", "L0R0"],
        false,
        undefined,
        tx,
      );

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
        getVersion: () => undefined,
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
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater("http://localhost/", ["R0"], false, undefined, tx, {
        type: "action",
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
        getVersion: () => undefined,
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

    it("does not start streaming when fetchPartial throws", async () => {
      const store = createMockStore({ cachedSegments: [seg("R0")] });

      const fetchError = new Error("network failure");
      const client = {
        fetchPartial: vi.fn(async () => {
          throw fetchError;
        }),
      };

      const tx = createMockTx();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      // fetchPartial throws, so the updater should re-throw
      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).rejects.toThrow("network failure");

      // startStreaming is called after fetchPartial, so on error it's never reached.
      // This avoids setting phase = "streaming" before any data arrives.
      expect(tx.startStreaming).not.toHaveBeenCalled();
    });
  });

  /**
   * F4: the render-vs-abort Promise.race must not leak its abort listener. The
   * abort Promise registers an "abort" listener; if render wins, the listener
   * has to be removed (the rejecting Promise never settles otherwise). Mirrors
   * teeWithCompletion in browser/response-adapter.ts.
   */
  describe("abort listener lifecycle (F4)", () => {
    function spySignal(): {
      signal: AbortSignal;
      addCalls: () => number;
      removeCalls: () => number;
    } {
      const controller = new AbortController();
      const signal = controller.signal;
      let added = 0;
      let removed = 0;
      const realAdd = signal.addEventListener.bind(signal);
      const realRemove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((type: string, ...rest: any[]) => {
        if (type === "abort") added++;
        return (realAdd as any)(type, ...rest);
      }) as any;
      signal.removeEventListener = ((type: string, ...rest: any[]) => {
        if (type === "abort") removed++;
        return (realRemove as any)(type, ...rest);
      }) as any;
      return {
        signal,
        addCalls: () => added,
        removeCalls: () => removed,
      };
    }

    it("removes the abort listener after a non-aborted partial render", async () => {
      const cached = seg("L0", { type: "layout", component: "cached" });
      const newRoute = seg("L0R0", { component: "new" });
      const store = createMockStore({ cachedSegments: [cached] });

      const { client } = createMockClient({
        metadata: {
          isPartial: true,
          segments: [newRoute],
          matched: ["L0", "L0R0"],
          diff: ["L0R0"],
        },
      });

      const tx = createMockTx();
      const spy = spySignal();

      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate: vi.fn(),
        renderSegments: vi.fn(async () => "tree"),
      });

      await updater(
        "http://localhost/page",
        ["L0", "L0R0"],
        false,
        spy.signal,
        tx,
      );

      // The race registered exactly one abort listener and removed it after
      // render won — no dangling listener.
      expect(spy.addCalls()).toBe(1);
      expect(spy.removeCalls()).toBe(1);
    });
  });

  /**
   * F3: the action full-update transition must use a synchronous callback like
   * every sibling branch. An async callback returns a Promise React ignores —
   * a latent trap.
   */
  describe("action full-update transition is synchronous (F3)", () => {
    it("passes a non-async callback to startTransition on the action full path", async () => {
      const captured: Array<(...args: any[]) => any> = [];
      // Re-mock startTransition for this test to capture (still runs sync).
      const React = await import("react");
      const spy = vi.spyOn(React, "startTransition").mockImplementation(((
        fn: () => void,
      ) => {
        captured.push(fn);
        fn();
      }) as any);

      try {
        const serverSegments = [seg("L0", { type: "layout" }), seg("L0R0")];
        const store = createMockStore();
        const { client } = createMockClient({
          metadata: { isPartial: false, segments: serverSegments },
        });
        const onUpdate = vi.fn();
        const tx = createMockTx();

        const updater = createPartialUpdater({
          getVersion: () => undefined,
          store: store as any,
          client: client as any,
          onUpdate,
          renderSegments: vi.fn(async () => "full-tree"),
        });

        // mode.type === "action" drives the full-update action branch.
        await updater("http://localhost/new", [], false, undefined, tx, {
          type: "action",
        });

        expect(onUpdate).toHaveBeenCalledOnce();
        expect(captured.length).toBeGreaterThan(0);
        for (const fn of captured) {
          expect(fn.constructor.name).not.toBe("AsyncFunction");
          // A sync transition callback returns undefined, never a thenable.
          expect((fn as any)()).toBeUndefined();
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * F5: the stream-completion side effect now has a .catch, so a rejecting
   * stream does not surface as an unhandled rejection and does not break the
   * update.
   */
  describe("stream completion rejection is swallowed (F5)", () => {
    it("completes the partial update even if streamComplete rejects", async () => {
      const cached = seg("R0", { component: "cached" });
      const store = createMockStore({ cachedSegments: [cached] });

      // streamComplete rejects; the .catch must absorb it.
      const rejecting = Promise.reject(new Error("stream boom"));
      // Pre-attach a no-op catch on our own reference so the test's reference
      // doesn't itself trip the unhandled-rejection detector; the production
      // .catch is what guards the copy partial-update holds.
      rejecting.catch(() => {});

      const tx = createMockTx();
      const endSpy = vi.fn();
      tx.startStreaming = vi.fn(() => ({ end: endSpy }));

      const client = {
        fetchPartial: vi.fn(async () => ({
          payload: {
            metadata: {
              isPartial: true,
              segments: [seg("R0", { component: "new" })],
              matched: ["R0"],
              diff: ["R0"],
            },
          },
          streamComplete: rejecting,
        })),
      };

      const onUpdate = vi.fn();
      const updater = createPartialUpdater({
        getVersion: () => undefined,
        store: store as any,
        client: client as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });

      await expect(
        updater("http://localhost/", ["R0"], false, undefined, tx),
      ).resolves.toBeUndefined();

      expect(onUpdate).toHaveBeenCalledOnce();
    });
  });
});
