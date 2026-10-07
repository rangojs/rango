/**
 * withCacheLookup and the on-demand overlay's "removed" marker (#1060): a
 * request that finds the marker is not served from any prerender store. The
 * build-time entry below the overlay must not come back, so the pipeline goes
 * on to the route's handler: a Passthrough route's live handler, or a plain
 * route's gated producer (gateOnDemandProducer, urls/path-helper.ts), which
 * `_prerenderRemoved` on the handler context closes in dev too.
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

import {
  resetOverlayRevalidationsForTests,
  setPrerenderStoreForTests,
  withCacheLookup,
} from "../cache-lookup.js";
import { runWithRouterContext } from "../../router-context.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";
import { serializeSegments } from "../../../cache/segment-codec.js";
import { createMemoryPrerenderStore } from "../../../prerender/memory-prerender-store.js";
import { hashParams } from "../../../prerender/param-hash.js";
import {
  composeStoredEntry,
  type PrerenderKey,
  type PrerenderStoredEntry,
  type WritablePrerenderStore,
} from "../../../prerender/writable-store.js";
import type { PrerenderConfig } from "../../../prerender/on-demand.js";
import type { EntryData } from "../../../server/context.js";
import type { MatchContext, MatchPipelineState } from "../../match-context.js";
import { seg, gen } from "./helpers.js";

const PARAMS = { id: "42" };
const KEY: PrerenderKey = {
  routerId: "r1",
  version: "b1",
  routeName: "product",
  paramHash: hashParams(PARAMS),
};

function routeEntries(passthrough: boolean): EntryData[] {
  return [
    {
      id: "route",
      shortCode: "R0",
      type: "route",
      layout: [],
      parallel: {},
      loader: [],
      isPrerender: true,
      isOnDemand: true,
      ...(passthrough ? { isPassthrough: true } : {}),
    },
  ] as unknown as EntryData[];
}

afterEach(() => {
  setPrerenderStoreForTests(undefined);
  resetOverlayRevalidationsForTests();
});

/**
 * Run withCacheLookup for the product route. The bundled manifest holds a
 * build-time entry (segment "BUILD"); `overlay` is what the prerender store
 * holds for the key; the pipeline below the lookup yields segment "HANDLER".
 */
async function lookup(options: {
  overlay?: (
    now: number,
  ) => PrerenderStoredEntry | Promise<PrerenderStoredEntry>;
  /** Answers every read in place of the memory store. */
  read?: () => Promise<unknown>;
  passthrough?: boolean;
  action?: boolean;
  /** A client navigation (`_rsc_partial`), not a document request. */
  partial?: boolean;
  intercept?: boolean;
  onRevalidate?: PrerenderConfig["onRevalidate"];
}): Promise<{
  served: string[];
  state: MatchPipelineState;
  handlerContext: Record<string, unknown>;
  buildReads: number;
}> {
  let buildReads = 0;
  setPrerenderStoreForTests({
    get: async () => {
      buildReads += 1;
      return {
        segments: await serializeSegments([seg("BUILD")]),
        handles: "",
      };
    },
  });
  const store: WritablePrerenderStore = createMemoryPrerenderStore();
  if (options.overlay) await store.set(KEY, await options.overlay(Date.now()));
  if (options.read) store.get = options.read as WritablePrerenderStore["get"];

  const url = new URL("http://localhost/product/42");
  const request = new Request(url, {
    method: options.action ? "POST" : "GET",
  });
  const reqCtx = createRequestContext<any>({
    env: {},
    request,
    url,
    variables: {},
  }) as RequestContext<any>;
  reqCtx._prerender = {
    config: {
      store,
      ...(options.onRevalidate ? { onRevalidate: options.onRevalidate } : {}),
    },
    routerId: KEY.routerId,
    version: KEY.version,
  };
  const handlerContext: Record<string, unknown> = {};
  const ctx = {
    cacheScope: undefined,
    isAction: options.action === true,
    isIntercept: options.intercept === true,
    isFullMatch: !options.action && !options.partial,
    request,
    pathname: url.pathname,
    url,
    prevUrl: url,
    prevParams: PARAMS,
    clientSegmentSet: new Set<string>(),
    entries: routeEntries(options.passthrough === true),
    matched: { params: PARAMS, routeKey: "product", pr: true, od: true },
    routeKey: "product",
    metricsStore: undefined,
    stale: false,
    handlerContext,
  } as unknown as MatchContext<any>;
  const state = {
    cacheHit: false,
    interceptSegments: [],
  } as unknown as MatchPipelineState;
  const served: string[] = [];
  await runWithRouterContext({ evaluateRevalidation: vi.fn() } as any, () =>
    runWithRequestContext(reqCtx, async () => {
      for await (const segment of withCacheLookup(
        ctx,
        state,
      )(gen([seg("HANDLER")]))) {
        served.push(segment.id);
      }
    }),
  );
  return { served, state, handlerContext, buildReads };
}

