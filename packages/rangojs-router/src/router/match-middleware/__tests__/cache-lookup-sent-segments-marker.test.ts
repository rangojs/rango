/**
 * withCacheLookup marks each stored segment it sends, and none it keeps.
 *
 * The marker is what match-result.ts reads to build `resolvedIds`: the runs
 * whose handle values this response replaces in the browser
 * (handles/pushed-by.ts). A record cannot carry it (serializeSegments copies
 * named fields only), and it does not need to: the send rule that decides
 * whether a stored segment is re-sent is the same decision a live walk makes
 * when it re-runs a handler, so the marker is derived at the serve.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

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
} from "../../../server/request-context.js";
import { CacheScope } from "../../../cache/cache-scope.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import type { EntryData } from "../../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import { buildMatchResult } from "../../match-result.js";
import type { ResolvedSegment } from "../../../types.js";
import { seg, gen } from "./helpers.js";

const HELD = "R0";
const NEW = "R1";

/** A record holding two segments: one the client holds, one it does not. */
async function record() {
  return {
    segments: await serializeSegments([seg(HELD), seg(NEW)]),
    handles: "",
    expiresAt: Date.now() + 60_000,
  };
}

/**
 * Serve a partial request that hits the record. The client holds `HELD` only,
 * so the send rule keeps it (no revalidate rules, no search or params change)
 * and sends `NEW`.
 */
async function serve(): Promise<{
  segments: ResolvedSegment[];
  result: ReturnType<typeof buildMatchResult>;
}> {
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
  }) as any;
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
    clientSegmentSet: new Set<string>([HELD]),
    clientSegmentIds: [HELD],
    entries: [] as EntryData[],
    matched: { params: {}, routeKey: "p" },
    routeKey: "p",
    metricsStore: undefined,
    stale: false,
    handlerContext: {},
    routeMiddleware: [],
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
    slots: {},
    segments: [],
  } as unknown as MatchPipelineState;

  const routerContext = {
    evaluateRevalidation: vi.fn(),
    buildEntryRevalidateMap: undefined,
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
  expect(state.cacheHit).toBe(true);
  return { segments, result: buildMatchResult(segments, ctx, state) };
}

describe("withCacheLookup: the segments a stored serve sends", () => {
  it("marks the sent segment and leaves the kept one unmarked", async () => {
    const { segments } = await serve();
    const byId = new Map(segments.map((s) => [s.id, s]));

    expect(byId.get(NEW)?._handlerRan).toBe(true);
    expect(byId.get(HELD)?._handlerRan).toBeUndefined();
    // The kept segment is the client's copy: nullified, as before.
    expect(byId.get(HELD)?.component).toBeNull();
    expect(byId.get(NEW)?.component).not.toBeNull();
  });

  it("resolvedIds names the sent segment only, and the marker never reaches the wire", async () => {
    const { result } = await serve();

    expect(result.resolvedIds).toEqual([NEW]);
    expect(result.diff).toEqual([NEW]);
    expect(result.segments.every((s) => !("_handlerRan" in s))).toBe(true);
  });
});
