import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleCacheHit,
  handleCacheMiss,
  handleCacheHitIntercept,
  type CacheHandlerDeps,
  type CacheResult,
} from "../cache-handlers";
import type { ResolutionContext } from "../types";
import type { ResolvedSegment } from "../../types";

// Mock applyCacheRevalidation
vi.mock("../cache-revalidation.js", () => ({
  applyCacheRevalidation: vi.fn(),
}));

import { applyCacheRevalidation } from "../cache-revalidation.js";
const mockApplyCacheRevalidation = vi.mocked(applyCacheRevalidation);

describe("cache-handlers", () => {
  // Mock components
  const mockComponent = { type: "div", props: { children: "Component" } };
  const mockLoading = { type: "div", props: { children: "Loading" } };

  const createMockSegment = (
    id: string,
    options: Partial<ResolvedSegment> = {}
  ): ResolvedSegment => ({
    id,
    type: "layout",
    component: mockComponent as any,
    loading: mockLoading as any,
    params: {},
    routeKey: "test",
    ...options,
  });

  const createMockResolutionContext = (
    overrides: Partial<ResolutionContext> = {}
  ): ResolutionContext => ({
    request: new Request("http://localhost/test"),
    url: new URL("http://localhost/test"),
    pathname: "/test",
    prevUrl: new URL("http://localhost/prev"),
    previousUrlRaw: "/prev",
    interceptSourceUrl: null,
    stale: false,
    matched: {
      entry: {} as any,
      routeKey: "test.route",
      params: { id: "123" },
    },
    prevMatch: null,
    interceptContextMatch: null,
    manifestEntry: { shortCode: "M1L0C0" } as any,
    entries: [],
    clientSegmentIds: ["M1L0C0"],
    clientSegmentSet: new Set(["M1L0C0"]),
    prevParams: {},
    bindings: {},
    handlerContext: {
      params: { id: "123" },
      request: new Request("http://localhost/test"),
      searchParams: new URLSearchParams(),
      pathname: "/test",
      url: new URL("http://localhost/test"),
    } as any,
    loaderPromises: new Map(),
    metricsStore: null,
    isAction: false,
    localRouteName: "route",
    isSameRouteNavigation: false,
    ...overrides,
  });

  const createMockDeps = (
    overrides: Partial<CacheHandlerDeps> = {}
  ): CacheHandlerDeps => ({
    Store: {
      namespace: "#router",
      parent: null,
    },
    getContext: () => ({
      runWithStore: (_store: any, _ns: any, _parent: any, fn: any) => fn(),
    }),
    buildEntryRevalidateMap: vi.fn().mockReturnValue(new Map()),
    resolveLoadersOnlyWithRevalidation: vi.fn().mockResolvedValue({
      segments: [],
      matchedIds: [],
    }),
    resolveAllSegmentsWithRevalidation: vi.fn().mockResolvedValue({
      segments: [createMockSegment("M1L0C0R0", { type: "route" })],
      matchedIds: ["M1L0C0R0"],
    }),
    resolveInterceptEntry: vi.fn().mockResolvedValue([
      createMockSegment("M1L0C0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
        slot: "@modal",
      }),
    ]),
    resolveInterceptLoadersOnly: vi.fn().mockResolvedValue(null),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("handleCacheHit", () => {
    it("should apply revalidation to cached segments", async () => {
      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const cacheResult: CacheResult = {
        segments: [createMockSegment("M1L0C0"), createMockSegment("M1L0C0R0")],
        shouldRevalidate: false,
      };

      await handleCacheHit(ctx, deps, cacheResult);

      expect(mockApplyCacheRevalidation).toHaveBeenCalledWith(
        expect.objectContaining({
          cachedSegments: cacheResult.segments,
          clientSegmentSet: ctx.clientSegmentSet,
          routeKey: ctx.matched.routeKey,
        })
      );
    });

    it("should resolve loaders fresh", async () => {
      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const cacheResult: CacheResult = {
        segments: [createMockSegment("M1L0C0")],
        shouldRevalidate: false,
      };

      await handleCacheHit(ctx, deps, cacheResult);

      expect(deps.resolveLoadersOnlyWithRevalidation).toHaveBeenCalledWith(
        ctx.entries,
        ctx.handlerContext,
        ctx.clientSegmentSet,
        ctx.prevParams,
        ctx.request,
        ctx.prevUrl,
        ctx.url,
        ctx.matched.routeKey,
        ctx.actionContext
      );
    });

    it("should combine cached segments with fresh loaders", async () => {
      const cachedSegment = createMockSegment("M1L0C0");
      const loaderSegment = createMockSegment("M1L0C0D0", { type: "loader" });

      const ctx = createMockResolutionContext();
      const deps = createMockDeps({
        resolveLoadersOnlyWithRevalidation: vi.fn().mockResolvedValue({
          segments: [loaderSegment],
          matchedIds: ["M1L0C0D0"],
        }),
      });
      const cacheResult: CacheResult = {
        segments: [cachedSegment],
        shouldRevalidate: false,
      };

      const result = await handleCacheHit(ctx, deps, cacheResult);

      expect(result.segments).toHaveLength(2);
      expect(result.segments[0]).toBe(cachedSegment);
      expect(result.segments[1]).toBe(loaderSegment);
      expect(result.matchedIds).toEqual(["M1L0C0", "M1L0C0D0"]);
    });
  });

  describe("handleCacheMiss", () => {
    it("should resolve all segments with revalidation", async () => {
      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const slots: Record<string, any> = {};

      await handleCacheMiss(ctx, deps, null, slots);

      expect(deps.resolveAllSegmentsWithRevalidation).toHaveBeenCalledWith(
        ctx.entries,
        ctx.matched.routeKey,
        ctx.matched.params,
        ctx.handlerContext,
        ctx.clientSegmentSet,
        ctx.prevParams,
        ctx.request,
        ctx.prevUrl,
        ctx.url,
        ctx.loaderPromises,
        ctx.actionContext,
        null, // interceptResult
        ctx.localRouteName,
        ctx.pathname
      );
    });

    it("should resolve intercept segments when interceptResult provided", async () => {
      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const slots: Record<string, any> = {};
      const interceptResult = {
        intercept: { slotName: "@modal" },
        entry: {},
      } as any;

      const result = await handleCacheMiss(ctx, deps, interceptResult, slots);

      expect(deps.resolveInterceptEntry).toHaveBeenCalled();
      expect(result.interceptSegments).toHaveLength(1);
      expect(slots["@modal"]).toBeDefined();
      expect(slots["@modal"].active).toBe(true);
    });

    it("should return empty interceptSegments when no intercept", async () => {
      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const slots: Record<string, any> = {};

      const result = await handleCacheMiss(ctx, deps, null, slots);

      expect(deps.resolveInterceptEntry).not.toHaveBeenCalled();
      expect(result.interceptSegments).toHaveLength(0);
      expect(Object.keys(slots)).toHaveLength(0);
    });
  });

  describe("handleCacheHitIntercept", () => {
    it("should extract intercept segments from cached segments", async () => {
      const interceptSegment = createMockSegment("M1L0C0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
        slot: "@modal",
      });
      const regularSegment = createMockSegment("M1L0C0");

      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const slots: Record<string, any> = {};
      const interceptResult = {
        intercept: { slotName: "@modal" },
        entry: {},
      } as any;

      const result = await handleCacheHitIntercept(
        ctx,
        deps,
        interceptResult,
        [regularSegment, interceptSegment],
        slots
      );

      expect(result).toHaveLength(1);
      expect(result[0].namespace).toBe("intercept:modal");
      expect(slots["@modal"]).toBeDefined();
    });

    it("should re-resolve intercept loaders for fresh data", async () => {
      const interceptSegment = createMockSegment("M1L0C0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
        slot: "@modal",
      });

      const ctx = createMockResolutionContext();
      const deps = createMockDeps();
      const slots: Record<string, any> = {};
      const interceptResult = {
        intercept: { slotName: "@modal" },
        entry: {},
      } as any;

      await handleCacheHitIntercept(
        ctx,
        deps,
        interceptResult,
        [interceptSegment],
        slots
      );

      expect(deps.resolveInterceptLoadersOnly).toHaveBeenCalledWith(
        interceptResult.intercept,
        interceptResult.entry,
        ctx.matched.params,
        ctx.handlerContext,
        true,
        expect.any(Object) // getInterceptParams result
      );
    });

    it("should update loaderDataPromise when fresh loaders resolved", async () => {
      const interceptSegment = createMockSegment("M1L0C0.@modal", {
        type: "parallel",
        namespace: "intercept:modal",
        slot: "@modal",
      });

      const freshLoaderData = {
        loaderDataPromise: Promise.resolve({ data: "fresh" }),
        loaderIds: ["loader1"],
      };

      const ctx = createMockResolutionContext();
      const deps = createMockDeps({
        resolveInterceptLoadersOnly: vi.fn().mockResolvedValue(freshLoaderData),
      });
      const slots: Record<string, any> = {};
      const interceptResult = {
        intercept: { slotName: "@modal" },
        entry: {},
      } as any;

      const result = await handleCacheHitIntercept(
        ctx,
        deps,
        interceptResult,
        [interceptSegment],
        slots
      );

      expect(result[0].loaderDataPromise).toBe(freshLoaderData.loaderDataPromise);
      expect(result[0].loaderIds).toBe(freshLoaderData.loaderIds);
    });
  });
});
