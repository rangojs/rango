/**
 * A background re-render of a cached route (stale-hit revalidation) must not
 * redirect the live request's handle pushes. It runs while the foreground is
 * still resolving: on a stale route cache() HIT the DSL loaders re-run live,
 * and a loader pushes through the request context's `_handleStore` at push
 * time (loader-resolution.ts). Swapping that shared field for the background
 * store sent those pushes to the background render instead of the page.
 * Proactive caching (a partial navigation whose layout the client already
 * has) re-renders the same way once the response exists, while the body is
 * still streaming.
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
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#BgRenderCrumbs");

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

let handlerCalls = 0;
let layoutCalls = 0;
let layoutGate: ReturnType<typeof gate> | undefined;
let handlerGate: ReturnType<typeof gate> | undefined;
let loaderGate: ReturnType<typeof gate> | undefined;

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
let lastSegments: Array<{ id: string; type: string }> = [];
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
  router.routes(({ path, loader, cache, layout, loading }: any) => [
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
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function serve(
  pathname: string,
  whileServing?: () => Promise<void>,
  partial?: { clientSegments: string[] },
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
});
