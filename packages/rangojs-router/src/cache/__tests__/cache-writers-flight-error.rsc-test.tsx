/**
 * "use cache", a loader's own cache() and cached handle values are not written
 * when their Flight encode reports an error (issue #913; a route's segments
 * are #909's cache-route-flight-error.rsc-test.tsx).
 *
 * Flight never rejects for a value it cannot encode: an async server component
 * that throws, a rejected promise inside the value or a handle push, a
 * function. It calls onError and completes normally with an error row
 * (`N:E{...}`); storing that entry would bake the error into every hit. Runs
 * the full router with real Flight (the vendored react-server-dom), since the
 * JSON codec stand-in the other cache tests use never renders or rejects.
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
    // Every "use cache" call below keys on JSON-safe args (the fast path).
    createClientTemporaryReferenceSet: () => new Set(),
    encodeReply: async () => {
      throw new Error("encodeReply is not expected in this test");
    },
  };
});

import { createRouter } from "../../router.js";
import { createLoader } from "../../loader.rsc.js";
import { createHandle } from "../../handle.js";
import { buildRouterTrieFromUrlpatterns } from "../../rsc/manifest-init.js";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { registerCachedFunction } from "../cache-runtime.js";
import { serializeResult } from "../segment-codec.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../server/request-context.js";

const Crumbs = createHandle<unknown>(undefined, "test#FlightErrorCrumbs");

let fail = false;
const calls = { useCache: 0, loader: 0 };

async function Reviews() {
  await Promise.resolve();
  if (fail) throw new Error("reviews upstream down");
  return <p>reviews</p>;
}

/** A settled rejection with a handler attached, so only Flight observes it. */
function rejected(message: string): Promise<never> {
  const promise = Promise.reject(new Error(message));
  promise.catch(() => {});
  return promise;
}

const productView = registerCachedFunction(
  async () => {
    calls.useCache++;
    return (
      <div>
        product
        <Reviews />
      </div>
    );
  },
  "test#productView",
  "default",
);

const crumbed = registerCachedFunction(
  async (ctx: any) => {
    ctx.use(Crumbs)(fail ? rejected("crumb upstream down") : "use-cache");
    return "crumbed";
  },
  "test#crumbed",
  "default",
);

const ReviewsLoader = (createLoader as Function)(
  async () => {
    calls.loader++;
    return {
      product: "p1",
      reviews: fail ? rejected("reviews upstream down") : ["great"],
    };
  },
  undefined,
  "test#FlightErrorReviewsLoader",
);

const CrumbLoader = (createLoader as Function)(
  async (ctx: any) => {
    ctx.use(Crumbs)(fail ? rejected("crumb upstream down") : "loader");
    return "crumbed";
  },
  undefined,
  "test#FlightErrorCrumbLoader",
);

type Write = { key: string; errorRows: string[] };

let router: any;
let store: MemorySegmentCacheStore;
let getItemRaw: MemorySegmentCacheStore["getItem"];
let writes: Write[] = [];
let reports: string[] = [];
let serveStale = false;
let consoleError: MockInstance<typeof console.error>;

function errorRows(encoded: string | undefined): string[] {
  return encoded?.match(/^\d+:E.*$/gm) ?? [];
}

beforeAll(async () => {
  store = new MemorySegmentCacheStore();
  getItemRaw = store.getItem.bind(store);
  store.getItem = async (key: string) => {
    const hit = await getItemRaw(key);
    return hit && serveStale ? { ...hit, shouldRevalidate: true } : hit;
  };
  const setItem = store.setItem.bind(store);
  store.setItem = async (key, value, options) => {
    writes.push({
      key,
      errorRows: [...errorRows(value), ...errorRows(options?.handles)],
    });
    return setItem(key, value, options);
  };
  const set = store.set.bind(store);
  store.set = async (key, data, ...rest) => {
    writes.push({
      key,
      errorRows: [
        ...data.segments.flatMap((s) => errorRows(s.encoded)),
        ...errorRows(data.handles),
      ],
    });
    return set(key, data, ...rest);
  };

  router = createRouter({} as any);
  router.routes(({ path, cache, loader }: any) => [
    path("/use-cache", async () => <div>{await productView()}</div>, {
      name: "useCacheValue",
    }),
    path(
      "/use-cache-handle",
      async (ctx: any) => <div>{await crumbed(ctx)}</div>,
      { name: "useCacheHandle" },
    ),
    path(
      "/loader",
      () => <div>loader</div>,
      { name: "loaderValue" },
      () => [loader(ReviewsLoader, () => [cache({ ttl: 60, swr: 60, store })])],
    ),
    path(
      "/loader-handle",
      () => <div>loader</div>,
      { name: "loaderHandle" },
      () => [loader(CrumbLoader, () => [cache({ ttl: 60, store })])],
    ),
    cache({ ttl: 60, store }, () => [
      path(
        "/route-handle",
        (ctx: any) => {
          ctx.use(Crumbs)(fail ? rejected("crumb upstream down") : "route");
          return <div>route</div>;
        },
        { name: "routeHandle" },
      ),
    ]),
  ]);
  await buildRouterTrieFromUrlpatterns(router);
});

