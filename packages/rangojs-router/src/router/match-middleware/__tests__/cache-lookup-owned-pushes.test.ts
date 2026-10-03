/**
 * withCacheLookup over a record that holds copies of loader pushes: whether a
 * copy stands is the pins' answer, read when the record hits, not this
 * request's type. A document HIT tail, a navigation replay and the seeded
 * fallback after an explicit route cache() miss restore a pinned loader's
 * copies the same way (#1001, #1003); a record without pins restores none as
 * authoritative, on a document tail included.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../../prerender/store.js", () => ({
  createPrerenderStore: () => ({ get: async () => null }),
}));

// lookupRoute decodes segments and handles through segment-codec; the same
// JSON stand-in as cache-lookup-shell-replay-fallback.test.ts.
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
import {
  CacheScope,
  createShellImplicitDocScope,
} from "../../../cache/cache-scope.js";
import {
  SeededShellStore,
  type ShellLoaderSeedEntry,
} from "../../../cache/shell-snapshot.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import { encodeHandles } from "../../../cache/handle-snapshot.js";
import {
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
  type EntryData,
  type LoaderEntry,
} from "../../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import type { CachedEntryData } from "../../../cache/types.js";
import { seg, gen } from "./helpers.js";

const DOC_KEY = "doc:localhost/p";
const BAKE = "Bake#L";
const LIVE = "Live#L";
const PIN: ShellLoaderSeedEntry = {
  container: {},
  holes: true,
  runs: false,
  complete: true,
};
/** The pin of the route's one `ssr: false` loader. */
const PINS = (): Map<string, ShellLoaderSeedEntry> => new Map([[BAKE, PIN]]);

function route(loaders: Record<string, unknown>[], ppr: boolean): EntryData[] {
  return [
    {
      id: "route",
      shortCode: "R0",
      type: "route",
      layout: [],
      parallel: {},
      ...(ppr ? { ppr: true } : {}),
      loader: loaders as unknown as LoaderEntry[],
    },
  ] as unknown as EntryData[];
}

/** A ppr route with an `ssr: false` loader and a live one. */
const ENTRIES = route(
  [
    { loader: { $$id: BAKE }, revalidate: [], bake: true },
    { loader: { $$id: LIVE }, revalidate: [] },
  ],
  true,
);

/** A record a capture wrote: the handler's push and one copy per loader. */
async function record(): Promise<CachedEntryData> {
  return {
    segments: await serializeSegments([seg("R0")]),
    handles: await encodeHandles({
      R0: { crumbs: ["handler", "bake-captured", "live-captured"] },
    }),
    handleOwners: { R0: { crumbs: [null, BAKE, LIVE] } },
    expiresAt: Date.now() + 60_000,
  };
}

/** A record that holds no loader push: the handler's only, or none at all. */
async function ownerlessRecord(handles = true): Promise<CachedEntryData> {
  return {
    segments: await serializeSegments([seg("R0")]),
    handles: handles
      ? await encodeHandles({ R0: { crumbs: ["handler"] } })
      : "",
    expiresAt: Date.now() + 60_000,
  };
}

type Marker = NonNullable<RequestContext<any>["_shellImplicitCache"]>;

/**
 * Run withCacheLookup for /p. No loader resolves (the router context stub
 * has no resolve fns): the test makes the loader pushes itself afterwards.
 */
