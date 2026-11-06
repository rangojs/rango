/**
 * withCacheLookup and a stored redirect in the on-demand overlay: a route whose
 * handler answered `redirect()` on its refresh has that redirect stored in
 * place of the page, and a request that finds it is answered with the 3xx
 * instead of a page — neither the page stored before it nor the build-time
 * entry below the overlay comes back.
 *
 * The Response is thrown out of the pipeline the way a handler's redirect is
 * (`handleHandlerResult`), so the request handler drives it: a document gets
 * the 3xx, a partial navigation the Flight soft redirect
 * (rsc/handler.ts, handleRscRendering).
 */
import { afterEach, describe, it, expect, vi } from "vitest";

// segment-codec through a JSON stand-in, as cache-lookup-prerender-removed.test.ts.
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
  composeStoredRedirect,
  type PrerenderKey,
  type PrerenderStoredEntry,
  type StoredRedirect,
  type WritablePrerenderStore,
} from "../../../prerender/writable-store.js";
import { isExternalRedirect } from "../../../redirect-origin.js";
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
const REDIRECT: StoredRedirect = { status: 302, location: "/product/43" };

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
  vi.useRealTimers();
});

/**
 * Run withCacheLookup for the product route. The bundled manifest holds a
 * build-time entry (segment "BUILD"); `overlay` is what the prerender store
 * holds for the key; the pipeline below the lookup yields segment "HANDLER".
 * A thrown value is returned instead of a served segment list, so a redirect
 * can be told from a pass-through.
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
  thrown: unknown;
  state: MatchPipelineState;
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
    interceptPrev: { url, params: PARAMS },
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
  let thrown: unknown;
  try {
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
  } catch (error) {
    thrown = error;
  }
  return { served, thrown, state, buildReads };
}

const page = async (now: number, ttl?: number): Promise<PrerenderStoredEntry> =>
  composeStoredEntry(
    KEY,
    { segments: await serializeSegments([seg("OVERLAY")]), handles: "" },
    { ...(ttl != null ? { ttl } : {}), tags: [], params: PARAMS },
    now,
  );
/** The redirect as a durable store hands it back: the JSON, not the helper. */
const redirectEntry = (
  now: number,
  redirect: StoredRedirect = REDIRECT,
  ttl?: number,
): PrerenderStoredEntry => ({
  ...composeStoredRedirect(
    KEY,
    redirect,
    { ...(ttl != null ? { ttl } : {}), tags: [], params: PARAMS },
    now,
  ),
});