beforeEach(async () => {
  await store.clear();
  writes = [];
  reports = [];
  fail = false;
  serveStale = false;
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

/** One request, its deferred cache writes flushed. Returns its writes. */
async function serve(pathname: string): Promise<Write[]> {
  const request = new Request(`https://example.com${pathname}`, {
    headers: { accept: "text/html" },
  });
  const reqCtx = createRequestContext({
    env: {},
    request,
    url: new URL(request.url),
    variables: {},
  } as any) as RequestContext<any>;
  (reqCtx as any)._cacheStore = store;
  (reqCtx as any)._cacheProfiles = { default: { ttl: 60, swr: 60 } };
  (reqCtx as any)._reportBackgroundError = (error: unknown, category: string) =>
    reports.push(`${category}: ${(error as Error).message}`);
  const writesBefore = writes.length;
  await runWithRequestContext(reqCtx, async () => {
    await router.match(request, { env: {} });
    for (const cb of reqCtx._onResponseCallbacks.splice(0)) {
      cb(new Response(null, { status: reqCtx.res.status }));
    }
    reqCtx._handleStore.seal();
    await reqCtx._handleStore.fullySettled;
    const tasks = reqCtx._pendingBackgroundTasks!;
    for (let i = 0; i < tasks.length; i++) await tasks[i];
  });
  return writes.slice(writesBefore);
}

async function storedValue(key: string): Promise<string | undefined> {
  return (await getItemRaw(key))?.value;
}

describe("serializeResult onError (real Flight)", () => {
  it("reports a value that fails to encode", async () => {
    const errors: unknown[] = [];
    await serializeResult(
      { reviews: rejected("reviews upstream down") },
      (e) => {
        errors.push(e);
      },
    );
    expect(errors.map((e) => (e as Error).message)).toEqual([
      "reviews upstream down",
    ]);
  });

  it("without onError (prerender) still encodes the error row and resolves", async () => {
    const encoded = await serializeResult({
      reviews: rejected("reviews upstream down"),
    });
    expect(errorRows(encoded ?? undefined)).toEqual(['1:E{"digest":""}']);
  });
});

describe('"use cache": a result whose encode reports an error is not written', () => {
  it("MISS: nothing is written; the next call re-runs the function", async () => {
    fail = true;
    expect(await serve("/use-cache")).toEqual([]);
    expect(reports).toEqual(["cache-write: reviews upstream down"]);

    fail = false;
    const callsBefore = calls.useCache;
    // Control: the same lane writes once the component renders.
    expect(await serve("/use-cache")).toEqual([
      { key: "use-cache:test#productView", errorRows: [] },
    ]);
    expect(calls.useCache).toBe(callsBefore + 1);
  });

  it("stale-hit refresh: nothing is written; the stale entry keeps serving", async () => {
    const [first] = await serve("/use-cache");
    const before = await storedValue(first.key);
    expect(before).toBeDefined();

    serveStale = true;
    fail = true;
    const callsBefore = calls.useCache;
    expect(await serve("/use-cache")).toEqual([]);
    // The background revalidation re-ran the function.
    expect(calls.useCache).toBe(callsBefore + 1);
    expect(reports).toEqual(["stale-revalidation: reviews upstream down"]);
    expect(await storedValue(first.key)).toBe(before);
  });

  it("a handle push whose value fails to encode: nothing is written", async () => {
    fail = true;
    expect(await serve("/use-cache-handle")).toEqual([]);
    expect(reports).toEqual(["cache-write: crumb upstream down"]);

    fail = false;
    expect(await serve("/use-cache-handle")).toMatchObject([{ errorRows: [] }]);
  });
});

describe("a loader's own cache(): a value whose encode reports an error is not written", () => {
  it("MISS: nothing is written; the next request re-runs the loader", async () => {
    fail = true;
    expect(await serve("/loader")).toEqual([]);
    expect(reports).toEqual(["cache-write: reviews upstream down"]);

    fail = false;
    const callsBefore = calls.loader;
    expect(await serve("/loader")).toEqual([
      {
        key: "loader:test#FlightErrorReviewsLoader:example.com/loader",
        errorRows: [],
      },
    ]);
    expect(calls.loader).toBe(callsBefore + 1);
  });

  it("stale-hit refresh: nothing is written; the stale entry keeps serving", async () => {
    const [first] = await serve("/loader");
    const before = await storedValue(first.key);
    expect(before).toBeDefined();

    serveStale = true;
    fail = true;
    const callsBefore = calls.loader;
    expect(await serve("/loader")).toEqual([]);
    expect(calls.loader).toBe(callsBefore + 1);
    expect(reports).toEqual(["stale-revalidation: reviews upstream down"]);
    expect(await storedValue(first.key)).toBe(before);
  });

  it("a handle push whose value fails to encode: nothing is written", async () => {
    fail = true;
    expect(await serve("/loader-handle")).toEqual([]);
    expect(reports).toEqual(["cache-write: crumb upstream down"]);

    fail = false;
    expect(await serve("/loader-handle")).toEqual([
      {
        key: "loader:test#FlightErrorCrumbLoader:example.com/loader-handle",
        errorRows: [],
      },
    ]);
  });
});

describe("route cache(): a handle push whose value fails to encode", () => {
  it("nothing is written", async () => {
    fail = true;
    expect(await serve("/route-handle")).toEqual([]);
    expect(reports).toEqual(["cache-write: crumb upstream down"]);

    fail = false;
    expect(await serve("/route-handle")).toEqual([
      { key: "doc:example.com/route-handle", errorRows: [] },
    ]);
  });
});
