import { describe, it, expect, vi } from "vitest";

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

import { withCacheLookup } from "../cache-lookup.js";
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
import type { ResolvedSegment } from "../../../types.js";
import { seg, gen } from "./helpers.js";

// The cache-hit segment loop decides, per cached segment the client holds,
// whether the response re-sends it. A PPR transition({ when }) decision
// (RequestContext._pprTransitionDecisions) must not change that decision: the
// live partial path omits a non-revalidated segment whatever its transition,
// and a replay HIT that kept the component replaced the client's segment
// (#986). Both segments carry a decision in every case below.

const LAYOUT = "L0";
const ROUTE = "L0R0";

/**
 * A `?page=2` navigation from `/p` served from a cached record of a layout
 * (no revalidate() rules; the default does not re-render it) and a route
 * whose revalidate() returns `routeRevalidates`.
 */
async function drain(
  routeRevalidates: boolean,
  clientSegments: string[],
): Promise<ResolvedSegment[]> {
  const store = new MemorySegmentCacheStore();
  await store.set(
    "partial:localhost/p?page=2",
    {
      segments: await serializeSegments([
        seg(LAYOUT, {
          type: "layout",
          belongsToRoute: false,
          loading: "layout-loading" as any,
        }),
        seg(ROUTE, { loading: "route-loading" as any }),
      ]),
      handles: "",
      expiresAt: Date.now() + 60_000,
    },
    60,
  );

  const url = new URL("http://localhost/p?page=2");
  const request = new Request(
    "http://localhost/p?page=2&_rsc_partial=true&_rsc_segments=L0,L0R0",
    { headers: { "X-RSC-Router-Client-Path": "/p" } },
  );
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx._cacheStore = store;
  reqCtx._pprTransitionDecisions = new Map([
    [LAYOUT, true],
    [ROUTE, true],
  ]);

  // Only the rule's presence matters: evaluateRevalidation decides.
  const routerContext = {
    evaluateRevalidation: async () => routeRevalidates,
    buildEntryRevalidateMap: () =>
      new Map([[ROUTE, { revalidate: [() => routeRevalidates] }]]),
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
    clientSegmentSet: new Set(clientSegments),
    entries: [],
    matched: { params: {}, routeKey: "list" },
    routeKey: "list",
    metricsStore: undefined,
    stale: false,
    handlerContext: {},
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;

  const yielded: ResolvedSegment[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      const mw = withCacheLookup(ctx, state);
      for await (const segment of mw(gen([]))) yielded.push(segment);
    }),
  );
  expect(state.cacheHit).toBe(true);
  return yielded;
}

const CLEARED = { component: false, loading: undefined };

describe("withCacheLookup — cache-hit segment decision with PPR transition decisions (#986)", () => {
  it.each([
    {
      label: "revalidate() false clears every segment the client holds",
      routeRevalidates: false,
      clientSegments: [LAYOUT, ROUTE],
      route: CLEARED,
    },
    {
      label: "revalidate() true sends the route with its component and loading",
      routeRevalidates: true,
      clientSegments: [LAYOUT, ROUTE],
      route: { component: true, loading: "route-loading" },
    },
    {
      label:
        "a route the client does not hold is sent whole, whatever revalidate() returns",
      routeRevalidates: false,
      clientSegments: [LAYOUT],
      route: { component: true, loading: "route-loading" },
    },
  ])("$label", async ({ routeRevalidates, clientSegments, route }) => {
    const segments = await drain(routeRevalidates, clientSegments);

    expect(
      Object.fromEntries(
        segments.map((s) => [
          s.id,
          { component: s.component !== null, loading: s.loading },
        ]),
      ),
    ).toEqual({ [LAYOUT]: CLEARED, [ROUTE]: route });
  });
});
