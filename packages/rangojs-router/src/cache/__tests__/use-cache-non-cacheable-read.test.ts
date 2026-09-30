/**
 * Non-cacheable variable reads inside a "use cache" body (issue #925).
 *
 * A `createVar({ cache: false })` value (or a `ctx.set(..., { cache: false })`
 * write) is request data the cache key does not include. Read inside a cached
 * body, the first caller's value was stored and served to every later caller
 * with no error; only the cache() DSL boundary guarded the read. Drives the
 * production registerCachedFunction, RequestContext, HandlerContext and loader
 * executor (setupLoaderAccess), with the Flight codec replaced by JSON
 * (plugin-rsc is a virtual module vitest cannot resolve).
 */
import { describe, it, expect, vi } from "vitest";

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

import { registerCachedFunction } from "../cache-runtime.js";
import { runWithCacheExecScope } from "../cache-exec-scope.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { createVar } from "../../context-var.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import {
  RangoContext,
  runInsideLoaderBodyScope,
  runInsideLoaderScope,
} from "../../server/context.js";
import { createHandlerContext } from "../../router/handler-context.js";
import { setupLoaderAccess } from "../../router/loader-resolution.js";
import { executeLoaderMiddleware } from "../../router/middleware.js";
import type { MiddlewareContext } from "../../router/middleware-types.js";
import type {
  HandlerContext,
  LoaderContext,
  LoaderDefinition,
} from "../../types.js";

const Tenant = createVar<string>({ cache: false });
const Locale = createVar<string>();

const USE_CACHE_READ = /non-cacheable variable.*inside a "use cache" function/;
const PASS_AS_ARG = /pass the value in as an argument/;
const CACHE_DSL_READ =
  "ctx.get() for a non-cacheable variable cannot be called inside a cache() boundary.";

function makeReqCtx(
  store: MemorySegmentCacheStore,
  tenant: string,
): RequestContext<any> {
  const url = new URL("https://shop.test/nav");
  const ctx = createRequestContext({
    env: {},
    request: new Request(url),
    url,
    variables: {},
    cacheStore: store,
    cacheProfiles: { default: { ttl: 60 } },
  });
  ctx.set(Tenant, tenant);
  ctx.set(Locale, `locale-${tenant}`);
  return ctx;
}

function makeHandlerCtx(reqCtx: RequestContext<any>): HandlerContext<any> {
  const ctx = createHandlerContext(
    {},
    reqCtx.request,
    reqCtx.searchParams,
    reqCtx.pathname,
    reqCtx.url,
  );
  setupLoaderAccess(ctx, new Map());
  return ctx;
}

/** Run `fn` with a fresh request (and handler ctx) for `tenant`. */
function inRequest<T>(
  store: MemorySegmentCacheStore,
  tenant: string,
  fn: (hctx: HandlerContext<any>, reqCtx: RequestContext<any>) => T,
): T {
  const reqCtx = makeReqCtx(store, tenant);
  return runWithRequestContext(reqCtx, () =>
    fn(makeHandlerCtx(reqCtx), reqCtx),
  );
}

function loaderDef<T>(
  id: string,
  fn: (ctx: LoaderContext) => Promise<T>,
): LoaderDefinition<T> {
  return { __brand: "loader", $$id: id, fn } as unknown as LoaderDefinition<T>;
}

