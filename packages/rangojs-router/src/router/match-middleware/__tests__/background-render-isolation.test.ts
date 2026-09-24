/**
 * A background re-render of a cached route (stale-hit revalidation, proactive
 * caching) must not write into the live request's per-render state. It runs
 * while the foreground is still producing the page:
 *   - handle pushes: on a stale route cache() HIT the DSL loaders re-run live,
 *     and a loader pushes through the request context's `_handleStore` at push
 *     time (loader-resolution.ts). Swapping that shared field for the
 *     background store sent those pushes to the background render instead of
 *     the page. Proactive caching (a partial navigation whose layout the client
 *     already has) re-renders the same way once the response exists, while the
 *     body is still streaming.
 *   - transition({ when }) predicates: fresh resolution records them on
 *     `_transitionWhen`, which the foreground's gateTransitions reads after the
 *     match. A stale HIT collects none (it replays the stored transition).
 *   - perf metrics: the foreground's `_metricsStore` feeds its Server-Timing.
 *   - response writes: header/setCookie/setStatus/onResponse are closures over
 *     (or `this`-reads of) the live request's stub response and callback list.
 *     A layout above the cache() boundary is cached with the route but is not
 *     latched by the header guard, so the refresh re-runs its writes; an error
 *     boundary in the refresh sets a status the same way.
 *   - the cache write: a re-render that resolves an error or notFound boundary
 *     is not written, as a non-200 MISS is not (cache-store.ts), so the entry
 *     it would replace keeps serving.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
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

import { createElement } from "react";
import { createRouter } from "../../../router.js";
import { createLoader } from "../../../loader.rsc.js";
import { createHandle } from "../../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../../cache/memory-segment-store.js";
import { gateTransitions } from "../../../rsc/transition-gate.js";
import { createResponseWithMergedHeaders } from "../../../rsc/helpers.js";
import { cookies } from "../../../server/cookie-store.js";
import { notFound } from "../../../errors.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#BgRenderCrumbs");

// Invoked only from a handler, never registered with loader(): a stale HIT
// skips the handler, so only the background re-render runs it.
const HandlerOnlyLoader = (createLoader as Function)(
  async () => ({ ok: true }),
  undefined,
  "test#BgRenderHandlerOnlyLoader",
);

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

let handlerCalls = 0;
let layoutCalls = 0;
let transitionHandlerCalls = 0;
let metricsHandlerCalls = 0;
let writerLayoutCalls = 0;
let bgOnResponseCalls = 0;
let failStatusRoute = false;
let statusHandlerCalls = 0;
let refreshMode: "ok" | "error" | "notFound" = "ok";
let refreshContent = "v1";
let refreshHandlerCalls = 0;
let proactiveLayoutFail = false;
let proactiveRouteCalls = 0;
let layoutGate: ReturnType<typeof gate> | undefined;
let handlerGate: ReturnType<typeof gate> | undefined;
let loaderGate: ReturnType<typeof gate> | undefined;

function refreshHandler() {
  refreshHandlerCalls++;
  if (refreshMode === "error") throw new Error("upstream down");
  if (refreshMode === "notFound") notFound();
  return createElement("div", null, refreshContent);
}

const CrumbLoader = (createLoader as Function)(
  async (ctx: any) => {
    await loaderGate?.promise;
    ctx.use(Crumbs)("loader");
    return { ok: true };
  },
  undefined,
  "test#BgRenderCrumbLoader",
);

let router: any;
let lastSegments: Array<{
  id: string;
  type: string;
  transition?: unknown;
  component?: any;
}> = [];
let lastReqCtx: RequestContext<any>;
let store: MemorySegmentCacheStore;
let serveStale = false;

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const hit = await get(key);
    return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
  };
  router = createRouter({} as any);
  router.routes(({ path, loader, cache, layout, loading, transition }: any) => [
    cache({ ttl: 60, store }, () => [
      layout(
        async () => {
          layoutCalls++;
          await layoutGate?.promise;
          return createElement("div", null, "shop-layout");
        },
        () => [
          path("/shop/a", () => createElement("div", null, "a"), {
            name: "bgRenderShopA",
          }),
          path(
            "/shop/b",
            () => createElement("div", null, "b"),
            { name: "bgRenderShopB" },
            // Streamed: the loader outlives the response.
            () => [loader(CrumbLoader), loading(createElement("p"))],
          ),
        ],
      ),
      path(
        "/stale-route",
        async (ctx: any) => {
          handlerCalls++;
          await handlerGate?.promise;
          ctx.use(Crumbs)("handler");
          return createElement("div", null, "page");
        },
        { name: "bgRenderStaleRoute" },
        () => [loader(CrumbLoader)],
      ),
      path(
        "/stale-transition",
        () => {
          transitionHandlerCalls++;
          return createElement("div", null, "t");
        },
        { name: "bgRenderStaleTransition" },
        () => [transition({ enter: "fade", when: () => false })],
      ),
      path(
        "/stale-metrics",
        async (ctx: any) => {
          metricsHandlerCalls++;
          await ctx.use(HandlerOnlyLoader);
          return createElement("div", null, "m");
        },
        { name: "bgRenderStaleMetrics" },
      ),
      path(
        "/stale-status",
        () => {
          statusHandlerCalls++;
          if (failStatusRoute) throw new Error("upstream down");
          return createElement("div", null, "s");
        },
        { name: "bgRenderStaleStatus" },
      ),
      path("/refresh-error", refreshHandler, { name: "bgRenderRefreshError" }),
      path("/refresh-not-found", refreshHandler, {
        name: "bgRenderRefreshNotFound",
      }),
      layout(
        () => {
          if (proactiveLayoutFail) throw new Error("upstream down");
          return createElement("div", null, "pro-layout");
        },
        () => [
          path("/pro/a", () => createElement("div", null, "a"), {
            name: "bgRenderProA",
          }),
          path(
            "/pro/b",
            () => {
              proactiveRouteCalls++;
              return createElement("div", null, "b");
            },
            { name: "bgRenderProB" },
          ),
        ],
      ),
    ]),
    // Above the cache() boundary: its writes are allowed on a MISS (the guard
    // latches at the boundary), and its segment is cached with the route, so
    // a HIT skips it.
    layout(
      (ctx: any) => {
        const reqCtx = getRequestContext();
        reqCtx.header("x-bg", "1");
        ctx.headers.set("x-bg-handler", "1");
        cookies().set("bg", "1");
        cookies().delete("bg-gone");
        reqCtx.setStatus(203);
        reqCtx.onResponse((res: Response) => {
          bgOnResponseCalls++;
          return res;
        });
        writerLayoutCalls++;
        return createElement("div", null, "writer-layout");
      },
      () => [
        cache({ ttl: 60, store }, () => [
          path("/bg-writes/a", () => createElement("div", null, "a"), {
            name: "bgRenderWritesA",
          }),
          path("/bg-writes/b", () => createElement("div", null, "b"), {
            name: "bgRenderWritesB",
          }),
        ]),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function serve(
  pathname: string,
  whileServing?: () => Promise<void>,
  partial?: { clientSegments: string[] },
  debugPerformance?: boolean,
): Promise<unknown[]> {
  const request = partial
    ? new Request(
        `https://example.com${pathname}?_rsc_partial&_rsc_segments=${partial.clientSegments.join(",")}`,
        {
          headers: {
            accept: "text/x-component",
            "X-RSC-Router-Client-Path": "https://example.com/shop/a",
          },
        },
      )
    : new Request(`https://example.com${pathname}`, {
        headers: { accept: "text/html" },
      });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  reqCtx._debugPerformance = debugPerformance;
  lastReqCtx = reqCtx;
  // The live store, pinned before anything can swap the context field.
  const liveStore = reqCtx._handleStore;
  const fireOnResponse = () => {
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: 200 }));
    }
  };
  await runWithRequestContext(reqCtx, async () => {
    const result = partial
      ? await router.matchPartial(request, { env: {} })
      : await router.match(request, { env: {} });
    lastSegments = result.segments;
    const settled = (async () => {
      liveStore.seal();
      await liveStore.fullySettled;
    })();
    // A streamed response exists before its loaders settle.
    if (partial) fireOnResponse();
    await whileServing?.();
    await settled;
    fireOnResponse();
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  const data = await liveStore.getData();
  return Object.values(data[Crumbs.$$id] ?? {}).flat();
}

describe("background re-render of a stale cached route", () => {
  it("a live loader push made while the background re-render runs reaches the page", async () => {
    // Order across the handler and loader is a race; compare contents.
    const miss = await serve("/stale-route");
    expect(miss.sort()).toEqual(["handler", "loader"]);

    serveStale = true;
    handlerGate = gate();
    loaderGate = gate();
    const stale = await serve("/stale-route", async () => {
      // The background re-render is inside the handler (handler skipped in
      // the foreground on a HIT, so this is the refresh's call).
      await vi.waitFor(() => expect(handlerCalls).toBe(2));
      // The live loader pushes while the refresh is still running.
      loaderGate!.open();
      await new Promise((r) => setTimeout(r, 0));
      handlerGate!.open();
    });
    serveStale = false;

    expect(stale.sort()).toEqual(["handler", "loader"]);
  });

  it("proactive caching's re-render leaves live loader pushes on the page", async () => {
    await serve("/shop/a");
    // The client navigating from /shop/a already has every layout.
    const layoutIds = lastSegments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);
    const layoutCallsBefore = layoutCalls;

    layoutGate = gate();
    loaderGate = gate();
    const partialNav = await serve(
      "/shop/b",
      async () => {
        // The client has the layout, so only the proactive re-render calls it.
        await vi.waitFor(() => expect(layoutCalls).toBe(layoutCallsBefore + 1));
        loaderGate!.open();
        await new Promise((r) => setTimeout(r, 0));
        layoutGate!.open();
      },
      { clientSegments: layoutIds },
    );

    expect(partialNav).toEqual(["loader"]);
  });

  it("the refresh adds no transition({ when }) predicate to the stale HIT's gate", async () => {
    await serve("/stale-transition");
    serveStale = true;
    await serve("/stale-transition");
    serveStale = false;
    // The HIT skips the handler, so the second call is the refresh's.
    expect(transitionHandlerCalls).toBe(2);

    // serve() awaited the refresh, so the gate below runs after it: the
    // interleaving where the refresh resolves before the foreground's gate.
    expect(lastReqCtx._transitionWhen).toEqual([]);
    const [route] = gateTransitions(lastSegments as any, lastReqCtx).filter(
      (s) => s.type === "route",
    );
    // The stale HIT replays the stored transition; the predicate never runs.
    expect(route?.transition).toEqual({ enter: "fade" });
  });

  it("the refresh records no metrics on the foreground's perf timeline", async () => {
    await serve("/stale-metrics");
    serveStale = true;
    await serve("/stale-metrics", undefined, undefined, true);
    serveStale = false;
    expect(metricsHandlerCalls).toBe(2);

    // The HIT runs no handler, so a handler or handler-invoked loader metric
    // could only come from the refresh.
    const labels = lastReqCtx._metricsStore!.metrics.map((m) => m.label);
    expect(
      labels.filter(
        (l) =>
          l.startsWith("handler:") || l === `loader:${HandlerOnlyLoader.$$id}`,
      ),
    ).toEqual([]);
  });

  it("the refresh's header, cookie, status and onResponse writes stay off the stale HIT's response", async () => {
    await serve("/bg-writes/a");
    expect(writerLayoutCalls).toBe(1);
    const onResponseBefore = bgOnResponseCalls;

    serveStale = true;
    let response!: Response;
    await serve("/bg-writes/a", async () => {
      // The HIT skips the layout, so this call is the refresh's. The
      // foreground builds its Response after it (an HTML response waits on
      // SSR first).
      await vi.waitFor(() => expect(writerLayoutCalls).toBe(2));
      response = createResponseWithMergedHeaders(null, { status: 200 });
    });
    serveStale = false;

    expect({
      status: response.status,
      header: response.headers.get("x-bg"),
      handlerHeader: response.headers.get("x-bg-handler"),
      setCookie: response.headers.getSetCookie(),
      onResponseCalls: bgOnResponseCalls - onResponseBefore,
      // Nothing left on the live request for a later merge point either.
      stubHeader: lastReqCtx.res.headers.get("x-bg"),
      pendingCallbacks: lastReqCtx._onResponseCallbacks.length,
    }).toEqual({
      status: 200,
      header: null,
      handlerHeader: null,
      setCookie: [],
      onResponseCalls: 0,
      stubHeader: null,
      pendingCallbacks: 0,
    });
  });

  it("proactive caching's re-render writes nothing to the live response", async () => {
    await serve("/bg-writes/a");
    const layoutIds = lastSegments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);
    const callsBefore = writerLayoutCalls;
    const onResponseBefore = bgOnResponseCalls;

    await serve(
      "/bg-writes/b",
      // The client has the layout, so only the proactive re-render calls it.
      () => vi.waitFor(() => expect(writerLayoutCalls).toBe(callsBefore + 1)),
      { clientSegments: layoutIds },
    );

    expect(writerLayoutCalls).toBe(callsBefore + 1);
    // serve() drains onResponse again after the re-render, like the
    // post-middleware finalizeResponse in rsc/handler.ts; the middleware
    // merge re-reads the stub (router/middleware.ts mergeReqCtxStub).
    expect({
      onResponseCalls: bgOnResponseCalls - onResponseBefore,
      status: lastReqCtx.res.status,
      header: lastReqCtx.res.headers.get("x-bg"),
      handlerHeader: lastReqCtx.res.headers.get("x-bg-handler"),
      setCookie: lastReqCtx.res.headers.getSetCookie(),
    }).toEqual({
      onResponseCalls: 0,
      status: 200,
      header: null,
      handlerHeader: null,
      setCookie: [],
    });
  });

  it("an error boundary in the refresh leaves the stale HIT's status alone", async () => {
    await serve("/stale-status");
    serveStale = true;
    failStatusRoute = true;
    let response!: Response;
    await serve("/stale-status", async () => {
      await vi.waitFor(() => expect(statusHandlerCalls).toBe(2));
      // The boundary sets the status once the throw unwinds.
      await new Promise((r) => setTimeout(r, 0));
      response = createResponseWithMergedHeaders(null, { status: 200 });
    });
    serveStale = false;
    failStatusRoute = false;

    expect([response.status, lastReqCtx.res.status]).toEqual([200, 200]);
  });
});

describe("a background re-render that resolves an error or notFound boundary", () => {
  function served() {
    return {
      segments: lastSegments.map((s) => `${s.type}:${s.id}`),
      route: lastSegments.find((s) => s.type === "route")?.component?.props
        ?.children,
    };
  }

  // MISS, then a stale HIT whose refresh resolves `mode`, then a HIT.
  async function failRefresh(pathname: string, mode: "error" | "notFound") {
    await serve(pathname);
    const miss = served();
    serveStale = true;
    refreshMode = mode;
    await serve(pathname);
    serveStale = false;
    refreshMode = "ok";
    const callsBefore = refreshHandlerCalls;
    await serve(pathname);
    return {
      miss,
      hit: served(),
      handlerRan: refreshHandlerCalls !== callsBefore,
    };
  }

  it("a refresh that throws leaves the stale entry serving", async () => {
    const { miss, hit, handlerRan } = await failRefresh(
      "/refresh-error",
      "error",
    );
    expect(miss.route).toBe("v1");
    expect({ hit, handlerRan }).toEqual({ hit: miss, handlerRan: false });

    // Nothing left by the failed refresh blocks the next one.
    refreshContent = "v2";
    serveStale = true;
    await serve("/refresh-error");
    serveStale = false;
    await serve("/refresh-error");
    refreshContent = "v1";
    expect(served().route).toBe("v2");
  });

  it("a refresh that calls notFound() leaves the stale entry serving", async () => {
    const { miss, hit, handlerRan } = await failRefresh(
      "/refresh-not-found",
      "notFound",
    );
    expect(miss.route).toBe("v1");
    expect({ hit, handlerRan }).toEqual({ hit: miss, handlerRan: false });
  });

  it("proactive caching writes nothing when only its re-render throws", async () => {
    await serve("/pro/a");
    const layoutIds = lastSegments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);

    // The client has the layout, so the foreground skips it and only the
    // proactive re-render throws.
    proactiveLayoutFail = true;
    await serve("/pro/b", undefined, { clientSegments: layoutIds });
    proactiveLayoutFail = false;
    const errorSegments = () =>
      served().segments.filter((s) => s.startsWith("error:"));
    expect(errorSegments()).toEqual([]);

    // A client without the layout: a HIT would serve a written error segment
    // in the layout's place; a MISS renders it and runs the route handler.
    const callsBefore = proactiveRouteCalls;
    await serve("/pro/b", undefined, { clientSegments: [] });
    expect({
      errors: errorSegments(),
      handlerRan: proactiveRouteCalls !== callsBefore,
    }).toEqual({ errors: [], handlerRan: true });
  });
});
