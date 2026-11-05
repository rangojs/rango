/**
 * A stored segment a HIT re-serves stands for its handler's run: the record's
 * values are replayed for it (restoreHandles' `sent`), so the browser replaces
 * its bucket as it does for a live run, and match-result.ts lists it in
 * resolvedIds from the same `_handlerRan` mark the live walk sets. A segment
 * the send decision keeps stays unmarked: its values stay the client's.
 *
 * The record itself cannot answer this: serializeSegments (segment-codec.ts)
 * copies named metadata fields, so `_handlerRan` is not stored and a HIT used
 * to list no stored segment at all.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

// lookupRoute decodes segments and handles through segment-codec; the same
// JSON stand-in as cache-lookup-owned-pushes.test.ts.
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
import type { EntryData } from "../../../server/context.js";
import type { ResolvedSegment } from "../../../types.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import { seg, gen } from "./helpers.js";

/** The re-run layout, the kept layout, and the route. */
const RERUN = "R0";
const KEPT = "R1";
const ROUTE = "R2";

function entry(shortCode: string, type: "layout" | "route"): EntryData {
  return {
    id: shortCode,
    shortCode,
    type,
    layout: [],
    parallel: {},
    revalidate: type === "route" ? [] : [() => true],
  } as unknown as EntryData;
}

const ENTRIES = [
  entry(RERUN, "layout"),
  entry(KEPT, "layout"),
  entry(ROUTE, "route"),
];

/** What the record holds: every segment the MISS resolved. */
async function record() {
  return {
    segments: await serializeSegments([
      seg(RERUN, { type: "layout" }),
      seg(KEPT, { type: "layout" }),
      seg(ROUTE),
    ]),
    handles: "",
    expiresAt: Date.now() + 60_000,
  };
}

/**
 * Serve a partial request for /p from a record holding every segment, with
 * the client holding all three. The router's revalidation decides which the
 * HIT sends: the re-run layout's rule says yes, the kept layout's says no, and
 * the route takes the default (an unchanged search and params keep it).
 */
async function serve(): Promise<ResolvedSegment[]> {
  const store = new MemorySegmentCacheStore();
  await store.set("partial:localhost/p", await record(), 60);
  const url = new URL("http://localhost/p");
  const originalUrl = new URL("http://localhost/p?_rsc_partial=true");
  const request = new Request(originalUrl, {
    headers: { "X-RSC-Router-Client-Path": "/from" },
  });
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx.originalUrl = originalUrl;
  reqCtx._cacheStore = store;

  const ctx = {
    cacheScope: new CacheScope({ ttl: 30 }),
    isAction: false,
    isIntercept: false,
    isFullMatch: false,
    request,
    pathname: "/p",
    url,
    prevUrl: new URL("http://localhost/from"),
    prevParams: {},
    clientSegmentSet: new Set([RERUN, KEPT, ROUTE]),
    entries: ENTRIES,
    matched: { params: {}, routeKey: "p" },
    routeKey: "p",
    metricsStore: undefined,
    stale: false,
    handlerContext: {},
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;

  const routerContext = {
    // The re-run layout's rule asks for it; the kept layout's declines.
    evaluateRevalidation: vi.fn(
      async ({ segment }: { segment: ResolvedSegment }) => segment.id === RERUN,
    ),
    buildEntryRevalidateMap: () =>
      new Map([
        [RERUN, { revalidate: [() => true] }],
        [KEPT, { revalidate: [() => false] }],
      ]),
    resolveLoadersOnly: undefined,
  } as any;

  const served: ResolvedSegment[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of withCacheLookup(ctx, state)(gen([]))) {
        served.push(segment);
      }
    }),
  );
  expect(state.cacheHit).toBe(true);
  return served;
}

describe("withCacheLookup: a stored segment a HIT serves is a resolved id", () => {
  it("marks the segments it sends and leaves the kept ones unmarked", async () => {
    const served = await serve();
    const byId = new Map(served.map((segment) => [segment.id, segment]));
    expect(byId.get(RERUN)?._handlerRan).toBe(true);
    // A rule that declines, and the default on an equal search and params:
    // both keep the client's copy, and neither is a resolved id.
    expect(byId.get(KEPT)?._handlerRan).toBeUndefined();
    expect(byId.get(ROUTE)?._handlerRan).toBeUndefined();
    expect(byId.get(KEPT)?.component).toBeNull();
  });
});