describe("withCacheLookup: a stored redirect answers the request", () => {
  it("a document request gets the 3xx, not a page", async () => {
    const { served, thrown, buildReads } = await lookup({
      overlay: redirectEntry,
    });

    expect(served).toEqual([]);
    expect(thrown).toBeInstanceOf(Response);
    const response = thrown as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/product/43");
    // The shape redirect() builds, so the request handler treats it as the
    // router's own redirect and not an upstream 3xx.
    expect(response.headers.get("X-RSC-Redirect")).toBe("soft");
    // The bundled manifest is not even read: the overlay answered.
    expect(buildReads).toBe(0);
  });

  it("a Passthrough route's request does not run its live handler", async () => {
    const { served, thrown, buildReads } = await lookup({
      overlay: redirectEntry,
      passthrough: true,
    });

    expect(served).toEqual([]);
    expect((thrown as Response).status).toBe(302);
    expect(buildReads).toBe(0);
  });

  it("a plain route's server-action re-render gets the 3xx too", async () => {
    const { served, thrown, buildReads } = await lookup({
      overlay: redirectEntry,
      action: true,
    });

    expect(served).toEqual([]);
    expect((thrown as Response).status).toBe(302);
    expect(buildReads).toBe(0);
  });

  it("a partial navigation gets the same 3xx, for the handler to make a soft redirect", async () => {
    const { served, thrown } = await lookup({
      overlay: redirectEntry,
      partial: true,
    });

    expect(served).toEqual([]);
    // A 3xx with a Location: what interceptRedirectForPartial converts to the
    // Flight soft redirect (rsc/helpers.ts).
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe("/product/43");
  });

  it("the status the handler answered with is kept", async () => {
    const { thrown } = await lookup({
      overlay: (now) =>
        redirectEntry(now, { status: 308, location: "/product/43" }),
    });

    expect((thrown as Response).status).toBe(308);
  });

  it("an external redirect is replayed with its opt-in branded, so the guard lets it through", async () => {
    // The opt-in is a WeakSet brand on the Response, which a store cannot
    // carry: without re-branding, guardOutgoingRedirect (rsc/redirect-guard.ts)
    // rewrites an off-host Location to the app root.
    const external = { status: 302, location: "https://elsewhere.example/x" };
    const plain = await lookup({
      overlay: (now) => redirectEntry(now, external),
    });
    expect((plain.thrown as Response).headers.get("Location")).toBe(
      external.location,
    );
    expect(isExternalRedirect(plain.thrown as Response)).toBe(false);

    const branded = await lookup({
      overlay: (now) =>
        redirectEntry(now, { ...external, external: true as const }),
    });
    expect(isExternalRedirect(branded.thrown as Response)).toBe(true);
    expect((branded.thrown as Response).headers.get("Location")).toBe(
      external.location,
    );
  });

  it("a stale redirect still answers, and schedules onRevalidate like a stale page", async () => {
    const onRevalidate = vi.fn();
    const { thrown } = await lookup({
      // Written 5s ago with a 1s ttl: stale, and rechecked.
      overlay: (now) => redirectEntry(now - 5000, REDIRECT, 1),
      onRevalidate,
    });

    await vi.waitFor(() => expect(onRevalidate).toHaveBeenCalledTimes(1));
    expect(onRevalidate.mock.calls[0]![0]).toEqual({
      route: "product",
      params: PARAMS,
    });
    // The redirect keeps answering while it is rechecked.
    expect((thrown as Response).status).toBe(302);
  });

  it("a fresh redirect schedules nothing", async () => {
    const onRevalidate = vi.fn();
    const { thrown } = await lookup({
      overlay: (now) => redirectEntry(now, REDIRECT, 3600),
      onRevalidate,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(onRevalidate).not.toHaveBeenCalled();
    expect((thrown as Response).status).toBe(302);
  });
});

describe("withCacheLookup: what a stored redirect does not answer", () => {
  it("an intercepted navigation reads no overlay entry, as with a marker: the build-time entry serves", async () => {
    const { served, thrown } = await lookup({
      overlay: redirectEntry,
      intercept: true,
    });

    expect(thrown).toBeUndefined();
    expect(served).toEqual(["BUILD"]);
  });

  it("a malformed redirect envelope is a miss, not a broken Response", async () => {
    const shapes: unknown[] = [
      // Not a 3xx: the serve path could not build the redirect Response.
      { v: 1, redirect: { status: 200, location: "/product/43" } },
      { v: 1, redirect: { status: 302.5, location: "/product/43" } },
      { v: 1, redirect: { status: 302 } },
      { v: 1, redirect: { status: 302, location: "" } },
      // The opt-in is `true` or absent; anything else is not a stored shape.
      { v: 1, redirect: { status: 302, location: "/x", external: false } },
      { v: 1, redirect: { status: 302, location: "/x", external: "yes" } },
      // A page and a redirect in one envelope: not a shape the router writes.
      {
        v: 1,
        redirect: REDIRECT,
        entry: { segments: [], handles: "" },
      },
    ];
    for (const shape of shapes) {
      const { served, thrown } = await lookup({
        read: async () => ({
          ...(shape as object),
          meta: {
            storedAt: Date.now(),
            tags: [],
            version: KEY.version,
            params: PARAMS,
          },
        }),
      });

      expect(thrown, JSON.stringify(shape)).toBeUndefined();
      expect(served, JSON.stringify(shape)).toEqual(["BUILD"]);
    }
  });

  it("another param set's redirect does not answer this one (collision guard)", async () => {
    const { served, thrown } = await lookup({
      read: async () => ({
        ...redirectEntry(Date.now()),
        meta: {
          storedAt: Date.now(),
          tags: [],
          version: KEY.version,
          params: { id: "99" },
        },
      }),
    });

    expect(thrown).toBeUndefined();
    expect(served).toEqual(["BUILD"]);
  });

  it("a store that cannot be read is a miss, as for a page", async () => {
    const { served, thrown } = await lookup({
      read: async () => {
        throw new Error("kv down");
      },
    });

    expect(thrown).toBeUndefined();
    expect(served).toEqual(["BUILD"]);
  });
});