describe('"use cache": non-cacheable variable reads (#925)', () => {
  it("getRequestContext().get() throws, and nothing is stored for the next caller", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async () => `nav:${getRequestContext().get(Tenant)}`,
      "test#925:ambient",
      "default",
    );

    await expect(inRequest(store, "a", () => getNav())).rejects.toThrow(
      USE_CACHE_READ,
    );
    // Before #925 the first call stored "nav:a" and this one returned it.
    await expect(inRequest(store, "b", () => getNav())).rejects.toThrow(
      USE_CACHE_READ,
    );
  });

  it("a handler ctx passed in throws the same way", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async (ctx: HandlerContext<any>) => `nav:${ctx.get(Tenant)}`,
      "test#925:handler-ctx",
      "default",
    );

    await expect(inRequest(store, "a", (hctx) => getNav(hctx))).rejects.toThrow(
      USE_CACHE_READ,
    );
  });

  it("a write-level { cache: false } string key throws, names the key, and says to pass it as an argument", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async () => `nav:${getRequestContext().get("site")}`,
      "test#925:write-level",
      "default",
    );

    const run = inRequest(store, "a", (_hctx, reqCtx) => {
      reqCtx.set("site", "a", { cache: false });
      return getNav();
    });
    await expect(run).rejects.toThrow(/variable "site"/);
    await expect(run).rejects.toThrow(PASS_AS_ARG);
  });

  it("passing the value in as an argument keys the entry per value", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async (tenant: string) => `nav:${tenant}`,
      "test#925:as-arg",
      "default",
    );

    const read = () => getNav(getRequestContext().get(Tenant)!);
    expect(await inRequest(store, "a", read)).toBe("nav:a");
    expect(await inRequest(store, "b", read)).toBe("nav:b");
  });

  it("an ordinary (cacheable) var read stays allowed", async () => {
    const store = new MemorySegmentCacheStore();
    const getLocale = registerCachedFunction(
      async (ctx: HandlerContext<any>) =>
        `${getRequestContext().get(Locale)}|${ctx.get(Locale)}`,
      "test#925:cacheable",
      "default",
    );

    expect(await inRequest(store, "a", (hctx) => getLocale(hctx))).toBe(
      "locale-a|locale-a",
    );
  });

  it("reads outside any cache scope are unchanged", () => {
    const store = new MemorySegmentCacheStore();
    inRequest(store, "a", (hctx, reqCtx) => {
      expect(reqCtx.get(Tenant)).toBe("a");
      expect(hctx.get(Tenant)).toBe("a");
    });
  });
});

describe('"use cache": a loader body entered inside the function', () => {
  // Its value is part of what the function returns, so it is stored in the
  // entry, keyed without the variable: it refuses like cookies() does. Before,
  // it was exempt and the first request's value was served to the next.
  it("throws, and nothing is stored for the next caller", async () => {
    const store = new MemorySegmentCacheStore();
    const TenantLoader = loaderDef("test#925:TenantLoader", async () =>
      getRequestContext().get(Tenant),
    );
    const getNav = registerCachedFunction(
      async (ctx: HandlerContext<any>) => `nav:${await ctx.use(TenantLoader)}`,
      "test#925:loader-inside",
      "default",
    );

    for (const tenant of ["a", "b"]) {
      await expect(
        inRequest(store, tenant, (hctx) => getNav(hctx)),
      ).rejects.toThrow(USE_CACHE_READ);
    }
  });

  it("a cached function called FROM a loader body throws; the loader body alone reads", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async () => `nav:${getRequestContext().get(Tenant)}`,
      "test#925:called-from-loader",
      "default",
    );
    const NavLoader = loaderDef("test#925:NavLoader", () => getNav());

    await expect(
      inRequest(store, "a", (hctx) => hctx.use(NavLoader)),
    ).rejects.toThrow(USE_CACHE_READ);
    const TenantLoader = loaderDef("test#925:TenantLoader2", async () =>
      getRequestContext().get(Tenant),
    );
    expect(await inRequest(store, "a", (hctx) => hctx.use(TenantLoader))).toBe(
      "a",
    );
  });

  it("throws at any depth of loader body inside the function", () => {
    const store = new MemorySegmentCacheStore();
    inRequest(store, "a", (_hctx, reqCtx) => {
      runWithCacheExecScope(() =>
        runInsideLoaderBodyScope(() => {
          expect(() => reqCtx.get(Tenant)).toThrow(USE_CACHE_READ);
          runWithCacheExecScope(() => {
            expect(() => reqCtx.get(Tenant)).toThrow(USE_CACHE_READ);
          });
        }),
      );
    });
  });
});

/** Run `body` as a middleware of a request for `tenant`. */
function inMiddleware<T>(
  store: MemorySegmentCacheStore,
  tenant: string,
  body: (ctx: MiddlewareContext<any>) => Promise<T>,
): Promise<T> {
  return inRequest(store, tenant, async (_hctx, reqCtx) => {
    let result!: T;
    await executeLoaderMiddleware(
      [
        async (ctx, next) => {
          result = await body(ctx);
          return next();
        },
      ],
      reqCtx.request,
      reqCtx.env,
      {},
      reqCtx._variables,
      async () => new Response(null),
    );
    return result;
  });
}

