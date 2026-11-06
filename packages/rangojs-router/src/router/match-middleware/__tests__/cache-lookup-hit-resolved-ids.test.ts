import { describe, it, expect, vi } from "vitest";

// lookupRoute deserializes cached segments through segment-codec; same
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

// A stored record carries no `_handlerRan` (serializeSegments copies named
// fields), so a HIT that re-sent a segment listed nothing in `resolvedIds` and
// the browser kept that segment's handle values (handles/pushed-by.ts). The
// serve records the stored segments it sends in place of a re-run handler, and
// `buildMatchResult` names them in `resolvedIds` (match-result.ts).

const LAYOUT = "L0";
const ROUTE = "L0R0";

/**
 * A `?page=2` navigation from `/p` served from a cached record of a layout
 * (no revalidate() rules: the client keeps it) and a route whose revalidate()
 * returns `routeRevalidates`.
 */
async function drain(
  routeRevalidates: boolean,
  clientSegments: string[],
): Promise<{
  sent: string[];
  resolvedIds: string[];
  keptComponents: Record<string, boolean>;
}> {
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

  // Only the rule's presence matters: evaluateRevalidation decides.
  const routerContext = {
    evaluateRevalidation: async () => routeRevalidates,
    buildEntryRevalidateMap: () =>
      new Map([[ROUTE, { revalidate: [() => routeRevalidates] }]]),
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
  return {
    sent: yielded.map((s) => s.id),
    resolvedIds: [...(state.storedResolvedIds ?? [])],
    keptComponents: Object.fromEntries(
      yielded.map((s) => [s.id, s.component !== null]),
    ),
  };
}

describe("withCacheLookup — a HIT records the segments it sends as resolved", () => {
  it("a segment its revalidate() re-sends is resolved; a kept one is not", async () => {
    const { sent, resolvedIds } = await drain(true, [LAYOUT, ROUTE]);
    expect(sent).toEqual([LAYOUT, ROUTE]);
    expect(resolvedIds).toEqual([ROUTE]);
  });

  it("a segment the client does not hold is sent and resolved", async () => {
    const { resolvedIds } = await drain(false, [LAYOUT]);
    expect(resolvedIds).toEqual([ROUTE]);
  });

  it("a segment the rules keep is not resolved", async () => {
    const { sent, resolvedIds, keptComponents } = await drain(false, [
      LAYOUT,
      ROUTE,
    ]);
    expect(sent).toEqual([LAYOUT, ROUTE]);
    expect(resolvedIds).toEqual([]);
    // Both are kept: a kept segment loses its component (keepClientSegment).
    expect(keptComponents).toEqual({ [LAYOUT]: false, [ROUTE]: false });
  });
});