const page = async (now: number, ttl?: number): Promise<PrerenderStoredEntry> =>
  composeStoredEntry(
    KEY,
    { segments: await serializeSegments([seg("OVERLAY")]), handles: "" },
    { ...(ttl != null ? { ttl } : {}), tags: [], params: PARAMS },
    now,
  );
/** The marker as a durable store hands it back: the JSON, not the helper. */
const tombstone = (now: number): PrerenderStoredEntry => ({
  v: 1,
  removed: true,
  meta: { storedAt: now, tags: [], version: KEY.version, params: PARAMS },
});

describe("withCacheLookup: an on-demand route without a removed marker", () => {
  it("no overlay entry: the build-time entry serves", async () => {
    const { served, state, handlerContext } = await lookup({});

    expect(served).toEqual(["BUILD"]);
    expect(state.cacheSource).toBe("prerender");
    expect(handlerContext).not.toHaveProperty("_prerenderRemoved");
  });

  it("a refreshed page: the overlay serves ahead of the build-time entry", async () => {
    const { served, state, buildReads } = await lookup({ overlay: page });

    expect(served).toEqual(["OVERLAY"]);
    expect(state.cacheSource).toBe("prerender");
    expect(buildReads).toBe(0);
  });
});

describe("withCacheLookup: a removed marker hides the build-time entry", () => {
  it("a plain route's document request is not served from a store: its gated producer answers", async () => {
    const { served, state, handlerContext, buildReads } = await lookup({
      overlay: tombstone,
    });

    expect(served).toEqual(["HANDLER"]);
    expect(state.cacheHit).toBe(false);
    expect(state.cacheSource).toBeUndefined();
    // The bundled manifest is not even read.
    expect(buildReads).toBe(0);
    // What closes gateOnDemandProducer in dev.
    expect(handlerContext._prerenderRemoved).toBe(true);
  });

  it("a Passthrough route's request goes to its live handler", async () => {
    const { served, state, buildReads } = await lookup({
      overlay: tombstone,
      passthrough: true,
    });

    expect(served).toEqual(["HANDLER"]);
    expect(state.cacheHit).toBe(false);
    expect(buildReads).toBe(0);
  });

  it("a plain route's server-action re-render is not served the build-time entry either", async () => {
    const control = await lookup({ action: true });
    expect(control.served).toEqual(["BUILD"]);

    const { served, state, handlerContext, buildReads } = await lookup({
      overlay: tombstone,
      action: true,
    });

    expect(served).toEqual(["HANDLER"]);
    expect(state.cacheHit).toBe(false);
    expect(buildReads).toBe(0);
    expect(handlerContext._prerenderRemoved).toBe(true);
  });

  it("a client navigation to a removed page is not served from a store either", async () => {
    const control = await lookup({ partial: true });
    expect(control.served).toEqual(["BUILD"]);

    const { served, state, handlerContext, buildReads } = await lookup({
      overlay: tombstone,
      partial: true,
    });

    expect(served).toEqual(["HANDLER"]);
    expect(state.cacheHit).toBe(false);
    expect(buildReads).toBe(0);
    expect(handlerContext._prerenderRemoved).toBe(true);
  });

  it("only `removed: true` is a marker: any other value with an entry is a page", async () => {
    // isStoredEntryValidFor accepts this envelope as a page; the read path
    // must agree with it instead of testing `removed` for truthiness.
    const { served, state } = await lookup({
      overlay: async (now) =>
        ({
          ...(await page(now)),
          removed: 1,
        }) as unknown as PrerenderStoredEntry,
    });

    expect(served).toEqual(["OVERLAY"]);
    expect(state.cacheSource).toBe("prerender");
  });
});

