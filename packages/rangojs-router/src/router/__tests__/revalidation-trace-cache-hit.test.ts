/**
 * Tests that the cache-hit trace path in withCacheLookup emits
 * "new-segment" and "cached-no-rules" trace entries.
 */
import { describe, it, expect, vi } from "vitest";

// Enable debug mode
vi.mock("../../internal-debug.js", () => ({
  INTERNAL_RANGO_DEBUG: true,
}));

// Hoisted mocks so tests can inspect calls and control behavior
const {
  mockEvaluateRevalidation,
  mockRevalidateRules,
  mockResolveLoadersOnlyWithRevalidation,
} = vi.hoisted(() => ({
  mockEvaluateRevalidation: vi.fn(async () => false),
  // When set, buildEntryRevalidateMap returns these rules for matching segments
  mockRevalidateRules: { value: null as Map<string, any> | null },
  mockResolveLoadersOnlyWithRevalidation: vi.fn(async () => ({
    segments: [],
    matchedIds: [],
  })),
}));

// Mock router-context to provide evaluateRevalidation and buildEntryRevalidateMap
vi.mock("../router-context.js", () => ({
  getRouterContext: () => ({
    evaluateRevalidation: mockEvaluateRevalidation,
    buildEntryRevalidateMap: () => {
      if (mockRevalidateRules.value) return mockRevalidateRules.value;
      // Default: empty map — all segments get "cached-no-rules"
      return new Map();
    },
    resolveLoadersOnlyWithRevalidation: mockResolveLoadersOnlyWithRevalidation,
    resolveLoadersOnly: vi.fn(async () => []),
  }),
  runWithRouterContext: (_ctx: any, fn: any) => fn(),
}));

// Mock request-context
vi.mock("../../server/request-context.js", () => ({
  getRequestContext: () => undefined,
  _getRequestContext: () => undefined,
}));

import { withCacheLookup } from "../match-middleware/cache-lookup.js";
import {
  runWithRouterLogContext,
  startRevalidationTrace,
  flushRevalidationTrace,
} from "../logging.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import type { ResolvedSegment } from "../../types.js";

function makeSegment(
  id: string,
  type: string = "layout",
  overrides?: Partial<ResolvedSegment>,
): ResolvedSegment {
  return {
    id,
    namespace: "test-ns",
    type: type as any,
    index: 0,
    component: null,
    params: {},
    belongsToRoute: false,
    ...overrides,
  };
}

function makeCtx(
  clientSegmentIds: string[],
  cacheSegments: ResolvedSegment[],
): MatchContext<any> {
  const clientSegmentSet = new Set(clientSegmentIds);
  return {
    request: new Request("http://localhost/b"),
    url: new URL("http://localhost/b"),
    pathname: "/b",
    env: {},
    clientSegmentIds,
    clientSegmentSet,
    stale: false,
    prevUrl: new URL("http://localhost/a"),
    prevParams: {},
    prevMatch: null,
    matched: { params: {}, route: "test.route", pr: false },
    manifestEntry: {},
    entries: [],
    routeKey: "test.route",
    localRouteName: "test",
    handlerContext: {},
    loaderPromises: new Map(),
    routeMap: {},
    metricsStore: undefined,
    Store: { run: (fn: any) => fn() },
    interceptContextMatch: null,
    isFullMatch: false,
    isAction: false,
    isIntercept: false,
    actionContext: undefined,
    cacheScope: {
      enabled: true,
      lookupRoute: async () => ({
        segments: cacheSegments,
        shouldRevalidate: false,
      }),
      storeRoute: vi.fn(async () => {}),
    },
  } as any;
}

function makeState(): MatchPipelineState {
  return {
    cacheHit: false,
    shouldRevalidate: false,
    cachedSegments: undefined,
    cachedMatchedIds: undefined,
  } as any;
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) {
    results.push(item);
  }
  return results;
}

async function* empty(): AsyncGenerator<ResolvedSegment> {
  // nothing
}

