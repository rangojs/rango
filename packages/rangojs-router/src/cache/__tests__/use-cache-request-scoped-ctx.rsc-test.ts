/**
 * A loader ctx and a middleware ctx passed to a "use cache" function (issue
 * #940). Only the request, handler and response-route contexts carried the
 * NOCACHE_SYMBOL brand, so a loader ctx (`getProduct(ctx)` in a loader) or a
 * middleware ctx encoded as "$T" (it holds functions) and ran uncached on
 * every call (#934). Branded, they key like a handler ctx: host, route name,
 * pathname, params and search, and they cache. Runs the real vendored
 * react-server-dom encoder and codec, which is what writes "$T".
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, {}, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const Client =
    (await import("@vitejs/plugin-rsc/react/browser")) as unknown as {
      createFromReadableStream: (
        stream: ReadableStream<Uint8Array>,
      ) => Promise<unknown>;
      encodeReply: typeof import("../../deps/rsc-client.js").encodeReply;
      createTemporaryReferenceSet: typeof import("../../deps/rsc-client.js").createClientTemporaryReferenceSet;
    };
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      Client.createFromReadableStream(stream),
    encodeReply: Client.encodeReply,
    createClientTemporaryReferenceSet: Client.createTemporaryReferenceSet,
  };
});

import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { registerCachedFunction } from "../cache-runtime.js";
import { runWithCacheExecScope } from "../cache-exec-scope.js";
import {
  createRequestContext,
  runWithRequestContext,
  setRequestContextParams,
  type RequestContext,
} from "../../server/request-context.js";
import { createHandlerContext } from "../../router/handler-context.js";
import { setupLoaderAccess } from "../../router/loader-resolution.js";
import { executeLoaderMiddleware } from "../../router/middleware.js";
import type {
  HandlerContext,
  LoaderContext,
  LoaderDefinition,
} from "../../types.js";
import type { MiddlewareContext } from "../../router/middleware-types.js";

let store: MemorySegmentCacheStore;
let lookups: string[];
let consoleWarn: MockInstance<typeof console.warn>;

beforeEach(() => {
  store = new MemorySegmentCacheStore();
  lookups = [];
  const getItem = store.getItem.bind(store);
  store.getItem = async (key: string) => {
    lookups.push(key);
    return getItem(key);
  };
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  consoleWarn.mockRestore();
});

interface Route {
  url: string;
  params?: Record<string, string>;
  routeName?: string;
  responseType?: string;
}

/** Run `fn` in a request for `route`, its deferred cache writes flushed. */
async function inRequest<T>(
  route: Route,
  fn: (reqCtx: RequestContext<any>) => Promise<T>,
): Promise<T> {
  const request = new Request(route.url);
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(route.url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = store;
  (reqCtx as any)._cacheProfiles = { default: { ttl: 60, swr: 60 } };
  return runWithRequestContext(reqCtx, async () => {
    if (route.routeName) {
      setRequestContextParams(route.params ?? {}, route.routeName);
    }
    const result = await fn(reqCtx);
    const tasks = reqCtx._pendingBackgroundTasks ?? [];
    for (let i = 0; i < tasks.length; i++) await tasks[i];
    return result;
  });
}

function handlerCtx(
  reqCtx: RequestContext<any>,
  route: Route,
): HandlerContext<any> {
  const ctx = createHandlerContext(
    route.params ?? {},
    reqCtx.request,
    reqCtx.searchParams,
    reqCtx.pathname,
    reqCtx.url,
    reqCtx.env,
    {},
    route.routeName,
    route.responseType,
  );
  setupLoaderAccess(ctx, new Map());
  return ctx;
}

let loaderSeq = 0;
function loaderDef<T>(fn: (ctx: LoaderContext) => Promise<T>) {
  return {
    __brand: "loader",
    $$id: `test#940:loader${++loaderSeq}`,
    fn,
  } as unknown as LoaderDefinition<T>;
}

/** Run `body` as a loader of `route`, through the production executor. */
function inLoader<T>(
  route: Route,
  body: (ctx: LoaderContext) => Promise<T>,
): Promise<T> {
  return inRequest(route, async (reqCtx) =>
    handlerCtx(reqCtx, route).use(loaderDef(body)),
  );
}

/** Run `body` as a middleware for `route`, through executeMiddleware. */
function inMiddleware<T>(
  route: Route,
  body: (ctx: MiddlewareContext<any>) => Promise<T>,
): Promise<T> {
  return inRequest(route, async (reqCtx) => {
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
      route.params ?? {},
      reqCtx._variables,
      async () => new Response(null),
    );
    return result;
  });
}

