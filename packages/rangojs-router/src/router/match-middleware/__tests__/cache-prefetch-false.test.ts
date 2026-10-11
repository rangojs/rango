import { afterEach, describe, it, expect, vi } from "vitest";

// lookupRoute deserializes cached segments through segment-codec; same
// JSON-based Flight stand-in as cache-lookup-shell-replay-fallback.test.ts.
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    renderToReadableStream: (value: unknown) => {
      const bytes = encoder.encode(JSON.stringify(value) ?? "null");
      return new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    },
    createFromReadableStream: async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let result = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value, { stream: true });
      }
      return JSON.parse(result + decoder.decode());
    },
  };
}
vi.mock("@vitejs/plugin-rsc/rsc/server", pluginRscMock);
vi.mock("@vitejs/plugin-rsc/rsc/client", pluginRscMock);

import { setPrerenderStoreForTests, withCacheLookup } from "../cache-lookup.js";
import { withCacheStore } from "../cache-store.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { CacheScope } from "../../../cache/cache-scope.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { EntryData } from "../../../server/context.js";
import type { ResolvedSegment } from "../../../types.js";
import {
  planPrefetchDeferral,
  type PrefetchDeferral,
} from "../../segment-resolution/prefetch-deferral.js";
import { seg, gen, makeCacheStoreRouterContextStub } from "./helpers.js";

// `prefetch: false` and the route cache() record
// (docs/design/prefetch-false.md, "cache(), ppr and Prerender" and R5).
//
// - A fill keeps every stored segment the client holds, without a predicate.
//   It writes the record only when it holds nothing the record covers.
// - A prefetch that skips a layout above the cache boundary neither reads nor
//   writes the record: reading would replay the handle pushes of segments the
//   response does not carry. It skips the layout only when the client does
//   not hold it; decided per request, never per tree.
// - Any other prefetch reads and writes it as before.

const LAYOUT = "L0";
const ROUTE = "L0R0";

function chainEntry(
  type: "layout" | "route",
  shortCode: string,
  flagged: boolean,
): EntryData {
  return {
    type,
    id: shortCode,
    shortCode,
    loader: [],
    layout: [],
    parallel: {},
    intercept: [],
    ...(flagged ? { loading: "fallback", loadingPrefetch: false } : {}),
  } as unknown as EntryData;
}

/** Plans for a layout over a route, with cache() around the route. */
const plans = {
  none: (): PrefetchDeferral | undefined => undefined,
  fill: () =>
    planPrefetchDeferral(
      [chainEntry("layout", LAYOUT, false), chainEntry("route", ROUTE, false)],
      "fill",
      {},
      null,
    ),
  // The route's own fallback is flagged: its handler output is stored, so
  // nothing above the boundary can be skipped.
  prefetchStoredUnit: () =>
    planPrefetchDeferral(
      [chainEntry("layout", LAYOUT, false), chainEntry("route", ROUTE, true)],
      "prefetch",
      {},
      { enabled: true, boundary: ROUTE } as any,
    ),
  // The layout above the boundary is flagged: a prefetch from a client that
  // does not hold it skips it and, with it, everything the record holds.
  // `held`: what the request listed, which the plan is built from.
  prefetchUnitAbove: (held: string[] = []) =>
    planPrefetchDeferral(
      [chainEntry("layout", LAYOUT, true), chainEntry("route", ROUTE, false)],
      "prefetch",
      {},
      { enabled: true, boundary: ROUTE } as any,
      new Set(held),
    ),
};

async function lookup(
  plan: PrefetchDeferral | undefined,
  options: { routeRevalidates: boolean; clientSegments: string[] },
) {
  const store = new MemorySegmentCacheStore();
  await store.set(
    "partial:localhost/p",
    {
      segments: await serializeSegments([
        seg(LAYOUT, { type: "layout", belongsToRoute: false }),
        seg(ROUTE, { loading: "route-loading" as any }),
      ]),
      handles: "",
      expiresAt: Date.now() + 60_000,
    },
    60,
  );
  const url = new URL("http://localhost/p");
  const request = new Request(
    "http://localhost/p?_rsc_partial=true&_rsc_segments=L0,L0R0",
    { headers: { "X-RSC-Router-Client-Path": "/p" } },
  );
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx._cacheStore = store;

  const evaluateRevalidation = vi.fn(async () => options.routeRevalidates);
  const routerContext = {
    evaluateRevalidation,
    buildEntryRevalidateMap: () =>
      new Map([[ROUTE, { revalidate: [() => options.routeRevalidates] }]]),
    resolveLoadersOnlyWithRevalidation: undefined,
    resolveLoadersOnly: undefined,
  } as any;
  const ctx = {
    cacheScope: new CacheScope({ ttl: 30 }),
    isAction: false,
    isIntercept: false,
    isFullMatch: false,
    request,
    pathname: "/p",
    url,
    prevUrl: new URL("http://localhost/p"),
    prevParams: {},
    clientSegmentSet: new Set(options.clientSegments),
    entries: [],
    matched: { params: {}, routeKey: "list" },
    routeKey: "list",
    metricsStore: undefined,
    stale: false,
    handlerContext: { _prefetchDeferral: plan },
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;

  const live = seg("live-render");
  const yielded: ResolvedSegment[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      const mw = withCacheLookup(ctx, state);
      for await (const segment of mw(gen([live]))) yielded.push(segment);
    }),
  );
  return {
    hit: state.cacheHit,
    evaluateRevalidation,
    sent: Object.fromEntries(yielded.map((s) => [s.id, s.component !== null])),
  };
}

