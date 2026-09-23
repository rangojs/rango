/**
 * "use cache" handle pushes through the real router: a cached function that
 * receives ctx records only its OWN pushes on a miss and appends them on a
 * hit, so the handler's and loaders' pushes into the same segment survive and
 * appear once. A stale hit's background refresh writes its pushes into the
 * refreshed entry, not the live response.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

// JSON stand-in for the Flight codec (plugin-rsc is a virtual module).
function pluginRscMock() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    createTemporaryReferenceSet: () => new Set(),
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async (args: unknown[]) => JSON.stringify(args),
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
import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { registerCachedFunction } from "../cache-runtime.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#UseCacheCrumbs");

// "use cache" function that receives ctx (tainted) and pushes a crumb.
const productCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("product");
    return "product-data";
  },
  "test#productCrumb",
  "default",
);

const slowProductCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("product");
    // Hold the cached body open so the DSL loader pushes during it.
    await new Promise<void>((r) => setTimeout(r, 20));
    return "product-data";
  },
  "test#slowProductCrumb",
  "default",
);

const loaderBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("loader");
  return { ok: true };
});
const CrumbLoader = (createLoader as Function)(
  loaderBody,
  undefined,
  "test#UseCacheCrumbLoader",
);

const outerBody = vi.fn(async (ctx: any) => {
  ctx.use(Crumbs)("outer");
  await productCrumb(ctx);
  return "outer-data";
});
const outerCrumb = registerCachedFunction(
  outerBody,
  "test#outerCrumb",
  "default",
);

const sharedCrumb = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)("shared");
    return "shared";
  },
  "test#sharedCrumb",
  "default",
);

let innerVersion = 0;
const innerVersioned = registerCachedFunction(
  async (ctx: any) => {
    innerVersion++;
    ctx.use(Crumbs)(`inner-v${innerVersion}`);
    return innerVersion;
  },
  "test#innerVersioned",
  "default",
);
const outerOverStale = registerCachedFunction(
  async (ctx: any) => {
    await innerVersioned(ctx);
    // Still running while the inner stale hit's background refresh pushes.
    await new Promise((r) => setTimeout(r, 20));
    return "outer";
  },
  "test#outerOverStale",
  "default",
);

let version = 0;
const versionedCrumb = registerCachedFunction(
  async (ctx: any) => {
    version++;
    ctx.use(Crumbs)(`v${version}`);
    return version;
  },
  "test#versionedCrumb",
  "default",
);

let router: any;
let cacheStore: MemorySegmentCacheStore;

beforeAll(async () => {
  cacheStore = new MemorySegmentCacheStore();
  router = createRouter({} as any);
  router.routes(({ path, loader, layout }: any) => [
    layout(
      async (ctx: any) => {
        await sharedCrumb(ctx);
        return createElement("div", null, "shared-layout");
      },
      () => [
        path(
          "/shared",
          async (ctx: any) => {
            await sharedCrumb(ctx);
            return createElement("div", null, "shared-page");
          },
          { name: "ucShared" },
        ),
      ],
    ),
    path(
      "/before",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await productCrumb(ctx);
        return createElement("div", null, "before");
      },
      { name: "ucBefore" },
    ),
    path(
      "/nested",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await outerCrumb(ctx);
        return createElement("div", null, "nested");
      },
      { name: "ucNested" },
    ),
    path(
      "/outer-stale",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await outerOverStale(ctx);
        return createElement("div", null, "outer-stale");
      },
      { name: "ucOuterStale" },
    ),
    path(
      "/stale",
      async (ctx: any) => {
        ctx.use(Crumbs)("home");
        await versionedCrumb(ctx);
        return createElement("div", null, "stale");
      },
      { name: "ucStale" },
    ),
    path(
      "/concurrent",
      async (ctx: any) => {
        await slowProductCrumb(ctx);
        return createElement("div", null, "concurrent");
      },
      { name: "ucConcurrent" },
      () => [loader(CrumbLoader)],
    ),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

async function serve(pathname: string, errors?: unknown[]): Promise<unknown[]> {
  return Object.values(await serveBySegment(pathname, errors)).flat();
}

async function serveBySegment(
  pathname: string,
  errors?: unknown[],
): Promise<Record<string, unknown[]>> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = cacheStore;
  (reqCtx as any)._cacheProfiles = { default: { ttl: 60, swr: 60 } };
  if (errors) {
    (reqCtx as any)._reportBackgroundError = (e: unknown) => errors.push(e);
  }
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  const data = await reqCtx._handleStore.getData();
  return data[Crumbs.$$id] ?? {};
}

describe('"use cache" handle capture', () => {
  it("stale hit: the refreshed entry carries the revalidation's pushes, the live response has each push once", async () => {
    const errors: unknown[] = [];
    const miss = await serve("/stale");
    expect(miss).toEqual(["home", "v1"]);

    // Next read is stale: serve v1, revalidate in the background.
    const getItem = cacheStore.getItem;
    cacheStore.getItem = async (key: string) => {
      const hit = await getItem.call(cacheStore, key);
      return hit && key.includes("versionedCrumb")
        ? { ...hit, shouldRevalidate: true }
        : hit;
    };
    const stale = await serve("/stale", errors);
    cacheStore.getItem = getItem;
    expect(version).toBe(2);
    expect(stale).toEqual(["home", "v1"]);
    expect(errors).toEqual([]);

    const hit = await serve("/stale");
    expect(version).toBe(2);
    expect(hit).toEqual(["home", "v2"]);
  });

  it("an outer cached function does not record an inner stale hit's background refresh", async () => {
    await serve("/outer-stale");

    // Outer misses, inner is stale: the inner replays inner-v1 (recorded by
    // the outer) and refreshes to inner-v2 in the background while the outer
    // body is still running.
    const getItem = cacheStore.getItem;
    cacheStore.getItem = async (key: string) => {
      if (key.includes("outerOverStale")) return null;
      const hit = await getItem.call(cacheStore, key);
      return hit && key.includes("innerVersioned")
        ? { ...hit, shouldRevalidate: true }
        : hit;
    };
    const rebuilt = await serve("/outer-stale");
    cacheStore.getItem = getItem;
    expect(innerVersion).toBe(2);
    expect(rebuilt).toEqual(["home", "inner-v1"]);

    // The rebuilt outer entry replays what its body saw, not the refresh.
    const hit = await serve("/outer-stale");
    expect(hit).toEqual(["home", "inner-v1"]);
  });

  it("replays into the calling segment when a layout and its page call the same function", async () => {
    const miss = await serveBySegment("/shared");
    const hit = await serveBySegment("/shared");
    // One copy per calling segment (two segments), on the miss and the hit.
    expect(Object.values(miss)).toEqual([["shared"], ["shared"]]);
    expect(hit).toEqual(miss);
  });

  it("a handler push made before the cached call survives the HIT", async () => {
    const miss = await serve("/before");
    const hit = await serve("/before");
    expect(miss).toEqual(["home", "product"]);
    expect(hit).toEqual(["home", "product"]);
  });

  it("a DSL loader push made while the cached body runs appears once on the HIT", async () => {
    const miss = await serve("/concurrent");
    const hit = await serve("/concurrent");
    expect(loaderBody).toHaveBeenCalledTimes(2);
    expect(miss.filter((v) => v === "loader")).toHaveLength(1);
    expect(hit.filter((v) => v === "loader")).toHaveLength(1);
    expect(hit.filter((v) => v === "product")).toHaveLength(1);
  });

  it("an outer cached function records the pushes of cached functions it calls", async () => {
    const miss = await serve("/nested");
    const hit = await serve("/nested");
    expect(outerBody).toHaveBeenCalledTimes(1);
    expect(miss).toEqual(["home", "outer", "product"]);
    expect(hit).toEqual(["home", "outer", "product"]);
  });
});