async function lookup(options: {
  /** The shell's doc record, seeded into the marker's overlay. */
  seeded?: CachedEntryData;
  /** The route's own cache() record in the real store. */
  explicit?: CachedEntryData;
  /** Which request this is. */
  kind: "document-tail" | "navigation-replay" | "plain";
  /** A route-derived cache() scope, in place of the implicit doc scope. */
  routeScope?: boolean;
  /** The seed the request serves loaders from, armed as that path arms it. */
  pins?: Map<string, ShellLoaderSeedEntry>;
  /** The matched chain, in place of the ppr route with both loaders. */
  entries?: EntryData[];
}): Promise<{ reqCtx: RequestContext<any>; state: MatchPipelineState }> {
  const store = new MemorySegmentCacheStore();
  const partial = options.kind !== "document-tail";
  const url = new URL("http://localhost/p");
  const originalUrl = new URL(
    partial ? "http://localhost/p?_rsc_partial=true" : "http://localhost/p",
  );
  if (options.explicit) {
    await store.set(
      partial ? "partial:localhost/p" : DOC_KEY,
      options.explicit,
      60,
    );
  }
  const request = new Request(originalUrl, {
    headers: partial ? { "X-RSC-Router-Client-Path": "/from" } : {},
  });
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx.originalUrl = originalUrl;
  reqCtx._cacheStore = store;

  let marker: Marker | undefined;
  if (options.kind !== "plain") {
    marker = {
      ttl: 300,
      store: new SeededShellStore(
        store,
        options.seeded
          ? [{ family: "segment", key: DOC_KEY, value: options.seeded }]
          : [],
      ),
      keyPrefix: "doc",
    };
    if (options.kind === "document-tail") {
      // serveShellHit: the seed is armed before the tail's match.
      marker.docTail = true;
      marker.fixedDocKey = DOC_KEY;
      if (options.pins) reqCtx._shellLoaderSeed = options.pins;
    } else {
      // matchPartialWithPprReplay: the seed is armed by the record's hit.
      marker.onHit = () => {
        if (options.pins) reqCtx._shellLoaderSeed = options.pins;
      };
      marker.onExplicitHit = () => {};
      marker.onExplicitBypass = () => {};
    }
    reqCtx._shellImplicitCache = marker;
  }

  const ctx = {
    cacheScope:
      options.routeScope || !marker
        ? new CacheScope({ ttl: 30 })
        : createShellImplicitDocScope(marker),
    isAction: false,
    isIntercept: false,
    isFullMatch: !partial,
    request,
    pathname: "/p",
    url,
    prevUrl: new URL("http://localhost/from"),
    prevParams: {},
    clientSegmentSet: new Set<string>(),
    entries: options.entries ?? ENTRIES,
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
    evaluateRevalidation: vi.fn(),
    buildEntryRevalidateMap: undefined,
    resolveLoadersOnlyWithRevalidation: undefined,
    resolveLoadersOnly: undefined,
  } as any;
  await runWithRouterContext(routerContext, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const _ of withCacheLookup(ctx, state)(gen([]))) {
        // Drain.
      }
    }),
  );
  return { reqCtx, state };
}

/** The loaders' runs on this request: each pushes a settled value. */
function runLoaders(reqCtx: RequestContext<any>): unknown[] {
  const store = reqCtx._handleStore;
  for (const [id, value] of [
    [BAKE, "bake-run"],
    [LIVE, "live-run"],
  ] as const) {
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => store.push("crumbs", "R0", value), id),
    );
    store.settleLoaderRun(id);
  }
  return store.getDataForSegment("R0").crumbs;
}

// The pinned loader's copy stands; the live loader is a hole.
const PINNED = ["handler", "bake-captured", "live-run"];
// Nothing is pinned: both loaders' runs decide.
const UNPINNED = ["handler", "bake-run", "live-run"];

describe("withCacheLookup: a record's loader pushes follow the pins, on every path", () => {
  it("document HIT tail with pins: the pinned loader's copy stands", async () => {
    const { reqCtx, state } = await lookup({
      kind: "document-tail",
      seeded: await record(),
      pins: PINS(),
    });

    expect(state.cacheHit).toBe(true);
    expect(runLoaders(reqCtx)).toEqual(PINNED);
  });

  // #1003: the navigation read the pin for the data and the request's type
  // for the pushes.
  it("navigation replay with pins: the same, once the record's hit armed the seed", async () => {
    const { reqCtx, state } = await lookup({
      kind: "navigation-replay",
      seeded: await record(),
      pins: PINS(),
    });

    expect(state.cacheHit).toBe(true);
    expect(reqCtx._shellLoaderSeed).toBeDefined();
    expect(runLoaders(reqCtx)).toEqual(PINNED);
  });

  it("navigation whose explicit route cache() missed: the seeded record restores the same way", async () => {
    const { reqCtx, state } = await lookup({
      kind: "navigation-replay",
      routeScope: true,
      seeded: await record(),
      pins: PINS(),
    });

    expect(state.cacheHit).toBe(true);
    expect(runLoaders(reqCtx)).toEqual(PINNED);
  });

  it("document HIT tail of an entry without pins: every copy is a placeholder", async () => {
    const { reqCtx, state } = await lookup({
      kind: "document-tail",
      seeded: await record(),
    });

    expect(state.cacheHit).toBe(true);
    expect(runLoaders(reqCtx)).toEqual(UNPINNED);
  });

  it("navigation replay of an entry without pins: every copy is a placeholder", async () => {
    const { reqCtx, state } = await lookup({
      kind: "navigation-replay",
      seeded: await record(),
    });

    expect(state.cacheHit).toBe(true);
    expect(runLoaders(reqCtx)).toEqual(UNPINNED);
  });

  it("navigation whose explicit route cache() hit: its record has no pins, whatever the shell holds", async () => {
    const { reqCtx, state } = await lookup({
      kind: "navigation-replay",
      routeScope: true,
      explicit: await record(),
      seeded: await record(),
      pins: PINS(),
    });

    expect(state.cacheHit).toBe(true);
    // The explicit tier served: the seeded record's hit never armed the seed.
    expect(reqCtx._shellLoaderSeed).toBeUndefined();
    expect(runLoaders(reqCtx)).toEqual(UNPINNED);
  });

  it("a route cache() record on a request without a shell marker: every copy is a placeholder", async () => {
    const { reqCtx, state } = await lookup({
      kind: "plain",
      explicit: await record(),
    });

    expect(state.cacheHit).toBe(true);
    expect(runLoaders(reqCtx)).toEqual(UNPINNED);
  });

  it("a placeholder is not claimed: the loader's own cache() HIT delivers in its place", async () => {
    const { reqCtx } = await lookup({
      kind: "plain",
      explicit: await record(),
    });
    const store = reqCtx._handleStore;

    store.replacePlaceholders([BAKE], () => {
      store.pushReplayed("crumbs", "R0", "bake-entry", BAKE);
    });

    expect(store.getDataForSegment("R0").crumbs).toEqual([
      "handler",
      "bake-entry",
      "live-captured",
    ]);
  });
});