describe('"use cache": loader and middleware ctx reads (#940)', () => {
  it("a loader ctx passed in throws, and nothing is stored for the next caller", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async (ctx: LoaderContext) => `nav:${ctx.get(Tenant)}`,
      "test#940:loader-ctx",
      "default",
    );
    const NavLoader = loaderDef("test#940:NavLoader", (ctx) => getNav(ctx));

    await expect(
      inRequest(store, "a", (hctx) => hctx.use(NavLoader)),
    ).rejects.toThrow(USE_CACHE_READ);
    await expect(
      inRequest(store, "b", (hctx) => hctx.use(NavLoader)),
    ).rejects.toThrow(USE_CACHE_READ);
  });

  it("a middleware ctx passed in throws, and nothing is stored for the next caller", async () => {
    const store = new MemorySegmentCacheStore();
    const getNav = registerCachedFunction(
      async (ctx: MiddlewareContext<any>) => `nav:${ctx.get(Tenant)}`,
      "test#940:middleware-ctx",
      "default",
    );

    await expect(
      inMiddleware(store, "a", (ctx) => getNav(ctx)),
    ).rejects.toThrow(USE_CACHE_READ);
    await expect(
      inMiddleware(store, "b", (ctx) => getNav(ctx)),
    ).rejects.toThrow(USE_CACHE_READ);
  });

  it("a loader body the function consumes through the passed loader ctx throws too", async () => {
    const store = new MemorySegmentCacheStore();
    const TenantLoader = loaderDef("test#940:TenantLoader", async (ctx) =>
      ctx.get(Tenant),
    );
    const getNav = registerCachedFunction(
      async (ctx: LoaderContext) => `nav:${await ctx.use(TenantLoader)}`,
      "test#940:loader-inside",
      "default",
    );
    const NavLoader = loaderDef("test#940:NavLoader2", (ctx) => getNav(ctx));

    await expect(
      inRequest(store, "a", (hctx) => hctx.use(NavLoader)),
    ).rejects.toThrow(USE_CACHE_READ);
  });

  it("reads outside any cache scope are unchanged", async () => {
    const store = new MemorySegmentCacheStore();
    const TenantLoader = loaderDef("test#940:TenantLoader3", async (ctx) =>
      ctx.get(Tenant),
    );
    expect(await inRequest(store, "a", (hctx) => hctx.use(TenantLoader))).toBe(
      "a",
    );
    expect(await inMiddleware(store, "a", async (ctx) => ctx.get(Tenant))).toBe(
      "a",
    );
  });

  it("a middleware ctx read stays allowed inside a cache() subtree's render scope (intercept middleware)", async () => {
    const store = new MemorySegmentCacheStore();
    const read = RangoContext.run({ insideCacheScope: true } as any, () =>
      inMiddleware(store, "a", async (ctx) => ctx.get(Tenant)),
    );
    expect(await read).toBe("a");
  });

  it("a loader ctx read stays exempt inside a cache() boundary", async () => {
    const store = new MemorySegmentCacheStore();
    const TenantLoader = loaderDef("test#940:TenantLoader4", async (ctx) =>
      ctx.get(Tenant),
    );
    const read = inRequest(store, "a", (hctx) =>
      RangoContext.run({ insideCacheScope: true } as any, () =>
        hctx.use(TenantLoader),
      ),
    );
    expect(await read).toBe("a");
  });
});

describe("cache() non-cacheable read guard is unchanged (#925)", () => {
  it("throws inside a cache() boundary for request and handler ctx", () => {
    const store = new MemorySegmentCacheStore();
    inRequest(store, "a", (hctx, reqCtx) => {
      RangoContext.run({ insideCacheScope: true } as any, () => {
        expect(() => reqCtx.get(Tenant)).toThrow(CACHE_DSL_READ);
        expect(() => hctx.get(Tenant)).toThrow(CACHE_DSL_READ);
        expect(reqCtx.get(Locale)).toBe("locale-a");
      });
    });
  });

  it("stays exempt inside a loader under a cache() boundary", () => {
    const store = new MemorySegmentCacheStore();
    inRequest(store, "a", (hctx, reqCtx) => {
      RangoContext.run({ insideCacheScope: true } as any, () => {
        runInsideLoaderScope(() => {
          expect(reqCtx.get(Tenant)).toBe("a");
          expect(hctx.get(Tenant)).toBe("a");
        });
        runInsideLoaderBodyScope(() => {
          expect(reqCtx.get(Tenant)).toBe("a");
        });
      });
    });
  });
});
