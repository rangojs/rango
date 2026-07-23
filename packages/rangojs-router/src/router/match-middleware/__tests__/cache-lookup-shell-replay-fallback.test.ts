import { beforeEach, describe, it, expect, vi } from "vitest";
import type { PrerenderStore } from "../../../prerender/store.js";

const requestContextAccess = vi.hoisted(() => ({ available: true }));
const prerenderStoreGetMock = vi.hoisted(() =>
  vi.fn<PrerenderStore["get"]>(async () => null),
);

vi.mock("../../../server/request-context.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../server/request-context.js")>();
  return {
    ...actual,
    _getRequestContext: () =>
      requestContextAccess.available ? actual._getRequestContext() : undefined,
  };
});

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: prerenderStoreGetMock }),
}));

// lookupRoute deserializes cached segments through segment-codec; same
// JSON-based Flight stand-in as cache-scope.test.ts, mocked at the
// virtual-module seam.
vi.mock("@vitejs/plugin-rsc/rsc", () => {
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
});

import { withCacheLookup } from "../cache-lookup.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { CacheScope } from "../../../cache/cache-scope.js";
import { SeededShellStore } from "../../../cache/shell-snapshot.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import { seg, gen } from "./helpers.js";
import type {
  CachedEntryData,
  ShellSnapshotRecord,
} from "../../../cache/types.js";
import { CACHE_READ_ERROR } from "../../../cache/types.js";

// Serve-side composition: on a PPR navigation replay (marker.onExplicitHit
// set), a route-derived cache() scope stays authoritative — its hit reports
// explicit-cache-hit — and only on its MISS may the seeded doc record supply
// the match (marker.onHit then reports the true replay HIT). Without
// onExplicitHit (capture renders) the fallback must never engage.

async function entryData(ids: string[]): Promise<CachedEntryData> {
  return {
    segments: await serializeSegments(ids.map((id) => seg(id))),
    handles: "",
    expiresAt: Date.now() + 60_000,
  };
}

function makeRouterContextStub() {
  // With these resolve fns absent, resolveFreshLoadersAndYield only assigns
  // matchedIds — no loader machinery needed for the composition contract.
  return {
    evaluateRevalidation: vi.fn(),
    buildEntryRevalidateMap: undefined,
    resolveLoadersOnlyWithRevalidation: undefined,
    resolveLoadersOnly: undefined,
  } as any;
}

interface DrainResult {
  yielded: string[];
  state: MatchPipelineState;
  onHit: ReturnType<typeof vi.fn>;
  onExplicitHit: ReturnType<typeof vi.fn>;
  onExplicitBypass: ReturnType<typeof vi.fn>;
  resolveRenderBarrier: ReturnType<typeof vi.spyOn>;
  reqCtx: RequestContext<any>;
}

