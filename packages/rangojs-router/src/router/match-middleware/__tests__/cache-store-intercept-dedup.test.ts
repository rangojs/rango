import { describe, it, expect, vi } from "vitest";
import { withCacheStore } from "../cache-store.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context.js";
import type { ResolvedSegment } from "../../../types.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";

// B4: on a fresh (cache-miss) intercept navigation, the intercept slot segments
// flow through `source` into `allSegments` AND are also recorded on
// state.interceptSegments. The direct-cache path must cache each segment ONCE,
// not append the intercept segments a second time.

function seg(
  id: string,
  overrides: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: id,
    type: "route",
    index: 0,
    component: {} as any, // non-null so hasNullComponents stays false (direct path)
    params: {},
    belongsToRoute: true,
    ...overrides,
  } as ResolvedSegment;
}

async function* gen(segments: ResolvedSegment[]) {
  for (const s of segments) yield s;
}

function makeRouterContextStub() {
  // The direct-cache path destructures these but never calls them; stub them.
  return {
    createHandlerContext: vi.fn(),
    setupLoaderAccess: vi.fn(),
    resolveAllSegments: vi.fn(),
    resolveInterceptEntry: vi.fn(),
    createHandleStore: vi.fn(),
  } as any;
}

describe("withCacheStore — intercept segment dedup (B4)", () => {
  it("caches each segment once on a fresh intercept navigation", async () => {
    const layout = seg("R0");
    const page = seg("R0.page");
    const interceptSeg = seg("R0.@modal", { type: "parallel", slot: "@modal" });

    // The intercept segment flows through the stream (yielded by the inner
    // intercept middleware) AND is also assigned to state.interceptSegments.
    const yielded = [layout, page, interceptSeg];

    const cacheRoute = vi.fn(async () => {});
    const recordTags = vi.fn();
    const cacheScope = { enabled: true, cacheRoute, recordTags } as any;

    const ctx = {
      cacheScope,
      isAction: false,
      request: new Request("https://app.test/feed/photo/1"),
      pathname: "/feed/photo/1",
      clientSegmentSet: new Set<string>(),
      metricsStore: undefined,
      isIntercept: true,
      matched: { params: {}, routeKey: "feed" },
      url: new URL("https://app.test/feed/photo/1"),
    } as unknown as MatchContext<any>;

    const state = {
      cacheHit: false,
      interceptSegments: [interceptSeg],
    } as unknown as MatchPipelineState;

    // executionContext.waitUntil runs the scheduled cache write synchronously so
    // we can await it.
    const pending: Promise<void>[] = [];
    const reqCtx = createRequestContext<any>({
      env: {},
      request: ctx.request,
      url: ctx.url,
      variables: {},
      executionContext: {
        waitUntil: (p: Promise<void>) => {
          pending.push(p);
        },
      } as any,
    });

    await runWithRouterContext(makeRouterContextStub(), () =>
      runWithRequestContext(reqCtx, async () => {
        const mw = withCacheStore(ctx, state);
        // Drain the middleware (collects allSegments, registers onResponse).
        for await (const _ of mw(gen(yielded))) {
          // pass-through
        }
        // Fire the onResponse callback with a 200 so the cache write schedules.
        for (const cb of reqCtx._onResponseCallbacks) {
          cb(new Response(null, { status: 200 }));
        }
        await Promise.all(pending);
      }),
    );

    expect(cacheRoute).toHaveBeenCalledTimes(1);
    const cachedSegments = (
      cacheRoute.mock.calls[0] as unknown[]
    )[2] as ResolvedSegment[];
    const ids = cachedSegments.map((s) => s.id);

    // Each segment id appears exactly once — the intercept segment is not doubled.
    const counts = ids.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["R0.@modal"]).toBe(1);
    expect(counts["R0"]).toBe(1);
    expect(counts["R0.page"]).toBe(1);
  });
});
