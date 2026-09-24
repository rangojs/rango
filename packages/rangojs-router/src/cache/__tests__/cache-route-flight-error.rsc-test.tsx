/**
 * A cache() route whose handler resolves but whose tree holds an async server
 * component that throws is not written to the route cache (issue #909).
 *
 * The handler returns an element, so no status is set and withCacheStore's
 * `response.status !== 200` gate passes. cacheRoute's serializeSegments
 * re-renders the tree through Flight, which reports the throw via onError and
 * completes normally with an error row (`1:E{"digest":""}`); storing that
 * entry would serve the error on every HIT. Runs the full router with real
 * Flight (the vendored react-server-dom), since the JSON codec stand-in the
 * other cache-store tests use never renders components.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

vi.mock("@vitejs/plugin-rsc/rsc/server", async () => {
  const RSD =
    await import("@vitejs/plugin-rsc/vendor/react-server-dom/server.edge");
  // Resolves any "use client" reference (the router's implicit layouts render
  // the client Outlet): `$$id` is `${id}#${name}`.
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
    // The vendored implementation (not in its ambient declaration).
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
import { serializeSegments } from "../segment-codec.js";
import type { ResolvedSegment } from "../../types.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

let failReviews = false;
let handlerCalls = 0;

async function Reviews() {
  await Promise.resolve();
  if (failReviews) throw new Error("reviews upstream down");
  return <p>reviews</p>;
}

let router: any;
let store: MemorySegmentCacheStore;
let writes: Array<{ key: string; errorRows: string[] }> = [];
let serveStale = false;
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  const get = store.get.bind(store);
  store.get = async (key: string) => {
    const hit = await get(key);
    return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
  };
  const set = store.set.bind(store);
  store.set = async (key, data, ...rest) => {
    writes.push({ key, errorRows: errorRows(data.segments) });
    return set(key, data, ...rest);
  };
  router = createRouter({} as any);
  router.routes(({ path, cache, layout }: any) => [
    cache({ ttl: 60, store }, () => [
      layout(<div>shell</div>, () => [
        path(
          "/product",
          () => {
            handlerCalls++;
            return (
              <div>
                product
                <Reviews />
              </div>
            );
          },
          { name: "product" },
        ),
      ]),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes = [];
  failReviews = false;
  serveStale = false;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

async function serve(pathname: string): Promise<typeof writes> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  const writesBefore = writes.length;
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: reqCtx.res.status }));
    }
    reqCtx._handleStore.seal();
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return writes.slice(writesBefore);
}

function errorRows(segments: Array<{ encoded: string }>): string[] {
  return segments.flatMap((s) => s.encoded.match(/^\d+:E.*$/gm) ?? []);
}

async function storedEncoded(key: string): Promise<string[] | undefined> {
  const hit = await store.get(key);
  return hit?.data.segments.map((s) => s.encoded);
}

function failedWriteLogs(): string[] {
  return consoleError.mock.calls
    .filter((args) => String(args[0]).includes("[CacheScope] Failed to cache"))
    .map((args) => (args[1] as Error).message);
}

describe("serializeSegments onError (real Flight)", () => {
  const segment = {
    id: "s",
    namespace: "t",
    type: "route",
    index: 0,
    params: {},
    component: (
      <div>
        <Reviews />
      </div>
    ),
  } as ResolvedSegment;

  it("reports a component that throws during encoding", async () => {
    failReviews = true;
    const errors: unknown[] = [];
    await serializeSegments([segment], (error) => {
      errors.push(error);
    });
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "reviews upstream down",
    ]);
  });

  it("without onError (prerender) still encodes the error row and resolves", async () => {
    failReviews = true;
    const [serialized] = await serializeSegments([segment]);
    expect(errorRows([serialized])).toEqual(['1:E{"digest":""}']);
  });
});

describe("a cache() route whose async child component throws is not written", () => {
  it("MISS: nothing is written; the next request is a MISS", async () => {
    failReviews = true;
    expect(await serve("/product")).toEqual([]);
    expect(failedWriteLogs()).toEqual(["reviews upstream down"]);

    failReviews = false;
    const callsBefore = handlerCalls;
    const next = await serve("/product");
    expect(handlerCalls).toBe(callsBefore + 1);
    // Control: the same lane writes once the component renders.
    expect(next).toEqual([{ key: "doc:example.com/product", errorRows: [] }]);
  });

  it("stale-hit refresh: nothing is written; the stale entry keeps serving", async () => {
    const [first] = await serve("/product");
    const before = await storedEncoded(first.key);
    expect(before).toBeDefined();

    serveStale = true;
    failReviews = true;
    const callsBefore = handlerCalls;
    expect(await serve("/product")).toEqual([]);
    // The background revalidation re-ran the handler.
    expect(handlerCalls).toBe(callsBefore + 1);
    expect(failedWriteLogs()).toEqual(["reviews upstream down"]);
    expect(await storedEncoded(first.key)).toEqual(before);
  });
});
