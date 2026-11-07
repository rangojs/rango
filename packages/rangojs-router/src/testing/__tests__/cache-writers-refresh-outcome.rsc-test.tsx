/**
 * What a cache writer's stale refresh does with each answer it renders.
 *
 * - notFound() (a response route's 404): the record is gone, so the stored
 *   entry is retired. The next request runs the handler and the visitor gets
 *   the 404, not the deleted record's page until the SWR window ends.
 * - redirect(): stores nothing and retires nothing. A redirect can depend on
 *   the request (a session or auth check), so it does not show the page is
 *   gone: the stored entry keeps serving and revalidates on its own schedule.
 * - an error: not authoritative either; the stored entry keeps serving.
 *
 * Each writer is driven through the public primitives (serveShellRequest,
 * dispatch) on each built-in store: a healthy first request stores the entry,
 * the clock moves past its ttl, a stale request schedules the refresh that
 * answers the outcome, and the request after it shows what the store held.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { dispatch } from "../dispatch.js";
import {
  createLoader,
  createRouter,
  notFound,
  redirect,
  RouterError,
  urls,
} from "../../index.rsc.js";
import {
  CFCacheStore,
  MemorySegmentCacheStore,
  VercelCacheStore,
  createDocumentCacheMiddleware,
  type SegmentCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import {
  getRecord,
  record,
} from "./fixtures/cache-writers-refresh-outcome-data.js";

type Outcome = "page" | "notFound" | "redirect" | "error";

let outcome: Outcome = "page";
let runs = 0;
/** A redirect off the host: a navigation carries it in its Flight payload. */
let externalRedirect = false;

/** Throws the current outcome's signal, or returns. */
function answer(): void {
  runs += 1;
  if (outcome === "notFound") notFound("record deleted");
  if (outcome === "redirect") {
    throw externalRedirect
      ? redirect("https://example.com/elsewhere", { external: true })
      : redirect("/elsewhere");
  }
  if (outcome === "error") throw new Error("upstream down");
}

function Page(): React.ReactNode {
  answer();
  return <p>record-page</p>;
}

const RecordLoader = createLoader(async () => {
  answer();
  return { label: "record-loaded" };
});

function LoaderPage(): React.ReactNode {
  return <p>loader-page</p>;
}

function Elsewhere(): React.ReactNode {
  return <p>elsewhere</p>;
}

/** The same answer, awaited after the response starts (loading()). */
async function StreamedPage(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  answer();
  return <p>record-page</p>;
}

/** A layout handler gives the answer; its route only renders. */
function RecordLayout(): React.ReactNode {
  answer();
  return <p>record-page</p>;
}

function Plain(): React.ReactNode {
  return <p>plain</p>;
}

/** Where the answer comes from: the route's handler, streamed or not, or its layout's. */
type Shape = "route" | "streamed" | "layout";
const SHAPES: Shape[] = ["route", "streamed", "layout"];

/** The record's route at `pathname`, its answer given by `shape`. */
function recordRoute(
  helpers: any,
  pathname: string,
  shape: Shape,
  boundary: boolean,
) {
  const { path, layout, loading, notFoundBoundary } = helpers;
  const notFoundItems = boundary
    ? [notFoundBoundary(<p>declared-not-found</p>)]
    : [];
  if (shape === "layout") {
    return layout(RecordLayout, () => [
      ...notFoundItems,
      path(pathname, Plain, { name: "record" }),
    ]);
  }
  return path(
    pathname,
    shape === "streamed" ? StreamedPage : Page,
    { name: "record" },
    () => [
      ...notFoundItems,
      ...(shape === "streamed" ? [loading(<p>loading-fallback</p>)] : []),
    ],
  );
}

