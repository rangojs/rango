/**
 * serveResponseRouteWithCache key resolution: a configured key() never falls
 * back to the broad default key (#970). The leaf must run inside
 * runWithRequestContext for its own `reqCtx`: the scope reads the ambient
 * context for key(), a store keyGenerator and condition(), so without it (or
 * with another request's) the route runs uncached rather than caching under
 * the default key.
 */
import { describe, expect, it, vi } from "vitest";
import { serveResponseRouteWithCache } from "../response-cache-serve.js";
import { createCacheScope } from "../../cache/cache-scope.js";
import { MemorySegmentCacheStore } from "../../cache/memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import type { EntryData } from "../../server/context.js";
import type { PartialCacheOptions } from "../../types.js";
import { createWarmRecord } from "../../prerender/warm-request.js";

function setup(
  options: PartialCacheOptions,
  store: MemorySegmentCacheStore = new MemorySegmentCacheStore(),
) {
  const getResponse = vi.spyOn(store, "getResponse");
  const putResponse = vi.spyOn(store, "putResponse");
  const url = new URL("http://localhost/api/data");
  const reqCtx = createRequestContext({
    env: {},
    request: new Request(url, { headers: { "x-locale": "de" } }),
    url,
    variables: {},
    cacheStore: store,
  });
  const manifestEntry = {
    type: "route",
    cache: { options },
    parent: null,
  } as unknown as EntryData;
  const executeHandler = vi.fn(async () => Response.json({ ok: true }));
  const serve = () =>
    serveResponseRouteWithCache({
      reqCtx,
      manifestEntry,
      responseType: "json",
      url,
      executeHandler,
      deps: { createCacheScope },
    });
  return { reqCtx, getResponse, putResponse, serve };
}