describe("cache-hit trace entries", () => {
  it("emits new-segment trace for cached segment client doesn't have", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const seg = makeSegment("L0", "layout");
    const ctx = makeCtx([], [seg]); // client has no segments
    const state = makeState();

    const trace = await runWithRouterLogContext(
      { request: ctx.request, transaction: "test" },
      async () => {
        startRevalidationTrace({
          method: "GET",
          prevUrl: "http://localhost/a",
          nextUrl: "http://localhost/b",
          routeKey: "test.route",
          isAction: false,
        });

        const middleware = withCacheLookup(ctx, state);
        await collect(middleware(empty()));

        return flushRevalidationTrace();
      },
    );

    expect(trace).not.toBeNull();
    const newSegEntry = trace!.entries.find(
      (e) => e.segmentId === "L0" && e.reason === "new-segment",
    );
    expect(newSegEntry).toBeDefined();
    expect(newSegEntry!.source).toBe("cache-hit");
    expect(newSegEntry!.finalShouldRevalidate).toBe(true);

    consoleSpy.mockRestore();
  });

  it("emits cached-no-rules trace for cached segment client has with no revalidate fns", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const seg = makeSegment("L0", "layout");
    const ctx = makeCtx(["L0"], [seg]); // client HAS this segment
    const state = makeState();

    const trace = await runWithRouterLogContext(
      { request: ctx.request, transaction: "test" },
      async () => {
        startRevalidationTrace({
          method: "GET",
          prevUrl: "http://localhost/a",
          nextUrl: "http://localhost/b",
          routeKey: "test.route",
          isAction: false,
        });

        const middleware = withCacheLookup(ctx, state);
        await collect(middleware(empty()));

        return flushRevalidationTrace();
      },
    );

    expect(trace).not.toBeNull();
    const noRulesEntry = trace!.entries.find(
      (e) => e.segmentId === "L0" && e.reason === "cached-no-rules",
    );
    expect(noRulesEntry).toBeDefined();
    expect(noRulesEntry!.source).toBe("cache-hit");
    expect(noRulesEntry!.finalShouldRevalidate).toBe(false);

    consoleSpy.mockRestore();
  });

  it("emits both new-segment and cached-no-rules in one trace", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const segNew = makeSegment("L0", "layout");
    const segCached = makeSegment("R0", "route");
    // Client has R0 but not L0
    const ctx = makeCtx(["R0"], [segNew, segCached]);
    const state = makeState();

    const trace = await runWithRouterLogContext(
      { request: ctx.request, transaction: "test" },
      async () => {
        startRevalidationTrace({
          method: "GET",
          prevUrl: "http://localhost/a",
          nextUrl: "http://localhost/b",
          routeKey: "test.route",
          isAction: false,
        });

        const middleware = withCacheLookup(ctx, state);
        await collect(middleware(empty()));

        return flushRevalidationTrace();
      },
    );

    expect(trace!.entries).toHaveLength(2);
    expect(trace!.entries[0].segmentId).toBe("L0");
    expect(trace!.entries[0].reason).toBe("new-segment");
    expect(trace!.entries[1].segmentId).toBe("R0");
    expect(trace!.entries[1].reason).toBe("cached-no-rules");

    consoleSpy.mockRestore();
  });

  it("forwards ctx.stale to evaluateRevalidation for cached segments with rules", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockEvaluateRevalidation.mockClear();
    mockEvaluateRevalidation.mockResolvedValue(false);

    // Provide revalidation rules for L0 so evaluateRevalidation is called
    const rules = new Map();
    rules.set("L0", { revalidate: [() => true] });
    mockRevalidateRules.value = rules;

    const seg = makeSegment("L0", "layout");
    const ctx = makeCtx(["L0"], [seg]);
    // Mark the request as stale (simulating _rsc_stale=true from client)
    ctx.stale = true;
    const state = makeState();

    await runWithRouterLogContext(
      { request: ctx.request, transaction: "test" },
      async () => {
        startRevalidationTrace({
          method: "GET",
          prevUrl: "http://localhost/a",
          nextUrl: "http://localhost/b",
          routeKey: "test.route",
          isAction: false,
          stale: true,
        });

        const middleware = withCacheLookup(ctx, state);
        await collect(middleware(empty()));
      },
    );

    // evaluateRevalidation must receive stale: true from ctx.stale
    expect(mockEvaluateRevalidation).toHaveBeenCalledTimes(1);
    expect(mockEvaluateRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ stale: true }),
    );

    mockRevalidateRules.value = null;
    consoleSpy.mockRestore();
  });

  it("forwards ctx.stale to resolveLoadersOnlyWithRevalidation on store-hit path", async () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockResolveLoadersOnlyWithRevalidation.mockClear();
    mockResolveLoadersOnlyWithRevalidation.mockResolvedValue({
      segments: [],
      matchedIds: [],
    });

    // No cached segments with rules — the middleware takes the
    // resolveLoadersOnlyWithRevalidation early-exit path (line ~242)
    const seg = makeSegment("L0", "layout");
    const ctx = makeCtx(["L0"], [seg]);
    ctx.stale = true;
    const state = makeState();

    await runWithRouterLogContext(
      { request: ctx.request, transaction: "test" },
      async () => {
        startRevalidationTrace({
          method: "GET",
          prevUrl: "http://localhost/a",
          nextUrl: "http://localhost/b",
          routeKey: "test.route",
          isAction: false,
          stale: true,
        });

        const middleware = withCacheLookup(ctx, state);
        await collect(middleware(empty()));
      },
    );

    // resolveLoadersOnlyWithRevalidation must receive stale as last arg
    expect(mockResolveLoadersOnlyWithRevalidation).toHaveBeenCalledTimes(1);
    const lastArg = mockResolveLoadersOnlyWithRevalidation.mock.calls[0].at(-1);
    expect(lastArg).toBe(true);

    consoleSpy.mockRestore();
  });
});