/** Date.now moves; timers stay real, so a stale entry needs no sleeping. */
function movableClock(): { advance(ms: number): void } {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  return { advance: (ms) => (offset += ms) };
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

function vercelCache(): VercelRuntimeCache {
  const values = new Map<string, unknown>();
  return {
    async get(key) {
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
}

/** A Workers edge cache double, as `caches.default`. */
function stubEdgeCache(): void {
  const entries = new Map<string, Response>();
  const edge = {
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
  vi.stubGlobal("caches", { default: edge, open: async () => edge });
}

/** A KV namespace double (string values). */
function kv() {
  const values = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

type StoreKind = "memory" | "vercel" | "cf";

function createStore(kind: StoreKind): SegmentCacheStore {
  if (kind === "memory") return new MemorySegmentCacheStore();
  if (kind === "vercel") return new VercelCacheStore({ cache: vercelCache() });
  stubEdgeCache();
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => {
      promise.catch(() => {});
    },
    passThroughOnException: () => {},
  };
  return new CFCacheStore({
    ctx: ctx as never,
    kv: kv() as never,
    memo: { shellMs: 0 },
  });
}

beforeEach(async () => {
  outcome = "page";
  runs = 0;
  externalRedirect = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const RETAINED: Outcome[] = ["redirect", "error"];
const ALL_STORES: StoreKind[] = ["memory", "vercel", "cf"];
/** The memory store's segment family has no SWR: its records never go stale. */
const SWR_SEGMENT_STORES: StoreKind[] = ["vercel", "cf"];

const STATUS = "x-document-cache-status";
const SERVED_FROM_STORE = ["HIT", "STALE"];

/**
 * A live render's status: 404, except a handler streaming behind loading(),
 * which answers after the 200 committed.
 */
function liveNotFoundStatus(shape: Shape): number {
  return shape === "streamed" ? 200 : 404;
}

describe.each(
  ALL_STORES.flatMap((kind) => SHAPES.map((shape) => [kind, shape] as const)),
)("document cache on the %s store, %s answer, stale refresh", (kind, shape) => {
  function createDocRouter() {
    return createRouter({})
      .use(createDocumentCacheMiddleware())
      .use("/doc", async (ctx, next) => {
        ctx.header("Cache-Control", "s-maxage=1, stale-while-revalidate=300");
        await next();
      })
      .routes(
        urls((helpers) => [
          recordRoute(helpers, "/doc", shape, false),
          helpers.path("/elsewhere", Elsewhere, { name: "elsewhere" }),
        ]),
      );
  }

  async function staleRefresh(
    to: Outcome,
    options: { partial?: { from: string } } = {},
  ) {
    const clock = movableClock();
    const cacheStore = createStore(kind);
    const router = createDocRouter();
    const serve = () =>
      serveShellRequest(router, "/doc", { cacheStore, ...options });
    const first = await serve();
    expect(first.response.headers.get(STATUS)).toBe("MISS");
    await settle();
    clock.advance(1_500);
    outcome = to;
    const stale = await serve();
    expect(stale.response.headers.get(STATUS)).toBe("STALE");
    await settle();
    runs = 0;
    const next = await serve();
    await settle();
    return { next, serve };
  }

  it("notFound(): the entry is retired and the next request renders the not-found live", async () => {
    const { next } = await staleRefresh("notFound");
    expect(SERVED_FROM_STORE).not.toContain(next.response.headers.get(STATUS));
    expect(next.response.status).toBe(liveNotFoundStatus(shape));
    expect(next.body).not.toContain("record-page");
    expect(runs).toBe(1);
  });

  it("notFound(), navigation: the entry is retired and the next navigation runs the handler", async () => {
    const { next } = await staleRefresh("notFound", {
      partial: { from: "/elsewhere" },
    });
    expect(SERVED_FROM_STORE).not.toContain(next.response.headers.get(STATUS));
    expect(next.flight).not.toContain("record-page");
    expect(runs).toBe(1);
  });

  it("a page that comes back after the retire is stored again", async () => {
    const { serve } = await staleRefresh("notFound");
    outcome = "page";
    const back = await serve();
    expect(back.response.headers.get(STATUS)).toBe("MISS");
    expect(back.response.status).toBe(200);
    await settle();
    const hit = await serve();
    expect(hit.response.headers.get(STATUS)).toBe("HIT");
    expect(hit.body).toContain("record-page");
  });

  it.each(RETAINED)("%s: the stored page keeps serving", async (to) => {
    const { next } = await staleRefresh(to);
    // STALE, or HIT on a store whose stale read claimed the refresh.
    expect(SERVED_FROM_STORE).toContain(next.response.headers.get(STATUS));
    expect(next.response.status).toBe(200);
    expect(next.body).toContain("record-page");
  });

  it.each(RETAINED)(
    "%s, navigation: the stored payload keeps serving",
    async (to) => {
      const { next } = await staleRefresh(to, {
        partial: { from: "/elsewhere" },
      });
      expect(SERVED_FROM_STORE).toContain(next.response.headers.get(STATUS));
      expect(next.flight).toContain("record-page");
    },
  );

  it("an external redirect on a navigation MISS is not stored", async () => {
    const cacheStore = createStore(kind);
    const router = createDocRouter();
    const partial = { from: "/elsewhere" };
    outcome = "redirect";
    externalRedirect = true;
    const first = await serveShellRequest(router, "/doc", {
      cacheStore,
      partial,
    });
    // A streamed handler's redirect rides its stream, a render error that
    // already keeps the response out of the store.
    if (shape !== "streamed") {
      expect(first.flight).toContain("https://example.com/elsewhere");
    }
    await settle();
    outcome = "page";
    const next = await serveShellRequest(router, "/doc", {
      cacheStore,
      partial,
    });
    expect(next.response.headers.get(STATUS)).toBe("MISS");
    expect(next.flight).toContain("record-page");
  });

  it("an external redirect, navigation: the stored payload keeps serving", async () => {
    externalRedirect = true;
    const { next } = await staleRefresh("redirect", {
      partial: { from: "/elsewhere" },
    });
    expect(SERVED_FROM_STORE).toContain(next.response.headers.get(STATUS));
    expect(next.flight).toContain("record-page");
  });
});

describe.each(
  SWR_SEGMENT_STORES.flatMap((kind) =>
    SHAPES.map((shape) => [kind, shape] as const),
  ),
)("route cache() on the %s store, %s answer, stale refresh", (kind, shape) => {
  async function staleRefresh(
    to: Outcome,
    options: { boundary?: boolean; partial?: { from: string } } = {},
  ) {
    const clock = movableClock();
    const cacheStore = createStore(kind);
    const router = createRouter({ cache: { store: cacheStore } }).routes(
      urls((helpers) => [
        helpers.cache({ ttl: 1, swr: 300 }, () => [
          recordRoute(helpers, "/rc", shape, options.boundary ?? false),
        ]),
        helpers.path("/elsewhere", Elsewhere, { name: "elsewhere" }),
      ]),
    );
    const serve = () =>
      serveShellRequest(router, "/rc", {
        cacheStore,
        ...(options.partial ? { partial: options.partial } : {}),
      });
    await serve();
    await settle();
    clock.advance(1_500);
    outcome = to;
    runs = 0;
    const stale = await serve();
    expect(stale.flight).toContain("record-page");
    await settle();
    // The stale request served the record; only the refresh ran the handler.
    expect(runs).toBe(1);
    runs = 0;
    const next = await serve();
    await settle();
    return { next, serve };
  }

  it.each([false, true])(
    "notFound() (notFoundBoundary: %s): the record is retired and the next request runs the handler",
    async (boundary) => {
      const { next } = await staleRefresh("notFound", { boundary });
      expect(runs).toBe(1);
      expect(next.response.status).toBe(liveNotFoundStatus(shape));
      expect(next.flight).not.toContain("record-page");
    },
  );

  it("notFound(), navigation: the record is retired and the next navigation runs the handler", async () => {
    const { next } = await staleRefresh("notFound", {
      boundary: true,
      partial: { from: "/elsewhere" },
    });
    expect(runs).toBe(1);
    expect(next.flight).not.toContain("record-page");
    expect(next.flight).toContain("declared-not-found");
  });

  it("a page that comes back after the retire is stored again", async () => {
    const { serve } = await staleRefresh("notFound");
    outcome = "page";
    const back = await serve();
    expect(back.flight).toContain("record-page");
    await settle();
    runs = 0;
    const hit = await serve();
    expect(hit.flight).toContain("record-page");
    expect(runs).toBe(0);
  });

  it.each(RETAINED)("%s: the stored record keeps serving", async (to) => {
    const { next } = await staleRefresh(to);
    expect(next.response.status).toBe(200);
    expect(next.flight).toContain("record-page");
  });
});

describe.each(ALL_STORES)(
  "loader cache() on the %s store, stale refresh",
  (kind) => {
    async function staleRefresh(to: Outcome) {
      const clock = movableClock();
      const cacheStore = createStore(kind);
      const router = createRouter({ cache: { store: cacheStore } }).routes(
        urls(({ path, loader, cache, notFoundBoundary }) => [
          path("/lc", LoaderPage, { name: "lc" }, () => [
            notFoundBoundary(<p>declared-not-found</p>),
            loader(RecordLoader, () => [cache({ ttl: 1, swr: 300 })]),
          ]),
          path("/elsewhere", Elsewhere, { name: "elsewhere" }),
        ]),
      );
      const serve = () => serveShellRequest(router, "/lc", { cacheStore });
      const first = await serve();
      expect(first.flight).toContain("record-loaded");
      await settle();
      clock.advance(1_500);
      outcome = to;
      runs = 0;
      const stale = await serve();
      expect(stale.flight).toContain("record-loaded");
      await settle();
      expect(runs).toBe(1);
      runs = 0;
      const next = await serve();
      await settle();
      return { next, serve };
    }

    it("notFound(): the entry is retired and the next request runs the loader", async () => {
      const { next } = await staleRefresh("notFound");
      expect(runs).toBe(1);
      expect(next.response.status).toBe(404);
      expect(next.flight).not.toContain("record-loaded");
    });

    it("a value that comes back after the retire is stored again", async () => {
      const { serve } = await staleRefresh("notFound");
      outcome = "page";
      const back = await serve();
      expect(back.flight).toContain("record-loaded");
      await settle();
      runs = 0;
      const hit = await serve();
      expect(hit.flight).toContain("record-loaded");
      expect(runs).toBe(0);
    });

    it.each(RETAINED)("%s: the stored value keeps serving", async (to) => {
      const { next } = await staleRefresh(to);
      expect(next.response.status).toBe(200);
      expect(next.flight).toContain("record-loaded");
    });
  },
);

describe.each(ALL_STORES)(
  "response route cache() on the %s store, stale refresh",
  (kind) => {
    async function staleRefresh(to: Outcome) {
      const clock = movableClock();
      const cacheStore = createStore(kind);
      const router = createRouter<{}>({ cache: { store: cacheStore } }).routes(
        urls(({ path, cache }) => [
          cache({ ttl: 1, swr: 300 }, () => [
            path.json(
              "/api/record",
              () => {
                // A response route answers its not-found as a 404:
                // RouterError's problem+json (skills/response-routes).
                if (outcome === "notFound") {
                  runs += 1;
                  throw new RouterError("NOT_FOUND", "record deleted", {
                    status: 404,
                  });
                }
                answer();
                return { label: "record-json" };
              },
              { name: "api.record" },
            ),
          ]),
        ]),
      ) as Parameters<typeof dispatch>[0];
      const serve = () => dispatch(router, { request: "/api/record" });
      const first = await serve();
      expect(first.status).toBe(200);
      await settle();
      clock.advance(1_500);
      outcome = to;
      runs = 0;
      const stale = await serve();
      expect(await stale.text()).toContain("record-json");
      await settle();
      expect(runs).toBe(1);
      runs = 0;
      const next = await serve();
      await settle();
      return { next, serve };
    }

    it("notFound(): the entry is retired and the next request answers 404", async () => {
      const { next } = await staleRefresh("notFound");
      expect(runs).toBe(1);
      expect(next.status).toBe(404);
      expect(await next.text()).not.toContain("record-json");
    });

    it("a response that comes back after the retire is stored again", async () => {
      const { serve } = await staleRefresh("notFound");
      outcome = "page";
      const back = await serve();
      expect(await back.text()).toContain("record-json");
      await settle();
      runs = 0;
      const hit = await serve();
      expect(await hit.text()).toContain("record-json");
      expect(runs).toBe(0);
    });

    it.each(RETAINED)("%s: the stored response keeps serving", async (to) => {
      const { next } = await staleRefresh(to);
      expect(next.status).toBe(200);
      expect(await next.text()).toContain("record-json");
    });
  },
);

describe.each(ALL_STORES)(
  '"use cache" on the %s store, stale refresh',
  (kind) => {
    async function staleRefresh(to: Outcome) {
      const clock = movableClock();
      const cacheStore = createStore(kind);
      const router = createRouter({
        cacheProfiles: { default: { ttl: 1, swr: 300 } },
      }).routes(
        urls(({ path, notFoundBoundary }) => [
          path(
            "/uc",
            async () => <p>{await getRecord()}</p>,
            { name: "uc" },
            () => [notFoundBoundary(<p>declared-not-found</p>)],
          ),
          path("/elsewhere", Elsewhere, { name: "elsewhere" }),
        ]),
      );
      const serve = () => serveShellRequest(router, "/uc", { cacheStore });
      record.outcome = "page";
      const first = await serve();
      expect(first.flight).toContain("record-cached");
      await settle();
      clock.advance(1_500);
      record.outcome = to;
      record.runs = 0;
      const stale = await serve();
      expect(stale.flight).toContain("record-cached");
      await settle();
      expect(record.runs).toBe(1);
      record.runs = 0;
      const next = await serve();
      await settle();
      return { next, serve };
    }

    it("notFound(): the entry is retired and the next request runs the function", async () => {
      const { next } = await staleRefresh("notFound");
      expect(record.runs).toBe(1);
      expect(next.response.status).toBe(404);
      expect(next.flight).not.toContain("record-cached");
    });

    it("a value that comes back after the retire is stored again", async () => {
      const { serve } = await staleRefresh("notFound");
      record.outcome = "page";
      const back = await serve();
      expect(back.flight).toContain("record-cached");
      await settle();
      record.runs = 0;
      const hit = await serve();
      expect(hit.flight).toContain("record-cached");
      expect(record.runs).toBe(0);
    });

    it.each(RETAINED)("%s: the stored value keeps serving", async (to) => {
      const { next } = await staleRefresh(to);
      expect(next.response.status).toBe(200);
      expect(next.flight).toContain("record-cached");
    });
  },
);
