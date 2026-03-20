import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  collectSegments,
  buildMatchResult,
  collectMatchResult,
} from "../match-result";
import type { ResolvedSegment } from "../../types";
import type { MatchContext, MatchPipelineState } from "../match-context";
import { createPipelineState } from "../match-context";

// Mock metrics module
vi.mock("../metrics", () => ({
  logMetrics: vi.fn(),
  generateServerTiming: vi.fn(() => "metric1;dur=10"),
  appendMetric: vi.fn(),
}));

// Helper to create async generator from array
async function* fromArray<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

// Helper to create a minimal mock MatchContext
function createMockContext(
  overrides: Partial<MatchContext> = {},
): MatchContext {
  return {
    request: new Request("https://example.com/test"),
    url: new URL("https://example.com/test"),
    pathname: "/test",
    env: {},
    bindings: {},
    clientSegmentIds: [],
    clientSegmentSet: new Set(),
    stale: false,
    prevUrl: new URL("https://example.com/prev"),
    prevParams: {},
    prevMatch: null,
    matched: {
      entry: {} as any,
      routeKey: "test",
      params: {},
      optionalParams: new Set<string>(),
    },
    manifestEntry: {} as any,
    entries: [],
    routeKey: "test",
    localRouteName: "test",
    handlerContext: {} as any,
    loaderPromises: new Map(),
    metricsStore: undefined,
    Store: {},
    interceptContextMatch: null,
    interceptSelectorContext: { prevMatched: null, prevParams: {} },
    isSameRouteNavigation: false,
    interceptResult: null,
    cacheScope: null,
    isIntercept: false,
    isAction: false,
    routeMiddleware: [],
    isFullMatch: false,
    ...overrides,
  } as MatchContext;
}

// Helper to create a test segment
function createSegment(
  id: string,
  options: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: id,
    type: "route",
    index: 0,
    component: `Component_${id}`,
    params: {},
    ...options,
  };
}

