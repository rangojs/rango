/**
 * A fill that resolves an intercept sends only what the client lacks of the
 * intercept. Its `matched` is the client's ids and the slot's
 * (match-result.ts), so a segment outside the slot that the client does not
 * hold is outside it, whichever source produced it: the live walk, a cache()
 * record or a prerender entry. The match pipeline drops such a segment once,
 * as its last step, and a stored source replays no handle value of one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// segment-codec through a JSON stand-in, as cache-prefetch-false.test.ts.
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

import { setPrerenderStoreForTests } from "../cache-lookup.js";
import { createMatchPartialPipeline } from "../../match-pipelines.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { CacheScope } from "../../../cache/cache-scope.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import type { CacheGetResult } from "../../../cache/types.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import { encodeHandles } from "../../../cache/handle-snapshot.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { EntryData, InterceptEntry } from "../../../server/context.js";
import type { ResolvedSegment } from "../../../types.js";
import { planPrefetchDeferral } from "../../segment-resolution/prefetch-deferral.js";
import { seg } from "./helpers.js";

// The source page /list holds the root layout. The intercept's target chain
// renders a layout of its own below it, which the page under the modal does
// not hold, and the slot is the intercept's.
const ROOT = "L0";
const TARGET_LAYOUT = "L0L1";
const TARGET_LOADER = "L0L1D0.targetData";
const SLOT = "L0.@modal";
const NAMESPACE = "intercept:item";

const intercept = {
  slotName: "@modal",
  routeName: "item",
} as unknown as InterceptEntry;
const rootEntry = {
  type: "layout",
  id: ROOT,
  shortCode: ROOT,
  loader: [],
  layout: [],
  parallel: {},
  intercept: [intercept],
} as unknown as EntryData;

const root = () =>
  seg(ROOT, { type: "layout", belongsToRoute: false, component: null });
const targetLayout = () =>
  seg(TARGET_LAYOUT, { type: "layout", belongsToRoute: false });
const targetLoader = () =>
  seg(TARGET_LOADER, { type: "loader", belongsToRoute: false });
const slot = () =>
  seg(SLOT, { type: "parallel", namespace: NAMESPACE, slot: "@modal" });

type Kind = "fill" | "navigation";

interface Run {
  sent: string[];
  matched: string[];
  state: MatchPipelineState;
  reqCtx: RequestContext<any>;
}

/** createMatchPartialPipeline for /item/1 intercepted over /list. */
async function run(
  kind: Kind,
  options: {
    /** What the live walk (resolveAllSegments) yields on a MISS. */
    live?: () => ResolvedSegment[];
    /** A cache() record the lookup answers with. */
    record?: ResolvedSegment[];
    /** The record's, or the prerender entry's, handle values by segment. */
    handles?: Record<string, Record<string, unknown[]>>;
    /** A prerender intercept variant the store answers with. */
    prerender?: ResolvedSegment[];
  },
): Promise<Run> {
  const url = new URL("http://localhost/item/1");
  const request = new Request(
    `http://localhost/item/1?_rsc_partial=true&_rsc_segments=${ROOT}`,
    { headers: { "X-RSC-Router-Intercept-Source": "/list" } },
  );
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;

  const handles = options.handles ? await encodeHandles(options.handles) : "";
  let cacheScope: CacheScope | null = null;
  if (options.record) {
    // Answers whatever key the intercept's record resolves to.
    const data = {
      segments: await serializeSegments(options.record),
      handles,
      expiresAt: Date.now() + 60_000,
    };
    const store = new (class extends MemorySegmentCacheStore {
      override async get(): Promise<CacheGetResult | null> {
        return { data, shouldRevalidate: false };
      }
    })();
    reqCtx._cacheStore = store;
    cacheScope = new CacheScope({ ttl: 30 });
  }
  if (options.prerender) {
    const segments = await serializeSegments(options.prerender);
    setPrerenderStoreForTests({
      get: async () => ({ segments, handles }),
    } as any);
  }

  const plan =
    kind === "fill"
      ? planPrefetchDeferral([rootEntry], "fill", {}, null, new Set([ROOT]))
      : undefined;
  const handlerContext = { _prefetchDeferral: plan };
  const ctx = {
    cacheScope,
    isAction: false,
    isIntercept: true,
    isFullMatch: false,
    interceptResult: { intercept, entry: rootEntry },
    request,
    pathname: "/item/1",
    url,
    prevUrl: new URL("http://localhost/list"),
    prevParams: {},
    interceptPrev: { url: new URL("http://localhost/list"), params: {} },
    clientSegmentIds: [ROOT],
    clientSegmentSet: new Set([ROOT]),
    entries: [rootEntry],
    matched: {
      params: { id: "1" },
      routeKey: "item",
      ...(options.prerender ? { pr: true } : {}),
    },
    routeKey: "item",
    localRouteName: "item",
    metricsStore: undefined,
    stale: false,
    handlerContext,
    routeMiddleware: [],
    manifestEntry: undefined,
    Store: { run: <T>(fn: () => T) => fn() },
  } as unknown as MatchContext<any>;
  const state: MatchPipelineState = {
    cacheHit: false,
    segments: [],
    matchedIds: [],
    interceptSegments: [],
    interceptMatchedIds: [],
    slots: {},
  } as unknown as MatchPipelineState;

  const routerContext = {
    evaluateRevalidation: vi.fn(async () => true),
    buildEntryRevalidateMap: () => new Map(),
    resolveAllSegments: vi.fn(async () => {
      const segments = options.live?.() ?? [];
      return { segments, matchedIds: segments.map((s) => s.id) };
    }),
    resolveLoadersOnly: vi.fn(async () => ({ segments: [], matchedIds: [] })),
    resolveInterceptEntry: vi.fn(async () => ({
      segments: [slot()],
      matchedIds: [SLOT],
    })),
    resolveInterceptLoadersOnly: vi.fn(async () => ({
      segments: [],
      matchedIds: [SLOT],
    })),
  } as any;

  const sent: string[] = [];
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of createMatchPartialPipeline(ctx, state)) {
        sent.push(segment.id);
      }
    }),
  );
  return {
    sent,
    matched: [...state.matchedIds, ...state.interceptMatchedIds],
    state,
    reqCtx,
  };
}

