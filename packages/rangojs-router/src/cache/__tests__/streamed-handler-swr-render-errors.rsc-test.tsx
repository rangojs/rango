/**
 * The stale refresh of a cache() scope renders under its own context
 * (rerenderAndCacheRoute). A streamed handler there that recovers into its
 * declared boundary must record the failure on that render only: the
 * foreground request already served its stale record, so a failure pushed on
 * its `_renderErrors` would refuse the document cache write of a healthy page
 * and fail a prerender warm. The refresh itself still refuses its record.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

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
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

let calls = 0;
let serveStale = false;
let router: any;
let store: MemorySegmentCacheStore;
const written: string[] = [];

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const hit = await get(key);
    return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
  };
  const set = store.set.bind(store);
  store.set = async (key, data, ...rest) => {
    written.push(data.segments.map((s) => s.encoded).join(""));
    return set(key, data, ...rest);
  };
  router = createRouter({} as any);
  router.routes(
    ({ layout, parallel, path, cache, loading, errorBoundary }: any) => [
      layout(
        () => <main>shell</main>,
        () => [
          errorBoundary(<p>layout-fallback</p>),
          // Fails on every run, outside the cache scope: the foreground recovers
          // it, so its map exists before the refresh derives its context.
          parallel(
            {
              "@side": async () => {
                throw new Error("slot down");
              },
            },
            () => [loading(<p>side-loading</p>)],
          ),
          cache({ ttl: 60, store }, () => [
            path(
              "/stock",
              async () => {
                calls++;
                await new Promise((resolve) => setTimeout(resolve, 5));
                if (calls > 1) throw new Error("upstream down");
                return <p>healthy-content</p>;
              },
              { name: "stock" },
              () => [
                loading(<p>loading</p>),
                errorBoundary(<p>declared-error</p>),
              ],
            ),
          ]),
        ],
      ),
    ],
  );
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  written.length = 0;
  calls = 0;
  serveStale = false;
});

const messages = (ctx: RequestContext<any>): string[] =>
  (ctx._renderErrors ?? []).map((e) => (e as Error).message);

async function serve(): Promise<RequestContext<any>> {
  const request = new Request("https://example.com/stock", {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: store,
  } as any) as RequestContext<any>;
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: reqCtx.res.status }));
    }
    reqCtx._handleStore.seal();
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return reqCtx;
}

describe("a stale refresh whose streamed handler recovers into its boundary", () => {
  it("does not mark the foreground render failed, and refuses its own record", async () => {
    const first = await serve();
    expect(calls).toBe(1);
    expect(written).toHaveLength(1);
    expect(messages(first)).toEqual(["slot down"]);

    serveStale = true;
    const second = await serve();
    serveStale = false;

    expect(calls).toBe(2);
    expect(messages(second)).toEqual(["slot down"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("healthy-content");
  });
});

describe("a stale refresh records its recovery on its own map", () => {
  it("the foreground map keeps only the foreground's segment ids", async () => {
    await serve();
    serveStale = true;
    const second = await serve();
    serveStale = false;

    expect(calls).toBe(2);
    const ids = [...(second._recoveredHandlerErrors?.keys() ?? [])];
    expect(ids).toHaveLength(1);
    expect(ids[0]).toContain("@side");
    // The refresh's own failure refused its record through its own map.
    expect(written).toHaveLength(1);
  });
});