describe("match-result", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("collectSegments()", () => {
    it("should collect all segments from generator", async () => {
      const segments = [
        createSegment("seg1"),
        createSegment("seg2"),
        createSegment("seg3"),
      ];

      const result = await collectSegments(fromArray(segments));

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe("seg1");
      expect(result[1].id).toBe("seg2");
      expect(result[2].id).toBe("seg3");
    });

    it("should return empty array for empty generator", async () => {
      const result = await collectSegments(fromArray([]));
      expect(result).toEqual([]);
    });

    it("should preserve segment properties", async () => {
      const segment = createSegment("seg1", {
        type: "layout",
        component: "LayoutComponent",
        loading: "LoadingComponent",
        params: { id: "123" },
      });

      const result = await collectSegments(fromArray([segment]));

      expect(result[0]).toEqual(segment);
    });
  });

  describe("buildMatchResult() - full match", () => {
    it("should include all segments for full match", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [createSegment("layout"), createSegment("page")];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["layout", "page"]);
      expect(result.segments).toEqual(segments);
      expect(result.diff).toEqual(["layout", "page"]);
    });

    it("should include params from matched route", () => {
      const ctx = createMockContext({
        isFullMatch: true,
        matched: {
          entry: {} as any,
          routeKey: "users",
          params: { id: "123" },
          optionalParams: new Set<string>(),
        },
      });
      const state = createPipelineState();
      const segments = [createSegment("page")];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.params).toEqual({ id: "123" });
    });
  });

  describe("buildMatchResult() - partial match", () => {
    it("should use matchedIds from state for partial match", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["seg1", "seg2"];

      const segments = [createSegment("seg1"), createSegment("seg2")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["seg1", "seg2"]);
    });

    it("should filter out segments with null components", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["seg1", "seg2"];

      const segments = [
        createSegment("seg1", { component: null }),
        createSegment("seg2", { component: "RealComponent" }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].id).toBe("seg2");
    });

    it("should include loader segments even with null component", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["seg1"];

      const segments = [
        createSegment("seg1", { component: null, type: "loader" }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments).toHaveLength(1);
      expect(result.segments[0].type).toBe("loader");
    });

    it("should include intercept segments in matched array", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["page"];
      state.interceptSegments = [createSegment("modal")];

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["page", "modal"]);
    });
  });

  describe("buildMatchResult() - intercept handling", () => {
    it("should use clientSegmentIds when intercepting with client segments", () => {
      const ctx = createMockContext({
        isFullMatch: false,
        clientSegmentIds: ["layout", "page"],
        interceptResult: { route: "modal", slot: "@modal" } as any,
      });
      const state = createPipelineState();
      state.matchedIds = ["layout", "page"];
      state.interceptSegments = [createSegment("modal-content")];

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      // Should include client segments + intercept segments
      expect(result.matched).toEqual(["layout", "page", "modal-content"]);
    });

    it("should use segment IDs when intercepting without client segments (HMR)", () => {
      const ctx = createMockContext({
        isFullMatch: false,
        clientSegmentIds: [],
        interceptResult: { route: "modal", slot: "@modal" } as any,
      });
      const state = createPipelineState();
      state.interceptSegments = [createSegment("modal-content")];

      const segments = [createSegment("layout"), createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      // Should use actual segment IDs when client sent empty
      expect(result.matched).toEqual(["layout", "page"]);
    });
  });

  describe("buildMatchResult() - slots", () => {
    it("should include slots when present", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      state.slots = {
        "@modal": {
          active: true,
          segments: [createSegment("modal-seg")],
        },
      };

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.slots).toBeDefined();
      expect(result.slots!["@modal"].active).toBe(true);
    });

    it("should not include slots when empty", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.slots).toBeUndefined();
    });
  });

  describe("buildMatchResult() - route middleware", () => {
    it("should include routeMiddleware when present", () => {
      const ctx = createMockContext({
        isFullMatch: true,
        routeMiddleware: [{ handler: "auth", params: {} }],
      });
      const state = createPipelineState();

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.routeMiddleware).toHaveLength(1);
    });

    it("should not include routeMiddleware when empty", () => {
      const ctx = createMockContext({
        isFullMatch: true,
        routeMiddleware: [],
      });
      const state = createPipelineState();

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.routeMiddleware).toBeUndefined();
    });
  });

  describe("collectMatchResult()", () => {
    it("should collect segments and build result", async () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [createSegment("seg1"), createSegment("seg2")];

      const result = await collectMatchResult(fromArray(segments), ctx, state);

      expect(result.matched).toEqual(["seg1", "seg2"]);
      expect(result.segments).toHaveLength(2);
    });

    it("should update state.segments if not already set", async () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [createSegment("seg1")];

      await collectMatchResult(fromArray(segments), ctx, state);

      expect(state.segments).toHaveLength(1);
      expect(state.segments[0].id).toBe("seg1");
    });

    it("should not overwrite state.segments if already set", async () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      state.segments = [createSegment("existing")];

      const segments = [createSegment("new")];
      await collectMatchResult(fromArray(segments), ctx, state);

      expect(state.segments).toHaveLength(1);
      expect(state.segments[0].id).toBe("existing");
    });
  });

  describe("edge cases", () => {
    it("should handle large number of segments", async () => {
      const segments = Array.from({ length: 100 }, (_, i) =>
        createSegment(`seg${i}`),
      );
      const result = await collectSegments(fromArray(segments));

      expect(result).toHaveLength(100);
      expect(result[0].id).toBe("seg0");
      expect(result[99].id).toBe("seg99");
    });

    it("should handle mixed segment types", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [
        createSegment("layout", { type: "layout" }),
        createSegment("page", { type: "route" }),
        createSegment("loader1", { type: "loader" }),
        createSegment("parallel", { type: "parallel", slot: "@sidebar" }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["layout", "page", "loader1", "parallel"]);
      expect(result.segments).toHaveLength(4);
    });

    it("should handle segments with complex params", () => {
      const ctx = createMockContext({
        isFullMatch: true,
        matched: {
          entry: {} as any,
          routeKey: "users/posts",
          params: { userId: "123", postId: "456" },
          optionalParams: new Set<string>(),
        },
      });
      const state = createPipelineState();
      const segments = [
        createSegment("page", { params: { userId: "123", postId: "456" } }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.params).toEqual({ userId: "123", postId: "456" });
    });

    it("should handle multiple intercept segments", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["page"];
      state.interceptSegments = [
        createSegment("modal1"),
        createSegment("modal2"),
        createSegment("modal3"),
      ];

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["page", "modal1", "modal2", "modal3"]);
    });

    it("should handle multiple slots", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      state.slots = {
        "@modal": {
          active: true,
          segments: [createSegment("modal-content")],
        },
        "@sidebar": {
          active: true,
          segments: [createSegment("sidebar-content")],
        },
        "@drawer": {
          active: false,
          segments: [],
        },
      };

      const segments = [createSegment("page")];
      const result = buildMatchResult(segments, ctx, state);

      expect(result.slots).toBeDefined();
      expect(Object.keys(result.slots!)).toHaveLength(3);
      expect(result.slots!["@modal"].active).toBe(true);
      expect(result.slots!["@sidebar"].active).toBe(true);
      expect(result.slots!["@drawer"].active).toBe(false);
    });

    it("should handle segments with loading components", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [
        createSegment("page", {
          loading: "LoadingSpinner",
        }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments[0].loading).toBe("LoadingSpinner");
    });

    it("should handle segments with layout components", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [
        createSegment("layout", {
          type: "layout",
          layout: "LayoutWrapper",
        }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments[0].layout).toBe("LayoutWrapper");
    });

    it("should handle partial match with all null components", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["seg1", "seg2"];

      const segments = [
        createSegment("seg1", { component: null }),
        createSegment("seg2", { component: null }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.matched).toEqual(["seg1", "seg2"]);
      expect(result.segments).toHaveLength(0); // All filtered out
      expect(result.diff).toEqual([]); // No segments to render
    });

    it("should handle empty segment list", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();

      const result = buildMatchResult([], ctx, state);

      expect(result.matched).toEqual([]);
      expect(result.segments).toEqual([]);
      expect(result.diff).toEqual([]);
    });

    it("should handle segments with namespace", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [
        createSegment("intercept:modal:content", {
          namespace: "intercept:modal",
        }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments[0].namespace).toBe("intercept:modal");
    });

    it("should handle mixed loaders and routes in partial match", () => {
      const ctx = createMockContext({ isFullMatch: false });
      const state = createPipelineState();
      state.matchedIds = ["route1", "route2", "loader1", "loader2"];

      const segments = [
        createSegment("route1", { component: null, type: "route" }),
        createSegment("route2", { component: "RouteComponent", type: "route" }),
        createSegment("loader1", { component: null, type: "loader" }),
        createSegment("loader2", { component: null, type: "loader" }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      // Loaders should be included even with null component
      // Routes with null component should be filtered
      expect(result.segments).toHaveLength(3); // route2, loader1, loader2
      expect(result.segments.map((s) => s.id)).toEqual([
        "route2",
        "loader1",
        "loader2",
      ]);
    });

    it("should preserve segment index", () => {
      const ctx = createMockContext({ isFullMatch: true });
      const state = createPipelineState();
      const segments = [
        createSegment("seg0", { index: 0 }),
        createSegment("seg1", { index: 1 }),
        createSegment("seg2", { index: 2 }),
      ];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.segments[0].index).toBe(0);
      expect(result.segments[1].index).toBe(1);
      expect(result.segments[2].index).toBe(2);
    });

    it("should handle multiple route middleware", () => {
      const ctx = createMockContext({
        isFullMatch: true,
        routeMiddleware: [
          { handler: "auth", params: {} },
          { handler: "logger", params: { level: "debug" } },
          { handler: "rateLimit", params: { max: "100" } },
        ],
      });
      const state = createPipelineState();
      const segments = [createSegment("page")];

      const result = buildMatchResult(segments, ctx, state);

      expect(result.routeMiddleware).toHaveLength(3);
      expect(result.routeMiddleware![0].handler).toBe("auth");
      expect(result.routeMiddleware![1].handler).toBe("logger");
      expect(result.routeMiddleware![2].handler).toBe("rateLimit");
    });
  });
});
