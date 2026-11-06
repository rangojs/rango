/**
 * A stored segment carries no `_handlerRan`: serializeSegments
 * (cache/segment-codec.ts) copies named fields, and the mark belongs to the
 * request that ran the handler. serveStoredSegments therefore marks the
 * segments its HIT re-renders, where a live walk marks the handlers it runs.
 * match-result.ts lists them in resolvedIds, and the browser replaces their
 * handle values with the record's instead of keeping the page's
 * (handles/pushed-by.ts mergePartialHandleData).
 *
 * A full match marks nothing: its resolvedIds is every id already.
 */
import { describe, it, expect, vi } from "vitest";

// lookupRoute deserializes cached segments through segment-codec; the same
// JSON-based Flight stand-in as cache-lookup-ppr-transition-revalidate.test.ts.
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

const LAYOUT = "L0";
const ROUTE = "L0R0";

/**
 * The record a navigation wrote: a layout the client holds with no rules (the
 * default keeps it) and a route whose revalidate() asks for a re-render.
 */
async function drain(isFullMatch: boolean): Promise<ResolvedSegment[]> {
  const store = new MemorySegmentCacheStore();
  await store.set(
    isFullMatch ? "doc:localhost/p" : "partial:localhost/p",
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

  const url = new URL("http://localhost/p");
  const request = new Request(
    isFullMatch
      ? "http://localhost/p"
      : "http://localhost/p?_rsc_partial=true&_rsc_segments=L0,L0R0",
    { headers: isFullMatch ? {} : { "X-RSC-Router-Client-Path": "/p" } },
  );
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx.originalUrl = new URL(request.url);
  reqCtx._cacheStore = store;

  const routerContext = {
    evaluateRevalidation: async () => true,
    buildEntryRevalidateMap: () =>
      new Map([[ROUTE, { revalidate: [() => true] }]]),
    resolveLoadersOnly: undefined,
  } as any;

  const ctx = {
    cacheScope: new CacheScope({ ttl: 30 }),
    isAction: false,
    isIntercept: false,
    isFullMatch,
    request,
    pathname: "/p",
    url,
    prevUrl: new URL("http://localhost/p"),
    prevParams: {},
    // A document request mounts nothing yet.
    clientSegmentSet: isFullMatch ? new Set() : new Set([LAYOUT, ROUTE]),
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

/** Each segment's re-render mark and whether it carries its component. */
function marked(segments: ResolvedSegment[]) {
  return Object.fromEntries(
    segments.map((s) => [
      s.id,
      { ran: s._handlerRan === true, component: s.component !== null },
    ]),
  );
}

describe("withCacheLookup: a stored segment a HIT re-renders is marked as run", () => {
  it("a partial HIT: the re-rendered route is marked, the kept layout is not", async () => {
    expect(marked(await drain(false))).toEqual({
      [LAYOUT]: { ran: false, component: false },
      [ROUTE]: { ran: true, component: true },
    });
  });

  it("a document HIT: no segment is marked (resolvedIds is every id)", async () => {
    expect(marked(await drain(true))).toEqual({
      [LAYOUT]: { ran: false, component: true },
      [ROUTE]: { ran: false, component: true },
    });
  });
});
