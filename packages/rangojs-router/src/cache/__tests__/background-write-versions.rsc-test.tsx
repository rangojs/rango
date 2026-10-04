/**
 * A cache write deferred with `ctx.waitUntil()` is keyed with the versions of
 * the router that served the request (docs/design/per-app-cache-version.md).
 *
 * The store builds its key inside the deferred task, from the request context.
 * Node and miniflare always carry the request's async context into that task
 * (deployed workerd lost it once, in "use cache" revalidation), so a loss is
 * produced here by scheduling each task from an async scope created outside
 * any request. Covers the two writes a
 * request defers: a route's segment record (withCacheStore -> cacheRoute) and
 * a document-cache MISS (createDocumentCacheMiddleware).
 */
import { AsyncResource } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  const clientManifest = new Proxy(
    {},
    {
      get: (_target, key) =>
        typeof key === "string"
          ? { id: key.split("#")[0], chunks: [], name: key.split("#")[1] }
          : undefined,
    },
  );
  return {
    createTemporaryReferenceSet: () => new WeakMap(),
    renderToReadableStream: (value: unknown, options?: object) =>
      RSD.renderToReadableStream(value, clientManifest, options),
  };
});
vi.mock("@vitejs/plugin-rsc/rsc/client", async () => {
  await import("../../testing/internal/flight-client-globals.js");
  const { createFromReadableStream } =
    await import("@vitejs/plugin-rsc/react/browser");
  return {
    createFromReadableStream: (stream: ReadableStream<Uint8Array>) =>
      createFromReadableStream(stream),
  };
});

import { createRouter } from "../../router.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { createDocumentCacheMiddleware } from "../document-cache.js";
import {
  VercelCacheStore,
  type VercelRuntimeCache,
} from "../vercel/vercel-cache-store.js";
import type { MiddlewareContext } from "../../router/middleware.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { installRouterVersionsTable } from "../../server/build-version-table.js";

/** An async scope with no request in it, as a detached task has on the edge. */
const outsideAnyRequest = new AsyncResource("detached-wait-until");

function makeStore(): { store: VercelCacheStore; keys: () => string[] } {
  const values = new Map<string, unknown>();
  const cache: VercelRuntimeCache = {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
  return {
    store: new VercelCacheStore({ cache }),
    keys: () => [...values.keys()].filter((key) => !key.endsWith(":lock")),
  };
}

/** A request served by router A, whose deferred tasks start detached. */
function requestOfRouterA(
  request: Request,
  store: VercelCacheStore,
): RequestContext<any> {
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: store,
    versions: { data: "data-a", document: "doc-a" },
  } as any) as RequestContext<any>;
  const schedule = reqCtx.waitUntil;
  reqCtx.waitUntil = (fn) =>
    outsideAnyRequest.runInAsyncScope(() => schedule.call(reqCtx, fn));
  return reqCtx;
}

async function settle(reqCtx: RequestContext<any>): Promise<void> {
  const tasks = reqCtx._pendingBackgroundTasks!;
  for (let i = 0; i < tasks.length; i++) await tasks[i];
}

beforeAll(() => {
  // A build with more than one router: a write that lost its request would
  // be keyed with the whole-build pair, which router A never reads.
  installRouterVersionsTable({
    "*": ["data-whole", "doc-whole"],
    "router-a": ["data-a", "doc-a"],
    "router-b": ["data-b", "doc-b"],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(() => {
  installRouterVersionsTable(undefined);
  vi.restoreAllMocks();
});

describe("a cache write deferred with waitUntil, run outside the request's async context", () => {
  it("keys a route's segment record with the serving router's data version", async () => {
    const { store, keys } = makeStore();
    const router: any = createRouter({} as any);
    router.routes(({ path, cache }: any) => [
      cache({ ttl: 60, store }, () => [
        path("/stock", () => <p>stock</p>, { name: "stock" }),
      ]),
    ]);
    await buildRouterTrieFromUrlpatterns(router);

    const request = new Request("https://example.com/stock", {
      headers: { accept: "text/html" },
    });
    const reqCtx = requestOfRouterA(request, store);
    await runWithRequestContext(reqCtx, async () => {
      await router.match(request, { env: {} });
      for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
        cb(new Response(null, { status: reqCtx.res.status }));
      }
      reqCtx._handleStore.seal();
    });
    await settle(reqCtx);

    expect(keys().map((key) => key.split("rg:")[0])).toEqual(["v/data-a/"]);
  });

  it("keys a document-cache MISS with the serving router's document version", async () => {
    const { store, keys } = makeStore();
    const url = new URL("https://example.com/doc");
    const request = new Request(url, { headers: { accept: "text/html" } });
    const reqCtx = requestOfRouterA(request, store);
    const middleware = createDocumentCacheMiddleware();
    const middlewareCtx = {
      request,
      url,
      env: {},
      var: {},
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as MiddlewareContext<any>;

    const status = await runWithRequestContext(reqCtx, async () => {
      const response = await middleware(
        middlewareCtx,
        async () =>
          new Response("doc", { headers: { "Cache-Control": "s-maxage=60" } }),
      );
      await response!.text();
      return response!.headers.get("x-document-cache-status");
    });
    await settle(reqCtx);

    expect(status).toBe("MISS");
    expect(keys().map((key) => key.split("rg:")[0])).toEqual(["v/doc-a/"]);
  });
});
