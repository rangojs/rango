/**
 * serveStoredSegments marks every stored segment it sends as the response's
 * run (`_handlerRan`, the marker a live pass sets on a segment it re-renders),
 * so buildMatchResult lists it in `resolvedIds` and the browser replaces the
 * handle values it holds for it (match-result.ts, handles/pushed-by.ts).
 *
 * The record does not carry the marker (segment-codec.ts serializeSegments
 * copies named fields), and whether a HIT sends a segment depends on what the
 * client holds and on this request's revalidate() answers: it is derived on
 * serve. A kept segment stays unmarked, as on a live walk.
 */
import { describe, it, expect, vi } from "vitest";

// lookupRoute decodes segments through segment-codec; the same JSON stand-in
// as cache-lookup-shell-replay-fallback.test.ts.
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
import type { CachedEntryData } from "../../../cache/types.js";
import type { ResolvedSegment } from "../../../types.js";
import { seg, gen } from "./helpers.js";

const KEY = "partial:localhost/p";

async function record(ids: string[]): Promise<CachedEntryData> {
  return {
    segments: await serializeSegments(ids.map((id) => seg(id))),
    handles: "",
    expiresAt: Date.now() + 60_000,
  };
}

/**
 * Run a partial request for /p served from a record of `ids`. `held` is what
 * the client mounts, and `revalidates` the answer each held segment's
 * revalidate() gives.
 */
async function serve(options: {
  ids: string[];
  held: string[];
  revalidates?: Record<string, boolean>;
}): Promise<ResolvedSegment[]> {
  const store = new MemorySegmentCacheStore();
  await store.set(KEY, await record(options.ids), 60);
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
    clientSegmentSet: new Set(options.held),
    entries: [],
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

  const answers = options.revalidates ?? {};
  const routerContext = {
    evaluateRevalidation: ({ segment }: { segment: ResolvedSegment }) =>
      Promise.resolve(answers[segment.id] ?? false),
    buildEntryRevalidateMap: () =>
      new Map(
        Object.keys(answers).map((id) => [id, { revalidate: [() => true] }]),
      ),
    resolveLoadersOnly: undefined,
  } as any;

  const yielded: ResolvedSegment[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of withCacheLookup(ctx, state)(gen([]))) {
        yielded.push(segment);
      }
    }),
  );
  return yielded;
}

describe("serveStoredSegments: a sent stored segment is the response's run", () => {
  it("a held segment whose revalidate() asks for it is sent and marked", async () => {
    const [segment] = await serve({
      ids: ["R0"],
      held: ["R0"],
      revalidates: { R0: true },
    });

    expect(segment.component).not.toBeNull();
    expect(segment._handlerRan).toBe(true);
  });

  it("a held segment its revalidate() keeps is neither sent nor marked", async () => {
    const [segment] = await serve({
      ids: ["R0"],
      held: ["R0"],
      revalidates: { R0: false },
    });

    expect(segment.component).toBeNull();
    expect(segment._handlerRan).toBeUndefined();
  });

  it("a segment the client lacks is sent and marked, as a live pass renders it", async () => {
    const [segment] = await serve({ ids: ["R0"], held: [] });

    expect(segment.component).not.toBeNull();
    expect(segment._handlerRan).toBe(true);
  });
});