/**
 * `held`: what the client holds. A held route arrives with no component, as
 * resolution leaves a segment it did not render.
 */
async function store(
  plan: PrefetchDeferral | undefined,
  held: string[] = [],
  routerContext: any = makeCacheStoreRouterContextStub(),
) {
  const cacheRoute = vi.fn(async () => {});
  const request = new Request("https://app.test/p");
  const ctx = {
    cacheScope: {
      enabled: true,
      cacheRoute,
      recordTags: vi.fn(),
      covers: (id: string) => id === ROUTE,
    },
    isAction: false,
    request,
    pathname: "/p",
    clientSegmentSet: new Set<string>(held),
    metricsStore: undefined,
    isIntercept: false,
    matched: { params: {}, routeKey: "list" },
    url: new URL("https://app.test/p"),
    handlerContext: { _prefetchDeferral: plan },
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;
  const pending: Promise<void>[] = [];
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url: ctx.url,
    variables: {},
    executionContext: {
      waitUntil: (p: Promise<void>) => {
        pending.push(p);
      },
    } as any,
  });

  const yielded: string[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      const route = held.includes(ROUTE)
        ? seg(ROUTE, { component: null })
        : seg(ROUTE);
      for await (const s of withCacheStore(ctx, state)(gen([route]))) {
        yielded.push(s.id);
      }
      for (const cb of reqCtx._onResponseCallbacks) {
        cb(new Response(null, { status: 200 }));
      }
      await Promise.all(pending);
    }),
  );
  // The segments pass through whether or not the record is written.
  expect(yielded).toEqual([ROUTE]);
  return cacheRoute;
}

describe("withCacheLookup and prefetch: false", () => {
  const held = { routeRevalidates: true, clientSegments: [LAYOUT, ROUTE] };

  it("control: a navigation re-sends a held stored segment its predicate asks for", async () => {
    const result = await lookup(plans.none(), held);
    expect(result.hit).toBe(true);
    expect(result.sent).toEqual({ [LAYOUT]: false, [ROUTE]: true });
    expect(result.evaluateRevalidation).toHaveBeenCalled();
  });

  it("a fill keeps every stored segment the client holds and runs no predicate", async () => {
    const result = await lookup(plans.fill(), held);
    expect(result.hit).toBe(true);
    expect(result.sent).toEqual({ [LAYOUT]: false, [ROUTE]: false });
    expect(result.evaluateRevalidation).not.toHaveBeenCalled();
  });

  it("a fill serves the stored segment the client does not hold", async () => {
    const result = await lookup(plans.fill(), {
      routeRevalidates: false,
      clientSegments: [LAYOUT],
    });
    expect(result.sent).toEqual({ [LAYOUT]: false, [ROUTE]: true });
    expect(result.evaluateRevalidation).not.toHaveBeenCalled();
  });

  it("a prefetch of a stored flagged route reads the record as before", async () => {
    const result = await lookup(plans.prefetchStoredUnit(), {
      routeRevalidates: false,
      clientSegments: [LAYOUT],
    });
    expect(result.hit).toBe(true);
    expect(result.sent).toEqual({ [LAYOUT]: false, [ROUTE]: true });
  });

  it("a prefetch that skips a layout above the boundary does not read the record", async () => {
    const result = await lookup(plans.prefetchUnitAbove(), {
      routeRevalidates: false,
      clientSegments: [],
    });
    expect(result.hit).toBe(false);
    // What live resolution yields, placeholder included, is the response.
    expect(Object.keys(result.sent)).toEqual(["live-render"]);
  });

  // The same tree, from a client that holds the flagged layout: nothing
  // above the record is skipped, so the record answers.
  it("a prefetch that holds the flagged layout above the boundary reads the record", async () => {
    const result = await lookup(plans.prefetchUnitAbove([LAYOUT]), {
      routeRevalidates: false,
      clientSegments: [LAYOUT],
    });
    expect(result.hit).toBe(true);
    expect(result.sent).toEqual({ [LAYOUT]: false, [ROUTE]: true });
  });
});