/** A cached function returning its call count, so a hit repeats a count. */
function counted(id: string) {
  let calls = 0;
  const cached = registerCachedFunction(
    async (..._args: unknown[]) => ++calls,
    id,
    "default",
  );
  return { cached, calls: () => calls };
}

const product = (id: string, search = "", host = "shop.example"): Route => ({
  url: `https://${host}/p/${id}${search}`,
  params: { id },
  routeName: "product",
});

describe('"use cache": a loader ctx argument keys by route (#940)', () => {
  it("hits on the same route and params, misses on other params, search or host", async () => {
    const { cached, calls } = counted("test#940:loaderCtx");
    const call = (route: Route) => inLoader(route, (ctx) => cached(ctx));

    expect(await call(product("1"))).toBe(1);
    expect(await call(product("1"))).toBe(1);
    expect(await call(product("2"))).toBe(2);
    expect(await call(product("1", "?sort=asc"))).toBe(3);
    expect(await call(product("1", "", "other.example"))).toBe(4);
    expect(calls()).toBe(4);
  });

  it("folds in the route name: the same URL under another route misses", async () => {
    const { cached } = counted("test#940:loaderCtxRouteName");
    const call = (routeName: string) =>
      inLoader({ ...product("1"), routeName }, (ctx) => cached(ctx));

    expect(await call("product")).toBe(1);
    expect(await call("product")).toBe(1);
    expect(await call("productAlt")).toBe(2);
  });

  it("keys exactly as the handler ctx of the same request", async () => {
    const { cached } = counted("test#940:loaderHandlerParity");
    const route = { ...product("7", "?color=red"), responseType: "json" };
    await inRequest(route, async (reqCtx) => {
      const hctx = handlerCtx(reqCtx, route);
      await cached(hctx);
      await hctx.use(loaderDef((ctx) => cached(ctx)));
    });
    expect(lookups).toHaveLength(2);
    expect(lookups[0]).toContain('"json"');
    expect(lookups[1]).toBe(lookups[0]);
  });

  it("a loader read through the request ctx (server action lane) keys the same way", async () => {
    const { cached, calls } = counted("test#940:actionLoaderCtx");
    const call = (route: Route) =>
      inRequest(route, (reqCtx) => reqCtx.use(loaderDef((ctx) => cached(ctx))));

    expect(await call(product("1"))).toBe(1);
    expect(await call(product("1"))).toBe(1);
    expect(await call({ ...product("1"), routeName: "productAlt" })).toBe(2);
    expect(await call(product("2"))).toBe(3);
    expect(calls()).toBe(3);
  });

  it("does not warn that the call ran uncached", async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const { cached } = counted("test#940:loaderCtxNoWarn");
      await inLoader(product("1"), (ctx) => cached(ctx));
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(
      consoleWarn.mock.calls.some((args) =>
        String(args[0]).includes("test#940:loaderCtxNoWarn"),
      ),
    ).toBe(false);
  });
});

describe('"use cache": a middleware ctx argument keys by route (#940)', () => {
  it("hits on the same URL, misses on another path, search or host", async () => {
    const { cached, calls } = counted("test#940:middlewareCtx");
    const call = (url: string) => inMiddleware({ url }, (ctx) => cached(ctx));

    expect(await call("https://shop.example/a?x=1")).toBe(1);
    expect(await call("https://shop.example/a?x=1")).toBe(1);
    expect(await call("https://shop.example/b?x=1")).toBe(2);
    expect(await call("https://shop.example/a?x=2")).toBe(3);
    expect(await call("https://other.example/a?x=1")).toBe(4);
    expect(calls()).toBe(4);
  });

  it("folds in the matched route name and params", async () => {
    const { cached } = counted("test#940:middlewareCtxRoute");
    const call = (route: Route) => inMiddleware(route, (ctx) => cached(ctx));

    expect(await call(product("1"))).toBe(1);
    expect(await call(product("1"))).toBe(1);
    expect(await call({ ...product("1"), routeName: "productAlt" })).toBe(2);
    expect(await call({ ...product("1"), params: { id: "x" } })).toBe(3);
  });
});

