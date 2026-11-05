/**
 * A stored hit marks the segments it serves from the record, so
 * `buildMatchResult` lists them in `resolvedIds` as the MISS that wrote the
 * record did.
 *
 * The mark is the serve decision (serveStoredSegments): a segment the send
 * rule serves answers with the record's copy of its handler run, empty
 * included, and the browser replaces what it holds for it. A segment the rule
 * keeps answers with nothing of its own: the client's values stand, as on a
 * live walk that did not run its handler (handles/pushed-by.ts
 * mergePartialHandleData). Both sources serve through this one function: a
 * route cache() record and a Prerender() artifact.
 */
import { describe, it, expect, vi } from "vitest";

const prerender = vi.hoisted(() => ({
  entry: null as { segments: unknown[]; handles: string } | null,
}));

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => prerender.entry }),
}));

// lookupRoute decodes segments through segment-codec; the same JSON stand-in
// as cache-lookup-owned-pushes.test.ts.
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
import { buildEntryRevalidateMap } from "../../segment-resolution/revalidation.js";
import type { EntryData } from "../../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { CachedEntryData } from "../../../cache/types.js";
import type { ResolvedSegment } from "../../../types.js";
import { seg, gen } from "./helpers.js";

/** A layout that always revalidates, and the route under it. */
const ENTRIES = [
  {
    id: "layout",
    shortCode: "L0",
    type: "layout",
    layout: [
      {
        id: "route",
        shortCode: "R0",
        type: "route",
        layout: [],
        parallel: {},
        revalidate: [],
      },
    ],
    parallel: {},
    revalidate: [() => true],
  },
] as unknown as EntryData[];

/** The record both sources store: both segments rendered, no handle pushes. */
async function record(): Promise<CachedEntryData> {
  return {
    segments: await serializeSegments([
      seg("L0", { type: "layout" }),
      seg("R0"),
    ]),
    handles: "",
    expiresAt: Date.now() + 60_000,
  };
}

/** Serve one partial navigation holding both segments, from `source`. */
async function servedFrom(
  source: "cache" | "prerender",
  /** The page the client is on has different params than the target. */
  paramsChanged = false,
): Promise<{
  segments: ResolvedSegment[];
  cacheHit: boolean;
}> {
  const url = new URL("http://localhost/p");
  const originalUrl = new URL("http://localhost/p?_rsc_partial=true");
  const store = new MemorySegmentCacheStore();
  const entry = await record();
  if (source === "cache") await store.set("partial:localhost/p", entry, 60);
  else prerender.entry = entry;
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
    // The page the client is on: same search, so only params and the layout's
    // revalidate() ask for a re-render.
    prevUrl: url,
    prevParams: paramsChanged ? { id: "1" } : {},
    // No intercept: the slot's comparison page is the page's own.
    interceptPrev: { url, params: {} },
    clientSegmentSet: new Set(["L0", "R0"]),
    entries: ENTRIES,
    matched: { params: {}, routeKey: "p", pr: source === "prerender" },
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
    evaluateRevalidation: vi.fn(async () => true),
    buildEntryRevalidateMap,
    resolveLoadersOnly: undefined,
  } as any;
  const segments: ResolvedSegment[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of withCacheLookup(ctx, state)(gen([]))) {
        segments.push(segment);
      }
    }),
  );
  return { segments, cacheHit: state.cacheHit };
}

describe("a stored hit marks the segments it serves", () => {
  it("a cache() record: the revalidated layout is marked, the kept route is not", async () => {
    const { segments, cacheHit } = await servedFrom("cache");
    expect(cacheHit).toBe(true);
    const byId = new Map(segments.map((s) => [s.id, s]));
    expect(byId.get("L0")?._handlerRan).toBe(true);
    expect(byId.get("R0")?._handlerRan).toBeUndefined();
    // Kept: the client's copy stands, so the record's is nulled.
    expect(byId.get("R0")?.component).toBeNull();
    expect(byId.get("L0")?.component).not.toBeNull();
  });

  it("a Prerender() artifact: equal params keep both, and neither is marked", async () => {
    const { segments, cacheHit } = await servedFrom("prerender");
    expect(cacheHit).toBe(true);
    expect(segments.map((s) => [s.id, s._handlerRan, s.component])).toEqual([
      ["L0", undefined, null],
      ["R0", undefined, null],
    ]);
  });

  it("a Prerender() artifact: changed params send both again, and both are marked", async () => {
    const { segments, cacheHit } = await servedFrom("prerender", true);
    expect(cacheHit).toBe(true);
    expect(segments.map((s) => [s.id, s._handlerRan])).toEqual([
      ["L0", true],
      ["R0", true],
    ]);
  });
});