describe("withCacheLookup: a removed marker and onRevalidate", () => {
  /** A marker a refresh that hit notFound() wrote, with the route's ttl. */
  const notFoundMarker = (now: number, ttlSeconds: number) => {
    const marker = tombstone(now);
    marker.meta.staleAt = now + ttlSeconds * 1000;
    return marker;
  };

  it("a stale notFound() marker schedules onRevalidate like a stale page, and the request is still not served from a store", async () => {
    const onRevalidate = vi.fn();
    const { served, state, handlerContext, buildReads } = await lookup({
      overlay: (now) => notFoundMarker(now - 5000, 1),
      onRevalidate,
    });

    await vi.waitFor(() => expect(onRevalidate).toHaveBeenCalledTimes(1));
    expect(onRevalidate.mock.calls[0]![0]).toEqual({
      route: "product",
      params: PARAMS,
    });
    // The 404 (or the live handler) keeps answering while it is rechecked.
    expect(served).toEqual(["HANDLER"]);
    expect(state.cacheHit).toBe(false);
    expect(buildReads).toBe(0);
    expect(handlerContext._prerenderRemoved).toBe(true);
  });

  it("a fresh notFound() marker schedules nothing", async () => {
    const onRevalidate = vi.fn();
    const { served } = await lookup({
      overlay: (now) => notFoundMarker(now, 3600),
      onRevalidate,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onRevalidate).not.toHaveBeenCalled();
    expect(served).toEqual(["HANDLER"]);
  });

  it("a remove() marker has no staleAt: nothing is ever scheduled for it", async () => {
    const onRevalidate = vi.fn();
    // The scheduling itself works: a stale page schedules.
    await lookup({ overlay: (now) => page(now - 5000, 1), onRevalidate });
    await vi.waitFor(() => expect(onRevalidate).toHaveBeenCalledTimes(1));
    onRevalidate.mockClear();
    resetOverlayRevalidationsForTests();

    const { served } = await lookup({
      // Written a year ago by prerender.remove().
      overlay: (now) => tombstone(now - 365 * 24 * 3600 * 1000),
      onRevalidate,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onRevalidate).not.toHaveBeenCalled();
    expect(served).toEqual(["HANDLER"]);
  });
});

describe("withCacheLookup: when the marker cannot be read or is not this page's", () => {
  it("a marker stored for other params under the same key is a miss: it removes nothing", async () => {
    // The 8-hex DJB2 collision guard (param-hash.ts), for a removal.
    const { served, handlerContext } = await lookup({
      overlay: (now) => ({
        ...tombstone(now),
        meta: { ...tombstone(now).meta, params: { id: "99" } },
      }),
    });

    expect(served).toEqual(["BUILD"]);
    expect(handlerContext).not.toHaveProperty("_prerenderRemoved");
  });

  it("a marker written under another key version is a miss", async () => {
    // A store that answers this key with another version's marker.
    const { served, handlerContext } = await lookup({
      read: async () => ({
        ...tombstone(Date.now()),
        meta: { ...tombstone(Date.now()).meta, version: "b0" },
      }),
    });

    expect(served).toEqual(["BUILD"]);
    expect(handlerContext).not.toHaveProperty("_prerenderRemoved");
  });

  it("a store read failure is a miss: the build-time entry of a removed page serves while the store is failing", async () => {
    // readVerifiedStoredEntry degrades a store error to a miss, for a page
    // and for a marker alike. Documented in the prerender skill.
    const { served, state } = await lookup({
      overlay: tombstone,
      read: async () => {
        throw new Error("kv outage");
      },
    });

    expect(served).toEqual(["BUILD"]);
    expect(state.cacheSource).toBe("prerender");
  });
});

describe("withCacheLookup: an intercepted navigation", () => {
  it("an intercepted navigation does not read the overlay, so it does not see the marker", async () => {
    // The documented limit of v1 (docs/design/ondemand-prerender.md): only the
    // main variant is written and read. Pinned so a change is deliberate.
    const { served, buildReads } = await lookup({
      overlay: tombstone,
      intercept: true,
    });

    expect(served).toEqual(["BUILD"]);
    expect(buildReads).toBe(1);
  });
});
