import { describe, it, expect, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

// Mock assertSegmentStructure to suppress dev warnings
vi.mock("../browser/segment-structure-assert.js", () => ({
  assertSegmentStructure: vi.fn(),
}));

import {
  reconcileSegments,
  reconcileErrorSegments,
} from "../browser/segment-reconciler";
import { assertSegmentStructure } from "../browser/segment-structure-assert";

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("segment-reconciler", () => {
  describe("reconcileSegments", () => {
    describe("actor: action - loading preservation", () => {
      it("always preserves cached loading even when cached is undefined", () => {
        // cached loading=undefined, server loading=skeleton
        // action actor should preserve undefined (prevent tree change)
        const cached = seg("L0", {
          type: "layout",
          loading: undefined,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBeUndefined();
      });

      it("preserves cached loading=false when server returns skeleton", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: false as any,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe(false);
      });

      it("does not modify when loading values match", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe("skeleton");
      });

      it("does NOT clear loading on cached segments not in server response", () => {
        // Action actor should preserve cached loading as-is
        const cached = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe("skeleton");
      });
    });

    describe("actor: navigation - loading preservation", () => {
      it("preserves cached loading when defined and differs", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: false as any,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe(false);
      });

      it("does NOT preserve when cached loading is undefined", () => {
        // navigation actor should let server value through when cached is undefined
        const cached = seg("L0", {
          type: "layout",
          loading: undefined,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe("skeleton");
      });

      it("clears truthy loading on cached segments not in server response", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBeUndefined();
      });

      it("preserves loading=false on cached segments not in server response", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: false as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe(false);
      });

      it("preserves truthy loading on cached parallel segments not in server response", () => {
        const cached = seg("L0.@sidebar", {
          type: "parallel",
          loading: "sidebar-skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0.@sidebar"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe("sidebar-skeleton");
      });
    });

    describe("actor: stale-revalidation - same loading behavior as action", () => {
      it("preserves cached loading=undefined when server returns skeleton", () => {
        // After intercept -> leave-intercept, cached loading is undefined.
        // stale-revalidation must preserve it to prevent tree remount.
        const cached = seg("L0", {
          type: "layout",
          loading: undefined,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBeUndefined();
      });

      it("preserves cached loading=false when server returns skeleton", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: false as any,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe(false);
      });

      it("clears truthy loading on cached segments not in server response", () => {
        const cached = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBeUndefined();
      });

      it("preserves truthy loading on cached parallel segments not in server response", () => {
        const cached = seg("L0.@sidebar", {
          type: "parallel",
          loading: "sidebar-skeleton" as any,
        });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0.@sidebar"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].loading).toBe("sidebar-skeleton");
      });
    });

    describe("component preservation", () => {
      it("preserves cached component when server returns null for layout", () => {
        const cached = seg("L0", {
          type: "layout",
          component: "my-layout",
        });
        const server = seg("L0", {
          type: "layout",
          component: null as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].component).toBe("my-layout");
      });

      it("does not preserve when server returns null for non-layout", () => {
        const cached = seg("R0", {
          type: "route",
          component: "my-route",
        });
        const server = seg("R0", {
          type: "route",
          component: null as any,
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["R0"],
          diff: ["R0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].component).toBeNull();
      });

      it("does not preserve when server component is non-null", () => {
        const cached = seg("L0", {
          type: "layout",
          component: "old-layout",
        });
        const server = seg("L0", {
          type: "layout",
          component: "new-layout",
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].component).toBe("new-layout");
      });

      it("works with navigation actor too", () => {
        const cached = seg("L0", {
          type: "layout",
          component: "my-layout",
        });
        const server = seg("L0", {
          type: "layout",
          component: null as any,
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].component).toBe("my-layout");
      });
    });

    describe("mountPath preservation", () => {
      it("preserves cached mountPath when differs", () => {
        const cached = seg("L0", {
          type: "layout",
          mountPath: undefined,
        });
        const server = seg("L0", {
          type: "layout",
          mountPath: "/shop",
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].mountPath).toBeUndefined();
      });

      it("preserves when both actors", () => {
        const cached = seg("L0", {
          type: "layout",
          mountPath: "/shop",
        });
        const server = seg("L0", {
          type: "layout",
          mountPath: "/admin",
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(result.segments[0].mountPath).toBe("/shop");
      });
    });

    describe("loader merging", () => {
      it("merges loaders for action actor when server has fewer loaders", () => {
        const cached = seg("L0", {
          type: "layout",
          loaderIds: ["a", "b"],
          loaderDataPromise: Promise.resolve(["dataA", "dataB"]),
        });
        const server = seg("L0", {
          type: "layout",
          loaderIds: ["a"],
          loaderDataPromise: Promise.resolve(["freshA"]),
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        // Should have merged - loaderIds should be from cache
        expect(result.segments[0].loaderIds).toEqual(["a", "b"]);
      });

      it("does NOT merge loaders for navigation actor", () => {
        const cached = seg("L0", {
          type: "layout",
          loaderIds: ["a", "b"],
          loaderDataPromise: Promise.resolve(["dataA", "dataB"]),
        });
        const server = seg("L0", {
          type: "layout",
          loaderIds: ["a"],
          loaderDataPromise: Promise.resolve(["freshA"]),
        });

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        // Should NOT merge - loaderIds should be from server
        expect(result.segments[0].loaderIds).toEqual(["a"]);
      });

      it("merges loaders for stale-revalidation actor", () => {
        const cached = seg("L0", {
          type: "layout",
          loaderIds: ["a", "b"],
          loaderDataPromise: Promise.resolve(["dataA", "dataB"]),
        });
        const server = seg("L0", {
          type: "layout",
          loaderIds: ["a"],
          loaderDataPromise: Promise.resolve(["freshA"]),
        });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        // Should merge - loaderIds should be from cache
        expect(result.segments[0].loaderIds).toEqual(["a", "b"]);
      });
    });

    describe("intercept splitting", () => {
      it("separates intercept segments from main segments", () => {
        const layout = seg("L0", { type: "layout" });
        const route = seg("L0R0");
        const modal = seg("L0.@modal", {
          type: "parallel",
          namespace: "intercept:modal",
        });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0", "L0R0", "L0.@modal"],
          diff: ["L0", "L0R0", "L0.@modal"],
          serverSegments: [layout, route, modal],
          cachedSegments: [],
        });

        expect(result.mainSegments.map((s) => s.id)).toEqual(["L0", "L0R0"]);
        expect(result.interceptSegments.map((s) => s.id)).toEqual([
          "L0.@modal",
        ]);
        // segments contains all
        expect(result.segments.map((s) => s.id)).toEqual([
          "L0",
          "L0R0",
          "L0.@modal",
        ]);
      });
    });

    describe("missing segments", () => {
      it("handles gracefully when segment is missing from both server and cache", () => {
        const result = reconcileSegments({
          actor: "action",
          matched: ["L0", "MISSING"],
          diff: ["L0"],
          serverSegments: [seg("L0", { type: "layout" })],
          cachedSegments: [],
        });

        // MISSING should be filtered out (returns undefined from map, filtered by Boolean)
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0].id).toBe("L0");
      });

      it("uses cached segment when server does not include it", () => {
        const cached = seg("L0", { type: "layout", component: "cached" });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: [],
          serverSegments: [],
          cachedSegments: [cached],
        });

        expect(result.segments[0].component).toBe("cached");
      });
    });

    describe("assertSegmentStructure", () => {
      it("calls assertSegmentStructure with 'action-bridge' for action actor", () => {
        const cached = seg("L0", { type: "layout" });
        const server = seg("L0", { type: "layout" });

        reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(assertSegmentStructure).toHaveBeenCalledWith(
          cached,
          server,
          "action-bridge",
        );
      });

      it("calls assertSegmentStructure with 'partial-update' for navigation actor", () => {
        const cached = seg("L0", { type: "layout" });
        const server = seg("L0", { type: "layout" });

        reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        expect(assertSegmentStructure).toHaveBeenCalledWith(
          cached,
          server,
          "partial-update",
        );
      });

      it("asserts on the merged result (not raw server segment)", () => {
        // When loading differs, the assertion should see the merged result
        // with cached loading preserved, not the raw server segment
        const cached = seg("L0", {
          type: "layout",
          loading: undefined,
          mountPath: undefined,
        });
        const server = seg("L0", {
          type: "layout",
          loading: "skeleton" as any,
          mountPath: "/shop",
        });

        reconcileSegments({
          actor: "action",
          matched: ["L0"],
          diff: ["L0"],
          serverSegments: [server],
          cachedSegments: [cached],
        });

        // The second arg should be the merged segment, not the raw server segment
        const assertCall = (assertSegmentStructure as any).mock.calls.at(-1);
        expect(assertCall[0]).toBe(cached);
        expect(assertCall[1].loading).toBeUndefined(); // cached value preserved
        expect(assertCall[1].mountPath).toBeUndefined(); // cached value preserved
        expect(assertCall[2]).toBe("action-bridge");
      });
    });

    describe("full merge scenario", () => {
      it("merges all structural properties together during action", () => {
        const cachedLayout = seg("L0", {
          type: "layout",
          component: "my-layout",
          loading: false as any,
          mountPath: "/shop",
        });
        const cachedRoute = seg("L0R0", { component: "my-route" });

        const serverLayout = seg("L0", {
          type: "layout",
          component: null as any,
          loading: "skeleton" as any,
          mountPath: "/shop",
        });
        const serverRoute = seg("L0R0", { component: "updated" });

        const result = reconcileSegments({
          actor: "action",
          matched: ["L0", "L0R0"],
          diff: ["L0", "L0R0"],
          serverSegments: [serverLayout, serverRoute],
          cachedSegments: [cachedLayout, cachedRoute],
        });

        const layout = result.segments.find((s) => s.id === "L0")!;
        expect(layout.component).toBe("my-layout"); // preserved (server sent null)
        expect(layout.loading).toBe(false); // preserved (server sent skeleton)
        expect(layout.mountPath).toBe("/shop"); // unchanged

        const route = result.segments.find((s) => s.id === "L0R0")!;
        expect(route.component).toBe("updated"); // from server
      });
    });

    describe("insertMissingDiff", () => {
      it("inserts diff segments not in matched after their parent layout", () => {
        const layout = seg("M9L0L1", { type: "layout" });
        const route = seg("M9L0L1R0");
        // Loader segment with parent M9L0L1
        const loader = seg("M9L0L1D0.actionCounter", { type: "route" });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["M9L0L1", "M9L0L1R0"],
          diff: ["M9L0L1", "M9L0L1R0", "M9L0L1D0.actionCounter"],
          serverSegments: [layout, route, loader],
          cachedSegments: [],
          insertMissingDiff: true,
        });

        // Loader should be inserted after its parent layout
        const ids = result.segments.map((s) => s.id);
        expect(ids).toEqual(["M9L0L1", "M9L0L1D0.actionCounter", "M9L0L1R0"]);
      });

      it("does not insert when insertMissingDiff is false", () => {
        const layout = seg("M9L0L1", { type: "layout" });
        const route = seg("M9L0L1R0");
        const loader = seg("M9L0L1D0.actionCounter", { type: "route" });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["M9L0L1", "M9L0L1R0"],
          diff: ["M9L0L1", "M9L0L1R0", "M9L0L1D0.actionCounter"],
          serverSegments: [layout, route, loader],
          cachedSegments: [],
          insertMissingDiff: false,
        });

        // Only matched segments
        expect(result.segments.map((s) => s.id)).toEqual([
          "M9L0L1",
          "M9L0L1R0",
        ]);
      });

      it("splits intercepts after insertion", () => {
        const layout = seg("L0", { type: "layout" });
        const modal = seg("L0.@modal", {
          type: "parallel",
          namespace: "intercept:modal",
        });
        const loader = seg("L0D0.data", { type: "route" });

        const result = reconcileSegments({
          actor: "stale-revalidation",
          matched: ["L0"],
          diff: ["L0", "L0D0.data", "L0.@modal"],
          serverSegments: [layout, modal, loader],
          cachedSegments: [],
          insertMissingDiff: true,
        });

        // Loader inserted after L0, modal is an intercept
        expect(result.mainSegments.map((s) => s.id)).toEqual([
          "L0",
          "L0D0.data",
        ]);
        expect(result.interceptSegments.map((s) => s.id)).toEqual([
          "L0.@modal",
        ]);
      });

      it("appends non-loader diff segments to end", () => {
        const layout = seg("L0", { type: "layout" });
        const extra = seg("EXTRA");

        const result = reconcileSegments({
          actor: "navigation",
          matched: ["L0"],
          diff: ["L0", "EXTRA"],
          serverSegments: [layout, extra],
          cachedSegments: [],
          insertMissingDiff: true,
        });

        expect(result.segments.map((s) => s.id)).toEqual(["L0", "EXTRA"]);
      });
    });
  });

  describe("reconcileErrorSegments", () => {
    it("overlays error segments onto cached segments", () => {
      const cachedLayout = seg("L0", { type: "layout", component: "layout" });
      const cachedRoute = seg("L0R0", { component: "route" });
      const errorSegment = seg("L0R0", { component: "error-boundary" });

      const result = reconcileErrorSegments(
        [cachedLayout, cachedRoute],
        [errorSegment],
      );

      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].component).toBe("layout"); // preserved
      expect(result.segments[1].component).toBe("error-boundary"); // replaced
    });

    it("preserves all cached segments when no IDs match", () => {
      const cachedLayout = seg("L0", { type: "layout", component: "layout" });
      const cachedRoute = seg("L0R0", { component: "route" });
      const errorSegment = seg("L0R1", { component: "error-boundary" });

      const result = reconcileErrorSegments(
        [cachedLayout, cachedRoute],
        [errorSegment],
      );

      expect(result.segments).toHaveLength(2);
      expect(result.segments[0].component).toBe("layout");
      expect(result.segments[1].component).toBe("route");
    });

    it("splits intercept segments in the result", () => {
      const cachedLayout = seg("L0", { type: "layout" });
      const cachedModal = seg("L0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
      });
      const errorSegment = seg("L0", {
        type: "layout",
        component: "error-layout",
      });

      const result = reconcileErrorSegments(
        [cachedLayout, cachedModal],
        [errorSegment],
      );

      expect(result.mainSegments).toHaveLength(1);
      expect(result.mainSegments[0].component).toBe("error-layout");
      expect(result.interceptSegments).toHaveLength(1);
      expect(result.interceptSegments[0].id).toBe("L0.@modal");
    });

    it("handles empty cached segments", () => {
      const result = reconcileErrorSegments([], [seg("L0R0")]);

      expect(result.segments).toHaveLength(0);
    });
  });

  describe("memoization preservation", () => {
    // Without these guarantees, renderSegments' promise memoization is wiped
    // every reconcile that produces a fresh ref — which is most of them —
    // and the intercept flicker this exists to prevent comes back.
    it("carries contentPromise, contentSource, and layoutLoaderSources from cache onto in-diff merges", () => {
      const contentPromise = Promise.resolve("cached-content");
      const loaderSources = [Promise.resolve({ a: 1 })];
      const cached = seg("L0", {
        type: "layout",
        loading: "skeleton" as any,
        contentPromise,
        contentSource: "cached-component" as any,
        layoutLoaderSources: loaderSources,
        loaderDataPromise: Promise.resolve([{ a: 1 }]),
      });
      const server = seg("L0", {
        type: "layout",
        loading: "skeleton" as any,
      });

      const result = reconcileSegments({
        actor: "navigation",
        matched: ["L0"],
        diff: ["L0"],
        serverSegments: [server],
        cachedSegments: [cached],
      });

      const merged = result.segments[0];
      expect(merged).not.toBe(cached);
      expect(merged.contentPromise).toBe(contentPromise);
      expect(merged.contentSource).toBe("cached-component");
      expect(merged.layoutLoaderSources).toBe(loaderSources);
      expect(merged.loaderDataPromise).toBe(cached.loaderDataPromise);
    });

    it("does not overwrite a server-provided loaderDataPromise with the cached one (parallel intercept)", () => {
      const cachedPromise = Promise.resolve([{ stale: true }]);
      const freshPromise = Promise.resolve([{ fresh: true }]);
      const cached = seg("L0.@modal", {
        type: "parallel",
        slot: "@modal",
        loaderDataPromise: cachedPromise,
        loaderIds: ["modal-loader"],
      });
      const server = seg("L0.@modal", {
        type: "parallel",
        slot: "@modal",
        loaderDataPromise: freshPromise,
        loaderIds: ["modal-loader"],
      });

      const result = reconcileSegments({
        actor: "navigation",
        matched: ["L0.@modal"],
        diff: ["L0.@modal"],
        serverSegments: [server],
        cachedSegments: [cached],
      });

      expect(result.segments[0].loaderDataPromise).toBe(freshPromise);
    });
  });
});