describe('"use cache": a handler ctx argument is unchanged (#940)', () => {
  it("hits on the same route and params, misses on other params or search", async () => {
    const { cached, calls } = counted("test#940:handlerCtx");
    const call = (route: Route) =>
      inRequest(route, async (reqCtx) => cached(handlerCtx(reqCtx, route)));

    expect(await call(product("1"))).toBe(1);
    expect(await call(product("1"))).toBe(1);
    expect(await call(product("2"))).toBe(2);
    expect(await call(product("1", "?sort=asc"))).toBe(3);
    expect(calls()).toBe(3);
  });
});

describe('"use cache": middleware ctx side effects throw inside the function (#940)', () => {
  const INSIDE_USE_CACHE = /cannot be called inside a "use cache" function/;
  const FLAG = "flag" as any;

  it("ctx.set()", async () => {
    const setFlag = registerCachedFunction(
      async (ctx: MiddlewareContext<any>) => {
        ctx.set(FLAG, "on");
        return "set";
      },
      "test#940:mwSet",
      "default",
    );
    await expect(
      inMiddleware(product("1"), (ctx) => setFlag(ctx)),
    ).rejects.toThrow(INSIDE_USE_CACHE);
  });

  it("ctx.header() before and after next()", async () => {
    const setHeader = registerCachedFunction(
      async (ctx: MiddlewareContext<any>) => {
        ctx.header("x-flag", "on");
        return "header";
      },
      "test#940:mwHeader",
      "default",
    );
    await expect(
      inMiddleware(product("1"), (ctx) => setHeader(ctx)),
    ).rejects.toThrow(INSIDE_USE_CACHE);

    const after = await inRequest(product("2"), async (reqCtx) => {
      let thrown: unknown;
      await executeLoaderMiddleware(
        [
          async (ctx, next) => {
            await next();
            thrown = await setHeader(ctx).catch((e: unknown) => e);
          },
        ],
        reqCtx.request,
        reqCtx.env,
        {},
        reqCtx._variables,
        async () => new Response(null),
      );
      return thrown;
    });
    expect(String(after)).toMatch(INSIDE_USE_CACHE);
  });

  it("ctx.headers mutations", async () => {
    const mutate = registerCachedFunction(
      async (ctx: MiddlewareContext<any>) => {
        ctx.headers.set("x-flag", "on");
        return "headers";
      },
      "test#940:mwHeaders",
      "default",
    );
    await expect(
      inMiddleware(product("1"), (ctx) => mutate(ctx)),
    ).rejects.toThrow(INSIDE_USE_CACHE);
  });

  it("ctx.headers writes throw in a cached body that did not stamp the ctx (stale refresh), like a handler ctx", async () => {
    const thrown = await inRequest(product("1"), async (reqCtx) => {
      const hctx = handlerCtx(reqCtx, product("1"));
      let mwCtx!: MiddlewareContext<any>;
      await executeLoaderMiddleware(
        [
          async (ctx, next) => {
            mwCtx = ctx;
            return next();
          },
        ],
        reqCtx.request,
        reqCtx.env,
        {},
        reqCtx._variables,
        async () => new Response(null),
      );
      const attempt = (headers: () => Headers) => {
        try {
          headers().set("x-flag", "on");
          return "wrote";
        } catch (error) {
          return String(error);
        }
      };
      return runWithCacheExecScope(() => [
        attempt(() => hctx.headers),
        attempt(() => mwCtx.headers),
      ]);
    });
    expect(thrown[0]).toMatch(INSIDE_USE_CACHE);
    expect(thrown[1]).toMatch(INSIDE_USE_CACHE);
  });

  it("reads and writes outside the function are unaffected", async () => {
    const read = registerCachedFunction(
      async (ctx: MiddlewareContext<any>) => ctx.headers.get("x-flag"),
      "test#940:mwRead",
      "default",
    );
    const result = await inMiddleware(product("1"), async (ctx) => {
      ctx.headers.set("x-flag", "before");
      const seen = await read(ctx);
      ctx.set(FLAG, "after");
      ctx.header("x-flag", "after");
      return [seen, ctx.get(FLAG), ctx.headers.get("x-flag")];
    });
    expect(result).toEqual(["before", "after", "after"]);
  });
});