async function drain(options: {
  /** Pre-populate the explicit tier (`partial:localhost/p`). */
  explicitEntry?: CachedEntryData;
  /** Seed the doc record (`doc:localhost/p`) into the replay overlay. */
  seededEntry?: CachedEntryData;
  /** Omit the marker's onExplicitHit (capture-shaped marker). */
  armReplay?: boolean;
  /** Omit the marker's store (report-only marker, no-eligible-snapshot path). */
  markerStore?: boolean;
  isIntercept?: boolean;
  isPrerender?: boolean;
  initialPostMatchReason?: "prerender-store" | "intercept";
  /** Explicit scope options (default `{ ttl: 30 }`). */
  scopeOptions?: import("../../../types.js").PartialCacheOptions;
}): Promise<DrainResult> {
  const store = new MemorySegmentCacheStore();
  if (options.explicitEntry) {
    await store.set("partial:localhost/p", options.explicitEntry, 60);
  }

  const url = new URL("http://localhost/p");
  const originalUrl = new URL(
    "http://localhost/p?_rsc_partial=true&_rsc_segments=L0",
  );
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
  reqCtx._pprReplayPostMatchReason = options.initialPostMatchReason;
  const resolveRenderBarrier = vi.spyOn(reqCtx, "_resolveRenderBarrier");

  const snapshot: ShellSnapshotRecord[] = options.seededEntry
    ? [
        {
          family: "segment",
          key: "doc:localhost/p",
          value: options.seededEntry,
        },
      ]
    : [];
  const onHit = vi.fn();
  const onExplicitHit = vi.fn();
  const onExplicitBypass = vi.fn();
  reqCtx._shellImplicitCache = {
    ttl: 300,
    swr: 60,
    ...(options.markerStore === false
      ? {}
      : {
          store: new SeededShellStore(store, snapshot, {
            segmentsOnly: true,
          }),
        }),
    keyPrefix: "doc",
    onHit,
    ...(options.armReplay === false ? {} : { onExplicitHit, onExplicitBypass }),
  };

  const ctx = {
    cacheScope: new CacheScope(options.scopeOptions ?? { ttl: 30 }),
    isAction: false,
    isIntercept: options.isIntercept ?? false,
    isFullMatch: false,
    request,
    pathname: "/p",
    url,
    prevUrl: new URL("http://localhost/from"),
    prevParams: {},
    clientSegmentSet: new Set<string>(),
    entries: [],
    matched: {
      params: {},
      routeKey: "home",
      pr: options.isPrerender ? true : undefined,
    },
    routeKey: "home",
    metricsStore: undefined,
    stale: false,
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;

  const yielded: string[] = [];
  await runWithRouterContext(makeRouterContextStub(), () =>
    runWithRequestContext(reqCtx, async () => {
      const mw = withCacheLookup(ctx, state);
      for await (const segment of mw(gen([]))) {
        yielded.push(segment.id);
      }
    }),
  );

  return {
    yielded,
    state,
    onHit,
    onExplicitHit,
    onExplicitBypass,
    resolveRenderBarrier,
    reqCtx,
  };
}

describe("withCacheLookup — PPR replay composed with a route-derived cache() scope", () => {
  beforeEach(() => {
    requestContextAccess.available = true;
    prerenderStoreGetMock.mockReset().mockResolvedValue(null);
  });

  it("explicit tier COLD: the seeded doc record supplies the match and reports the replay hit", async () => {
    const result = await drain({
      seededEntry: await entryData(["seeded-R0", "seeded-R0.page"]),
      initialPostMatchReason: "intercept",
    });

    expect(result.yielded).toEqual(["seeded-R0", "seeded-R0.page"]);
    expect(result.state.cacheHit).toBe(true);
    expect(result.onHit).toHaveBeenCalledTimes(1);
    expect(result.onExplicitHit).not.toHaveBeenCalled();
    expect(result.reqCtx._pprReplayPostMatchReason).toBeUndefined();
  });

  it("explicit tier WARM: the explicit entry serves and reports explicit-cache-hit, never a replay hit", async () => {
    const result = await drain({
      explicitEntry: await entryData(["explicit-R0"]),
      seededEntry: await entryData(["seeded-R0"]),
    });

    expect(result.yielded).toEqual(["explicit-R0"]);
    expect(result.state.cacheHit).toBe(true);
    expect(result.onExplicitHit).toHaveBeenCalledTimes(1);
    expect(result.onHit).not.toHaveBeenCalled();
  });

  it("a report-only marker (no store) never engages the fallback on an explicit miss", async () => {
    // matchPartialWithPprReplay installs a store-less marker on the
    // no-eligible-snapshot path purely for truthful status. Minting a doc
    // scope from it would resolve the APP store and read the REAL doc:
    // partition — a cross-partition serve of entries written by document
    // renders.
    const result = await drain({
      seededEntry: await entryData(["seeded-R0"]),
      markerStore: false,
    });

    expect(result.yielded).toEqual([]);
    expect(result.state.cacheHit).toBe(false);
    expect(result.onHit).not.toHaveBeenCalled();
  });

  it("no onExplicitHit (capture-shaped marker): the fallback never engages on an explicit miss", async () => {
    const result = await drain({
      seededEntry: await entryData(["seeded-R0"]),
      armReplay: false,
    });

    expect(result.yielded).toEqual([]);
    expect(result.state.cacheHit).toBe(false);
    expect(result.onHit).not.toHaveBeenCalled();
  });

  it("a throwing explicit key() renders uncached — the seeded record must not cross the key partition", async () => {
    // lookupRoute's contract on a throwing consumer key()/keyGenerator is
    // "degrade to an uncached render". The fallback must not reinterpret that
    // `error` outcome as a miss and serve the canonical doc record under a key
    // partition the explicit tier never resolved.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const result = await drain({
        seededEntry: await entryData(["seeded-R0"]),
        scopeOptions: {
          ttl: 30,
          key: () => {
            throw new Error("consumer key() failure");
          },
        },
      });

      expect(result.yielded).toEqual([]);
      expect(result.state.cacheHit).toBe(false);
      expect(result.onHit).not.toHaveBeenCalled();
      expect(result.onExplicitHit).not.toHaveBeenCalled();
      expect(result.onExplicitBypass).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a store backend read failure renders uncached — swallowed store errors are not replayable misses", async () => {
    // CFCacheStore/VercelCacheStore catch backend read errors internally and
    // signal them with CACHE_READ_ERROR instead of null. The composition must
    // classify that `error` — never substitute the seeded doc record for a
    // tier whose backend never answered (execution-model.md, replay
    // composition).
    const failingStore = {
      get: async () => CACHE_READ_ERROR,
      set: async () => {},
      delete: async () => true,
    } as unknown as import("../../../cache/types.js").SegmentCacheStore;

    const result = await drain({
      seededEntry: await entryData(["seeded-R0"]),
      scopeOptions: { ttl: 30, store: failingStore },
    });

    expect(result.yielded).toEqual([]);
    expect(result.state.cacheHit).toBe(false);
    expect(result.onHit).not.toHaveBeenCalled();
    expect(result.onExplicitHit).not.toHaveBeenCalled();
    expect(result.onExplicitBypass).not.toHaveBeenCalled();
  });

  it("a condition() refusing the read is absolute — no seeded fallback", async () => {
    // The pre-read gate may have seen condition() return true; the lookup-time
    // refusal is a `bypass` outcome, not a miss, so the seeded record must not
    // rescue it (a flapping predicate cannot re-admit the fallback).
    const result = await drain({
      seededEntry: await entryData(["seeded-R0"]),
      scopeOptions: { ttl: 30, condition: () => false },
    });

    expect(result.yielded).toEqual([]);
    expect(result.state.cacheHit).toBe(false);
    expect(result.onHit).not.toHaveBeenCalled();
    expect(result.onExplicitHit).not.toHaveBeenCalled();
    // The refusal is reported so the replay header can say cache-disabled.
    expect(result.onExplicitBypass).toHaveBeenCalledTimes(1);
  });

  it("intercept navigations keep their normal cache path — no fallback, no explicit-hit report", async () => {
    const result = await drain({
      seededEntry: await entryData(["seeded-R0"]),
      isIntercept: true,
    });

    expect(result.yielded).toEqual([]);
    expect(result.state.cacheHit).toBe(false);
    expect(result.onHit).not.toHaveBeenCalled();
    expect(result.onExplicitHit).not.toHaveBeenCalled();
    expect(result.reqCtx._pprReplayPostMatchReason).toBe("intercept");
  });

  it("keeps prerender-store precedence and resolves the barrier when request ALS disappears", async () => {
    const prerenderEntry = await entryData(["prerender-R0"]);
    prerenderStoreGetMock.mockImplementationOnce(async () => {
      requestContextAccess.available = false;
      return {
        segments: prerenderEntry.segments,
        handles: prerenderEntry.handles,
      };
    });

    const result = await drain({ isIntercept: true, isPrerender: true });

    expect(result.yielded).toEqual(["prerender-R0"]);
    expect(result.state.cacheSource).toBe("prerender");
    expect(result.reqCtx._pprReplayPostMatchReason).toBe("prerender-store");
    expect(result.resolveRenderBarrier).toHaveBeenCalledTimes(1);
  });
});
