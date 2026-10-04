/**
 * withCacheLookup on a Prerender + ppr shell HIT tail (issue #1057): the
 * prerender store serves the handler layer and its build-time handles, and
 * the entry's `handles` record adds the loader-owned pushes the prelude
 * rendered, restored as a doc record's are: a pinned loader's copy stands, a
 * hole's is a placeholder, and the pins decide (loaderPins). An entry without
 * the record (v0.21) restores the prerender store's handles only, as before.
 */
import { afterEach, describe, it, expect, vi } from "vitest";

// segment-codec through a JSON stand-in, as cache-lookup-owned-pushes.test.ts.
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
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { CacheScope } from "../../../cache/cache-scope.js";
import type { ShellLoaderSeedEntry } from "../../../cache/shell-snapshot.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import { encodeHandles } from "../../../cache/handle-snapshot.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
  type EntryData,
  type LoaderEntry,
} from "../../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { ShellSnapshotHandlesValue } from "../../../cache/types.js";
import { seg, gen } from "./helpers.js";

const BAKE = "Bake#L";
const LIVE = "Live#L";
const PINS = (): Map<string, ShellLoaderSeedEntry> =>
  new Map([
    [BAKE, { container: {}, holes: false, runs: true, complete: true }],
  ]);

/** A Prerender + ppr route with an `ssr: false` loader and a live one. */
const ENTRIES = [
  {
    id: "route",
    shortCode: "R0",
    type: "route",
    layout: [],
    parallel: {},
    ppr: true,
    isPrerender: true,
    loader: [
      { loader: { $$id: BAKE }, revalidate: [], bake: true },
      { loader: { $$id: LIVE }, revalidate: [] },
    ] as unknown as LoaderEntry[],
  },
] as unknown as EntryData[];

/** The capture's record: the handler's push and one copy per loader. */
async function shellHandles(): Promise<ShellSnapshotHandlesValue> {
  return {
    handles: await encodeHandles({
      R0: { crumbs: ["handler", "bake-captured", "live-captured"] },
    }),
    handleOwners: { R0: { crumbs: [null, BAKE, LIVE] } },
  };
}

afterEach(() => {
  setPrerenderStoreForTests(undefined);
});

/**
 * Run withCacheLookup for /p with the prerender store serving the build-time
 * entry (the handler's push only). No loader resolves: the test makes the
 * loader pushes itself afterwards.
 */
async function lookup(options: {
  /** A shell HIT tail, with the entry's `handles` record when given. */
  tail?: { handles?: ShellSnapshotHandlesValue };
  pins?: Map<string, ShellLoaderSeedEntry>;
}): Promise<{ reqCtx: RequestContext<any>; state: MatchPipelineState }> {
  setPrerenderStoreForTests({
    get: async () => ({
      segments: await serializeSegments([seg("R0")]),
      handles: await encodeHandles({ R0: { crumbs: ["handler"] } }),
    }),
  });
  const url = new URL("http://localhost/p");
  const request = new Request(url);
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  if (options.tail) {
    // serveShellHit: the marker and the seed are armed before the match.
    reqCtx._shellImplicitCache = {
      ttl: 300,
      keyPrefix: "doc",
      docTail: true,
      prerenderHandles: options.tail.handles,
    };
    if (options.pins) reqCtx._shellLoaderSeed = options.pins;
  }
  const ctx = {
    cacheScope: new CacheScope({ ttl: 30 }),
    isAction: false,
    isIntercept: false,
    isFullMatch: true,
    request,
    pathname: "/p",
    url,
    prevUrl: url,
    prevParams: {},
    clientSegmentSet: new Set<string>(),
    entries: ENTRIES,
    matched: { params: {}, routeKey: "p", pr: true },
    routeKey: "p",
    metricsStore: undefined,
    stale: false,
    handlerContext: {},
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;
  await runWithRouterContext({ evaluateRevalidation: vi.fn() } as any, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const _ of withCacheLookup(ctx, state)(gen([]))) {
        // Drain.
      }
    }),
  );
  return { reqCtx, state };
}

/** The handle values after the restore, then after both loaders' runs. */
function restoredThenRun(reqCtx: RequestContext<any>): {
  restored: unknown[];
  afterRuns: unknown[];
} {
  const store = reqCtx._handleStore;
  const restored = [...store.getDataForSegment("R0").crumbs];
  for (const [id, value] of [
    [BAKE, "bake-run"],
    [LIVE, "live-run"],
  ] as const) {
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => store.push("crumbs", "R0", value), id),
    );
    store.settleLoaderRun(id);
  }
  return { restored, afterRuns: store.getDataForSegment("R0").crumbs };
}

describe("withCacheLookup: a Prerender + ppr shell HIT restores the entry's loader pushes", () => {
  it("with pins: the copies are restored before the loaders run, and the pinned loader's stands", async () => {
    const { reqCtx, state } = await lookup({
      tail: { handles: await shellHandles() },
      pins: PINS(),
    });

    expect(state.cacheSource).toBe("prerender");
    expect(restoredThenRun(reqCtx)).toEqual({
      restored: ["handler", "bake-captured", "live-captured"],
      afterRuns: ["handler", "bake-captured", "live-run"],
    });
  });

  it("without pins (maxSnapshotBytes): every copy is a placeholder the runs replace", async () => {
    const { reqCtx } = await lookup({
      tail: { handles: await shellHandles() },
    });

    expect(restoredThenRun(reqCtx)).toEqual({
      restored: ["handler", "bake-captured", "live-captured"],
      afterRuns: ["handler", "bake-run", "live-run"],
    });
  });

  it("a record without owned pushes still applies the pins: a pinned loader's push on the HIT is dropped", async () => {
    const { reqCtx } = await lookup({
      tail: { handles: { handles: "" } },
      pins: PINS(),
    });

    expect(restoredThenRun(reqCtx)).toEqual({
      restored: ["handler"],
      afterRuns: ["handler", "live-run"],
    });
  });

  it("an entry written without the record (v0.21): the prerender store's handles only, the runs' pushes kept", async () => {
    const { reqCtx } = await lookup({ tail: {}, pins: PINS() });

    expect(restoredThenRun(reqCtx)).toEqual({
      restored: ["handler"],
      afterRuns: ["handler", "bake-run", "live-run"],
    });
  });

  it("a request that is not a shell HIT tail restores the prerender store's handles only", async () => {
    const { reqCtx, state } = await lookup({});

    expect(state.cacheSource).toBe("prerender");
    expect(restoredThenRun(reqCtx)).toEqual({
      restored: ["handler"],
      afterRuns: ["handler", "bake-run", "live-run"],
    });
  });
});