// The prerender store answers before the cache scope (yieldFromStore). It
// re-sends a held stored segment when the params changed; a fill keeps it
// whatever the request says about where the client came from.
describe("withCacheLookup: a fill served from the prerender store", () => {
  afterEach(() => {
    setPrerenderStoreForTests(undefined);
  });

  async function fromStore(plan: PrefetchDeferral | undefined) {
    setPrerenderStoreForTests({
      get: async () => ({
        segments: await serializeSegments([seg(ROUTE)]),
        handles: "",
      }),
    } as any);
    const url = new URL("http://localhost/guide/b");
    const request = new Request(
      "http://localhost/guide/b?_rsc_partial=true&_rsc_segments=L0R0",
    );
    const reqCtx = createRequestContext<any>({
      env: {},
      request,
      url,
      variables: {},
    }) as RequestContext<any>;
    const ctx = {
      cacheScope: null,
      isAction: false,
      isIntercept: false,
      isFullMatch: false,
      request,
      pathname: "/guide/b",
      url,
      // The client says it came from another slug.
      prevUrl: new URL("http://localhost/guide/a"),
      prevParams: { slug: "a" },
      clientSegmentSet: new Set([ROUTE]),
      entries: [{ ...chainEntry("route", ROUTE, false), isPrerender: true }],
      matched: { params: { slug: "b" }, routeKey: "guide", pr: true },
      routeKey: "guide",
      metricsStore: undefined,
      stale: false,
      handlerContext: { _prefetchDeferral: plan },
      Store: { run: <T>(fn: () => T) => fn() },
    } as unknown as MatchContext<any>;
    const state = {
      cacheHit: false,
      interceptSegments: [],
    } as unknown as MatchPipelineState;
    const routerContext = {
      evaluateRevalidation: vi.fn(),
      resolveLoadersOnly: undefined,
      resolveLoadersOnlyWithRevalidation: vi.fn(async () => ({
        segments: [],
        matchedIds: [],
      })),
    } as any;

    const yielded: ResolvedSegment[] = [];
    await runWithRouterContext(routerContext, () =>
      runWithRequestContext(reqCtx, async () => {
        const mw = withCacheLookup(ctx, state);
        for await (const segment of mw(gen([]))) yielded.push(segment);
      }),
    );
    expect(state.cacheHit).toBe(true);
    return Object.fromEntries(yielded.map((s) => [s.id, s.component !== null]));
  }

  it("control: a navigation re-sends a held stored segment when the params changed", async () => {
    expect(await fromStore(plans.none())).toEqual({ [ROUTE]: true });
  });

  it("a fill keeps it", async () => {
    expect(await fromStore(plans.fill())).toEqual({ [ROUTE]: false });
  });
});

describe("withCacheStore and prefetch: false", () => {
  it("control: a navigation writes the record", async () => {
    expect(await store(plans.none())).toHaveBeenCalledTimes(1);
  });

  it("a prefetch of a stored flagged route writes the record as before", async () => {
    expect(await store(plans.prefetchStoredUnit())).toHaveBeenCalledTimes(1);
  });

  it("a fill that holds nothing the record covers writes it", async () => {
    expect(await store(plans.fill())).toHaveBeenCalledTimes(1);
    // Holding the layout above the boundary changes nothing.
    expect(await store(plans.fill(), [LAYOUT])).toHaveBeenCalledTimes(1);
  });

  it("a fill that holds a segment the record covers writes nothing and re-renders nothing", async () => {
    const stub = makeCacheStoreRouterContextStub();
    expect(await store(plans.fill(), [ROUTE], stub)).not.toHaveBeenCalled();
    // No proactive re-render either: it would run handlers a fill must not.
    expect(stub.createHandleStore).not.toHaveBeenCalled();
  });

  it("control: a navigation that holds a covered segment re-renders the route to write it", async () => {
    const stub = makeCacheStoreRouterContextStub();
    await store(plans.none(), [ROUTE], stub);
    // rerenderAndCacheRoute's first step.
    expect(stub.createHandleStore).toHaveBeenCalled();
  });

  it("a prefetch that skips a layout above the boundary writes nothing", async () => {
    expect(await store(plans.prefetchUnitAbove())).not.toHaveBeenCalled();
  });

  it("a prefetch that holds the flagged layout above the boundary writes the record", async () => {
    expect(
      await store(plans.prefetchUnitAbove([LAYOUT]), [LAYOUT]),
    ).toHaveBeenCalledTimes(1);
  });
});