/** A push by `id`'s run on this request, then the run's end. */
function runLoader(
  reqCtx: RequestContext<any>,
  id: string,
  value?: unknown,
): unknown[] {
  const store = reqCtx._handleStore;
  if (value !== undefined) {
    runInsideLoaderScope(() =>
      runInsideLoaderBodyScope(() => store.push("crumbs", "R0", value), id),
    );
  }
  store.settleLoaderRun(id);
  return store.getDataForSegment("R0").crumbs ?? [];
}

describe("withCacheLookup: what a record that holds no loader push still decides", () => {
  // The pin says the record lists every settled push of the capture's run,
  // and it lists none: the replay's run adds none next to the pinned data.
  it.each([
    ["with the handler's push", true, ["handler"]],
    ["with no handles blob", false, []],
  ] as const)(
    "a pinned loader whose capture pushed nothing, record %s: its run's settled push is dropped",
    async (_, handles, expected) => {
      for (const kind of ["document-tail", "navigation-replay"] as const) {
        const { reqCtx } = await lookup({
          kind,
          seeded: await ownerlessRecord(handles),
          pins: PINS(),
        });

        expect(runLoader(reqCtx, BAKE, "bake-late"), kind).toEqual(expected);
      }
    },
  );

  it("the same loader without its pin: the run's push is the page's", async () => {
    const { reqCtx } = await lookup({
      kind: "document-tail",
      seeded: await ownerlessRecord(),
    });

    expect(runLoader(reqCtx, BAKE, "bake-run")).toEqual([
      "handler",
      "bake-run",
    ]);
  });

  // A hole's run decides every copy of its pushes, another cached unit's
  // replay included, whether or not the record holds a copy.
  it("a ppr route without an ssr: false loader: its loaders are holes", async () => {
    const liveOnly = route([{ loader: { $$id: LIVE }, revalidate: [] }], true);
    for (const handles of [true, false]) {
      const { reqCtx } = await lookup({
        kind: "navigation-replay",
        seeded: await ownerlessRecord(handles),
        entries: liveOnly,
      });
      reqCtx._handleStore.pushReplayed("crumbs", "R0", "live-cached", LIVE);

      expect(runLoader(reqCtx, LIVE)).toEqual(handles ? ["handler"] : []);
    }
  });

  // Its records hold no loader push and it has no pin: no loader is a hole,
  // and a replay stays when the loader's run makes no push.
  it("a route without ppr restores its record as a plain replay", async () => {
    const { reqCtx, state } = await lookup({
      kind: "plain",
      explicit: await ownerlessRecord(),
      entries: route([{ loader: { $$id: LIVE }, revalidate: [] }], false),
    });
    reqCtx._handleStore.pushReplayed("crumbs", "R0", "live-cached", LIVE);

    expect(state.cacheHit).toBe(true);
    expect(runLoader(reqCtx, LIVE)).toEqual(["handler", "live-cached"]);
  });

  // A record a capture wrote, read after a deploy took `ppr` off the route.
  it("a route without ppr reading a record with owners: every copy is a placeholder", async () => {
    const { reqCtx } = await lookup({
      kind: "plain",
      explicit: await record(),
      entries: route(
        [
          { loader: { $$id: BAKE }, revalidate: [], bake: true },
          { loader: { $$id: LIVE }, revalidate: [] },
        ],
        false,
      ),
    });

    expect(runLoaders(reqCtx)).toEqual(UNPINNED);
  });
});