/** The handle values the response carries for `id`. */
function replayed(reqCtx: RequestContext<any>, id: string): unknown {
  return reqCtx._handleStore.getDataForSegment(id).crumbs;
}

afterEach(() => {
  setPrerenderStoreForTests(undefined);
});

describe("an intercept's fill sends only what the client lacks of the intercept", () => {
  // Stands for any source that yields a segment outside the slot the client
  // lacks: the pipeline drops it after the source, whatever the source is.
  it("drops a segment outside the slot that the client lacks, from the live walk", async () => {
    const { sent } = await run("fill", {
      live: () => [root(), targetLayout(), targetLoader()],
    });
    expect(sent).toEqual([ROOT, SLOT]);
  });

  it("control: an intercept navigation sends it", async () => {
    const { sent } = await run("navigation", {
      live: () => [root(), targetLayout(), targetLoader()],
    });
    expect(sent).toEqual([ROOT, TARGET_LAYOUT, TARGET_LOADER, SLOT]);
  });

  it("drops it from a cache() record, and replays none of its handle values", async () => {
    const { sent, state, reqCtx } = await run("fill", {
      record: [root(), targetLayout(), slot()],
      handles: {
        [TARGET_LAYOUT]: { crumbs: ["target"] },
        [SLOT]: { crumbs: ["modal"] },
      },
    });
    expect(state.cacheHit).toBe(true);
    expect(sent).toEqual([ROOT, SLOT]);
    expect(replayed(reqCtx, TARGET_LAYOUT)).toBeUndefined();
    expect(replayed(reqCtx, SLOT)).toEqual(["modal"]);
  });

  it("drops it from a prerender entry, and replays none of its handle values", async () => {
    const { sent, state, reqCtx } = await run("fill", {
      prerender: [root(), targetLayout(), slot()],
      handles: {
        [TARGET_LAYOUT]: { crumbs: ["target"] },
        [SLOT]: { crumbs: ["modal"] },
      },
    });
    expect(state.cacheSource).toBe("prerender");
    expect(sent).toEqual([ROOT, SLOT]);
    expect(replayed(reqCtx, TARGET_LAYOUT)).toBeUndefined();
    expect(replayed(reqCtx, SLOT)).toEqual(["modal"]);
  });

  it("control: an intercept navigation served from a prerender entry sends it with its handle values", async () => {
    const { sent, reqCtx } = await run("navigation", {
      prerender: [root(), targetLayout(), slot()],
      handles: {
        [TARGET_LAYOUT]: { crumbs: ["target"] },
        [SLOT]: { crumbs: ["modal"] },
      },
    });
    expect(sent).toEqual([ROOT, TARGET_LAYOUT, SLOT]);
    expect(replayed(reqCtx, TARGET_LAYOUT)).toEqual(["target"]);
  });
});
