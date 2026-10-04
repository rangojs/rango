/**
 * A loader's own cache() (`loader(Def, () => [cache({...})])`) applies to the
 * DSL binding wherever it is declared, intercepts included: an intercept
 * navigation reads it through the loader cache like a route's loader does, and
 * a HIT replays the body's handle pushes. Without cache() the intercept loader
 * stays a live read, run once per request.
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

import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#InterceptCacheCrumbs");

const cachedBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)(`item-${ctx.params.id}`);
  return { id: ctx.params.id };
});
const CachedItemLoader = (createLoader as Function)(
  cachedBody,
  undefined,
  "test#InterceptCachedItemLoader",
);

const liveBody = vi.fn(async (ctx: any) => ({ id: ctx.params.id }));
const LiveItemLoader = (createLoader as Function)(
  liveBody,
  undefined,
  "test#InterceptLiveItemLoader",
);

let router: any;

beforeAll(async () => {
  const store = new MemorySegmentCacheStore();
  router = createRouter({} as any);
  router.routes(({ layout, path, intercept, loader, cache }: any) => [
    layout(
      () => <div>layout</div>,
      () => [
        path("/", <div>home</div>, { name: "icHome" }),
        path("/cached/:id", <div>cached</div>, { name: "icCached" }),
        path("/live/:id", <div>live</div>, { name: "icLive" }),
        intercept("@modal", "icCached", <div>cached-modal</div>, () => [
          loader(CachedItemLoader, () => [cache({ ttl: 60, store })]),
        ]),
        intercept(
          "@modal",
          "icLive",
          async (ctx: any) => {
            // A handler read of the same loader shares the one run.
            await ctx.use(LiveItemLoader);
            return <div>live-modal</div>;
          },
          () => [loader(LiveItemLoader)],
        ),
      ],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function navigate(pathname: string) {
  const request = new Request(`https://example.com${pathname}?_rsc_partial`, {
    headers: {
      accept: "text/x-component",
      "X-RSC-Router-Client-Path": "https://example.com/",
    },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any);
  const result = await runWithRequestContext(reqCtx, async () => {
    const r = await router.matchPartial(request, { env: {} });
    const modal = r.segments.find((s: any) => s.slot === "@modal");
    expect(modal).toBeDefined();
    await modal.loaderDataPromise;
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    return r;
  });
  const data = await reqCtx._handleStore.getData();
  return {
    result,
    crumbs: Object.values(data[Crumbs.$$id] ?? {}).flat(),
  };
}

describe("loader-level cache() on an intercept's DSL loader", () => {
  it("serves the second intercept navigation from the loader cache, with the body's handle pushes", async () => {
    const miss = await navigate("/cached/1");
    const hit = await navigate("/cached/1");

    expect(cachedBody).toHaveBeenCalledTimes(1);
    expect(miss.crumbs).toEqual(["item-1"]);
    expect(hit.crumbs).toEqual(["item-1"]);
  });

  it("without cache(), the intercept loader stays a live read, run once per request", async () => {
    await navigate("/live/1");
    await navigate("/live/1");

    // Two navigations, two runs; within each, the DSL binding and the
    // handler's ctx.use read shared one run.
    expect(liveBody).toHaveBeenCalledTimes(2);
  });
});