describe("serveResponseRouteWithCache: a configured key()", () => {
  it("with no ambient request context, runs the route uncached, never under the default key", async () => {
    const store = new MemorySegmentCacheStore();
    const getResponse = vi.spyOn(store, "getResponse");
    const putResponse = vi.spyOn(store, "putResponse");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const url = new URL("http://localhost/api/data");
    const reqCtx = createRequestContext({
      env: {},
      request: new Request(url),
      url,
      variables: {},
      cacheStore: store,
    });
    // A route under cache({ ttl }) nested in cache({ key }).
    const manifestEntry = {
      type: "route",
      cache: { options: { ttl: 60 } },
      parent: {
        type: "cache",
        parent: null,
        cache: { options: { ttl: 600, key: () => "tier:gold" } },
      },
    } as unknown as EntryData;
    const executeHandler = vi.fn(async () => Response.json({ ok: true }));

    const served = await serveResponseRouteWithCache({
      reqCtx,
      manifestEntry,
      responseType: "json",
      url,
      executeHandler,
      deps: { createCacheScope },
    });

    expect(served).toBeUndefined();
    expect(getResponse).not.toHaveBeenCalled();
    expect(putResponse).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("serveResponseRouteWithCache: outside its own request context", () => {
  const byLocale = (ctx: RequestContext, defaultKey: string) =>
    `${defaultKey}|${ctx.request.headers.get("x-locale")}`;

  it("a store keyGenerator with no ambient context: uncached, never under the default key", async () => {
    const { getResponse, putResponse, serve } = setup(
      { ttl: 60 },
      new MemorySegmentCacheStore({ keyGenerator: byLocale }),
    );

    expect(await serve()).toBeUndefined();
    expect(getResponse).not.toHaveBeenCalled();
    expect(putResponse).not.toHaveBeenCalled();
  });

  it("a condition() with no ambient context: uncached, and it does not throw", async () => {
    const condition = vi.fn(() => true);
    const { getResponse, putResponse, serve } = setup({ ttl: 60, condition });

    await expect(serve()).resolves.toBeUndefined();
    expect(getResponse).not.toHaveBeenCalled();
    expect(putResponse).not.toHaveBeenCalled();
  });

  it("another request's context is not its own: uncached", async () => {
    const { getResponse, putResponse, serve } = setup(
      { ttl: 60 },
      new MemorySegmentCacheStore({ keyGenerator: byLocale }),
    );
    const other = createRequestContext({
      env: {},
      request: new Request("http://localhost/other"),
      url: new URL("http://localhost/other"),
      variables: {},
    });

    expect(await runWithRequestContext(other, serve)).toBeUndefined();
    expect(getResponse).not.toHaveBeenCalled();
    expect(putResponse).not.toHaveBeenCalled();
  });

  it("inside its own context, the keyGenerator partitions the entry as before", async () => {
    const { reqCtx, putResponse, serve } = setup(
      { ttl: 60 },
      new MemorySegmentCacheStore({ keyGenerator: byLocale }),
    );
    reqCtx.waitUntil = (fn) => {
      void fn();
    };

    const served = await runWithRequestContext(reqCtx, serve);
    expect(served?.status).toBe(200);
    await vi.waitFor(() =>
      expect(putResponse.mock.calls.map(([key]) => key)).toEqual([
        "response:json:localhost/api/data|de",
      ]),
    );
  });
});

describe("serveResponseRouteWithCache: router.prerender() warm", () => {
  function harness(handler: () => Response = () => Response.json({ n: 1 })) {
    const store = new MemorySegmentCacheStore();
    const getResponse = vi.spyOn(store, "getResponse");
    const putResponse = vi.spyOn(store, "putResponse");
    const url = new URL("http://localhost/api/data");
    const manifestEntry = {
      type: "route",
      cache: { options: { ttl: 60 } },
      parent: null,
    } as unknown as EntryData;
    const executeHandler = vi.fn(async () => handler());

    async function serve(
      record?: ReturnType<typeof createWarmRecord>,
    ): Promise<Response | undefined> {
      const reqCtx = createRequestContext({
        env: {},
        request: new Request(url),
        url,
        variables: {},
        cacheStore: store,
      });
      reqCtx._prerenderWarm = record;
      const pending: Promise<void>[] = [];
      reqCtx.waitUntil = (fn) => {
        pending.push(fn());
      };
      const served = await runWithRequestContext(reqCtx, () =>
        serveResponseRouteWithCache({
          reqCtx,
          manifestEntry,
          responseType: "json",
          url,
          executeHandler,
          deps: { createCacheScope },
        }),
      );
      await Promise.all(pending);
      return served;
    }
    const warm = (mode: "replace" | "fill") =>
      createWarmRecord(mode, { store } as any);
    return { getResponse, putResponse, executeHandler, serve, warm };
  }

  it("replace mode does not read the store, runs the handler, and replaces the entry under the same key", async () => {
    const { getResponse, putResponse, executeHandler, serve, warm } = harness();
    await serve();
    const normalKey = putResponse.mock.calls[0][0];
    expect(executeHandler).toHaveBeenCalledTimes(1);
    getResponse.mockClear();

    const record = warm("replace");
    const served = await serve(record);

    expect(served?.status).toBe(200);
    expect(getResponse).not.toHaveBeenCalled();
    expect(executeHandler).toHaveBeenCalledTimes(2);
    expect(putResponse).toHaveBeenCalledTimes(2);
    expect(putResponse.mock.calls[1][0]).toBe(normalKey);
    expect(record.writes.response).toBe(1);
  });

  it("replace mode keeps canStore: a Set-Cookie response is not stored and counts no write", async () => {
    const { putResponse, executeHandler, serve, warm } = harness(
      () =>
        new Response("{}", {
          headers: { "content-type": "application/json", "set-cookie": "a=1" },
        }),
    );
    const record = warm("replace");

    await serve(record);

    expect(executeHandler).toHaveBeenCalledTimes(1);
    expect(putResponse).not.toHaveBeenCalled();
    expect(record.writes.response).toBe(0);
  });

  it("fill mode serves the cached response without running the handler", async () => {
    const { putResponse, executeHandler, serve, warm } = harness();
    await serve();
    expect(executeHandler).toHaveBeenCalledTimes(1);
    putResponse.mockClear();

    const record = warm("fill");
    const served = await serve(record);

    expect(await served?.json()).toEqual({ n: 1 });
    expect(executeHandler).toHaveBeenCalledTimes(1);
    expect(putResponse).not.toHaveBeenCalled();
    expect(record.writes.response).toBe(0);
  });
});
