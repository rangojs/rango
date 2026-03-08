import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";

// Capture the mock router context so tests can inspect/override it
const mockRouterCtx = {
  getRequestContext: vi.fn(),
  createHandleStore: vi.fn(() => ({ id: "fresh-handle-store", seal: vi.fn() })),
  createHandlerContext: vi.fn(() => ({ id: "fresh-handler-context" }) as any),
  setupLoaderAccess: vi.fn(),
  resolveAllSegments: vi.fn(async () => [] as ResolvedSegment[]),
  resolveInterceptEntry: vi.fn(async () => [] as ResolvedSegment[]),
};

vi.mock("../router-context.js", () => ({
  getRouterContext: () => mockRouterCtx,
}));

vi.mock("../logging.js", () => ({
  debugLog: vi.fn(),
  debugWarn: vi.fn(),
}));

// Import after mocks
const { withBackgroundRevalidation } =
  await import("../match-middleware/background-revalidation.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSegment(id: string, component: any = "comp"): ResolvedSegment {
  return {
    id,
    namespace: "ns",
    type: "layout",
    index: 0,
    component,
    params: {},
    belongsToRoute: false,
  };
}

async function* toAsyncGen<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

function makeCtx(overrides: Partial<MatchContext> = {}): MatchContext {
  return {
    pathname: "/test",
    isFullMatch: false,
    entries: [{ id: "entry" }] as any,
    routeKey: "test.route",
    matched: {
      params: { id: "1" },
      routeKey: "test.route",
      responseType: "document",
    } as any,
    url: new URL("http://localhost/test"),
    request: new Request("http://localhost/test"),
    env: {},
    routeMap: {},
    loaderPromises: new Map([["existing-loader", Promise.resolve("stale")]]),
    handlerContext: { id: "original-handler-context" } as any,
    interceptResult: null,
    isIntercept: false,
    cacheScope: {
      enabled: true,
      cacheRoute: vi.fn().mockResolvedValue(undefined),
    } as any,
    Store: { run: <T>(fn: () => T) => fn() },
    ...overrides,
  } as any;
}

function makeState(
  overrides: Partial<MatchPipelineState> = {},
): MatchPipelineState {
  return {
    cacheHit: true,
    shouldRevalidate: true,
    segments: [],
    matchedIds: [],
    interceptSegments: [],
    slots: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("withBackgroundRevalidation", () => {
  let waitUntilFns: Array<() => Promise<void>>;
  let mockRequestCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilFns = [];
    mockRequestCtx = {
      _handleStore: { id: "original-handle-store" },
      waitUntil: (fn: () => Promise<void>) => waitUntilFns.push(fn),
    };
    mockRouterCtx.getRequestContext.mockReturnValue(mockRequestCtx);
  });

  describe("loader isolation (regression: stale memoization map)", () => {
    it("creates fresh loaderPromises instead of reusing foreground map", async () => {
      const foregroundLoaderPromises = new Map([
        ["loader-a", Promise.resolve("stale-data")],
      ]);
      const ctx = makeCtx({ loaderPromises: foregroundLoaderPromises });
      const state = makeState();

      const freshSegments: ResolvedSegment[] = [
        makeSegment("L0", "fresh-component"),
      ];
      mockRouterCtx.resolveAllSegments.mockResolvedValue(freshSegments);

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));

      expect(waitUntilFns).toHaveLength(1);
      await waitUntilFns[0]();

      // setupLoaderAccess must be called with a fresh (empty) Map,
      // not the foreground's populated map
      expect(mockRouterCtx.setupLoaderAccess).toHaveBeenCalledTimes(1);
      const [, loaderMap] = mockRouterCtx.setupLoaderAccess.mock.calls[0];
      expect(loaderMap).toBeInstanceOf(Map);
      expect(loaderMap.size).toBe(0);
      expect(loaderMap).not.toBe(foregroundLoaderPromises);
    });

    it("creates fresh handlerContext instead of reusing foreground context", async () => {
      const ctx = makeCtx();
      const state = makeState();

      mockRouterCtx.resolveAllSegments.mockResolvedValue(
        [] as ResolvedSegment[],
      );

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      // createHandlerContext must be called (fresh context)
      expect(mockRouterCtx.createHandlerContext).toHaveBeenCalledTimes(1);

      // resolveAllSegments must receive the fresh context, not the original
      const call = mockRouterCtx.resolveAllSegments.mock.calls[0] as any[];
      const handlerCtx = call[3];
      const loaderPromises = call[4] as Map<string, Promise<any>>;
      expect(handlerCtx).toEqual({ id: "fresh-handler-context" });
      expect(loaderPromises.size).toBe(0);
    });
  });

  describe("null component prevention (regression: partial caching nulls)", () => {
    it("uses resolveAllSegments (not revalidation-aware) for partial requests", async () => {
      const ctx = makeCtx({ isFullMatch: false });
      const state = makeState();

      const completeSegments: ResolvedSegment[] = [
        makeSegment("L0", "layout-component"),
        makeSegment("R0", "route-component"),
      ];
      mockRouterCtx.resolveAllSegments.mockResolvedValue(completeSegments);

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      // Must call resolveAllSegments (fresh, no revalidation),
      // NOT resolveAllSegmentsWithRevalidation
      expect(mockRouterCtx.resolveAllSegments).toHaveBeenCalledTimes(1);

      // Segments passed to cacheRoute must all have non-null components
      const cacheRoute = ctx.cacheScope!.cacheRoute as ReturnType<typeof vi.fn>;
      expect(cacheRoute).toHaveBeenCalledTimes(1);
      const cached: ResolvedSegment[] = cacheRoute.mock.calls[0][2];
      for (const seg of cached) {
        expect(seg.component).not.toBeNull();
      }
    });

    it("uses resolveAllSegments for full match requests too", async () => {
      const ctx = makeCtx({ isFullMatch: true });
      const state = makeState();

      mockRouterCtx.resolveAllSegments.mockResolvedValue([
        makeSegment("L0", "comp"),
      ] as ResolvedSegment[]);

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      expect(mockRouterCtx.resolveAllSegments).toHaveBeenCalledTimes(1);
    });
  });

  describe("handleStore save/restore (regression: cross-task contamination)", () => {
    it("restores original handleStore after successful revalidation", async () => {
      const ctx = makeCtx();
      const state = makeState();

      mockRouterCtx.resolveAllSegments.mockResolvedValue(
        [] as ResolvedSegment[],
      );

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      expect(mockRequestCtx._handleStore).toEqual({
        id: "original-handle-store",
      });
    });

    it("restores original handleStore after failed revalidation", async () => {
      const ctx = makeCtx();
      const state = makeState();

      mockRouterCtx.resolveAllSegments.mockRejectedValue(
        new Error("resolution failed"),
      );

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      expect(mockRequestCtx._handleStore).toEqual({
        id: "original-handle-store",
      });
    });

    it("uses a fresh handleStore during background resolution", async () => {
      const ctx = makeCtx();
      const state = makeState();

      let handleStoreDuringResolution: any;
      mockRouterCtx.resolveAllSegments.mockImplementation(
        async (): Promise<ResolvedSegment[]> => {
          handleStoreDuringResolution = mockRequestCtx._handleStore;
          return [];
        },
      );

      const middleware = withBackgroundRevalidation(ctx, state);
      await drain(middleware(toAsyncGen([])));
      await waitUntilFns[0]();

      expect(handleStoreDuringResolution).toMatchObject({
        id: "fresh-handle-store",
      });
      // And restored after
      expect(mockRequestCtx._handleStore).toEqual({
        id: "original-handle-store",
      });
    });
  });
});
