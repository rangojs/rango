/**
 * A route cache() record whose render started before another request
 * invalidated one of its tags is not written (issue #977). The store stamps
 * the record when it is written, so a record rendered from data read before
 * the invalidation would be served as newer than it until ttl+swr. Covers
 * the MISS write (withCacheStore -> cacheRoute) and the stale refresh
 * (rerenderAndCacheRoute), with the tag recorded by the handler's content
 * (the record's tags, #957). Runs the full router with real Flight.
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
import { cacheTag } from "../cache-tag.js";
import { updateTag } from "../tag-invalidation.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

let source = "old";
let gate: Promise<void> = Promise.resolve();
let handlerCalls = 0;
let serveStale = false;
let router: any;
let store: MemorySegmentCacheStore;
const written: string[] = [];
const stamps: (number | undefined)[] = [];

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
    stamps.push(data.taggedAt);
    return set(key, data, ...rest);
  };
  router = createRouter({} as any);
  router.routes(({ path, cache }: any) => [
    cache({ ttl: 60, store }, () => [
      path(
        "/stock",
        async () => {
          handlerCalls++;
          cacheTag("route-stock");
          const value = source;
          await gate;
          return <p>{`stock:${value}`}</p>;
        },
        { name: "stock" },
      ),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  written.length = 0;
  stamps.length = 0;
  source = "old";
  gate = Promise.resolve();
  handlerCalls = 0;
  serveStale = false;
});

function context(request: Request): RequestContext<any> {
  return createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
    cacheStore: store,
  } as any) as RequestContext<any>;
}

/**
 * One document request, its record write included. `delayMs` passes between
 * the request's creation and the match.
 */
async function serve(delayMs = 0): Promise<void> {
  const request = new Request("https://example.com/stock", {
    headers: { accept: "text/html" },
  });
  const reqCtx = context(request);
  await runWithRequestContext(reqCtx, async () => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await router.match(request, { env: {} });
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: reqCtx.res.status }));
    }
    reqCtx._handleStore.seal();
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
}

/** Another request's updateTag(). */
async function invalidate(tag: string): Promise<void> {
  const reqCtx = context(new Request("https://example.com/action"));
  await runWithRequestContext(reqCtx, () => updateTag(tag));
}

function hold(): () => void {
  let release!: () => void;
  gate = new Promise<void>((resolve) => (release = resolve));
  return release;
}

describe("a route cache() record rendered before another request's updateTag() (#977)", () => {
  it("MISS: the record is not written; the next request renders the new data", async () => {
    const release = hold();
    const first = serve();
    await vi.waitFor(() => expect(handlerCalls).toBe(1));
    source = "new";
    await invalidate("route-stock");
    release();
    await first;

    expect(written).toEqual([]);
    await serve();
    expect(handlerCalls).toBe(2);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("stock:new");
  });

  it("a stale refresh started before the invalidation is not written", async () => {
    await serve();
    expect(written).toHaveLength(1);

    serveStale = true;
    const release = hold();
    const stale = serve();
    // The HIT served the record; its background refresh runs the handler.
    await vi.waitFor(() => expect(handlerCalls).toBe(2));
    source = "new";
    await invalidate("route-stock");
    release();
    await stale;
    serveStale = false;

    expect(written).toHaveLength(1);
    await serve();
    expect(handlerCalls).toBe(3);
    expect(written.at(-1)).toContain("stock:new");
  });

  it("a render that started after the invalidation is written", async () => {
    await invalidate("route-stock");
    await serve();
    expect(written).toHaveLength(1);
    await serve();
    expect(handlerCalls).toBe(1);
  });

  // #1068: the record's stamp is the render's start, not the write's, so the
  // store's read-side marker check rejects a record an invalidation landed
  // under.
  it("MISS: the record is stamped with the start of its render", async () => {
    const before = Date.now();
    const release = hold();
    const first = serve();
    await vi.waitFor(() => expect(handlerCalls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heldUntil = Date.now();
    release();
    await first;

    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toBeGreaterThanOrEqual(before);
    expect(stamps[0]).toBeLessThan(heldUntil - 20);
  });

  // The request is created 30 ms before the match: a stamp taken from the
  // request, not from the refresh, would be 30 ms older.
  it("a stale refresh is stamped with its own start, not its request's", async () => {
    await serve();
    serveStale = true;
    const requestAt = Date.now();
    await serve(30);
    serveStale = false;

    expect(stamps).toHaveLength(2);
    expect(stamps[1]!).toBeGreaterThanOrEqual(requestAt + 25);
  });
});
