/**
 * `loader(Def, { prefetch: false })` and `loading(fallback, { prefetch: false })`
 * through a public primitive: what a prefetch request skips, what the fill
 * request that follows it runs, and what stays as it was
 * (docs/design/prefetch-false.md, rules R1 to R13).
 *
 * Every route counts the runs of its handlers and loaders in `runs`. A
 * prefetch is `partial: { prefetch: true }`; the fill is
 * `partial: { fill: true }` with the ids the prefetch delivered, minus the
 * deferred ones, as the browser sends it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";

vi.mock(
  "@vitejs/plugin-rsc/rsc/server",
  () => import("../vitest-stubs/plugin-rsc.js"),
);
vi.mock(
  "@vitejs/plugin-rsc/rsc/client",
  () => import("../vitest-stubs/plugin-rsc.js"),
);

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  createVar,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";

const runs: Record<string, number> = {};
const ran = (name: string): number => (runs[name] = (runs[name] ?? 0) + 1);
const count = (name: string): number => runs[name] ?? 0;

/** A loader that counts its runs under `name`. */
function counted(name: string) {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

/** A handler that counts its runs under `name`. */
function page(name: string) {
  return (): React.ReactNode => <p>{`${name}-run-${ran(name)}`}</p>;
}

const PriceLoader = counted("price");
const ReviewsLoader = counted("reviews");
const CachedReviewsLoader = counted("cachedReviews");
const OrdersLoader = counted("orders-loader");
const SectionLoader = counted("section-loader");
const SectionPageLoader = counted("section-page-loader");
const CachedPageLoader = counted("cached-loader");
const PprLiveLoader = counted("ppr-live");
const PprBakeLoader = counted("ppr-bake");
const PreLoader = counted("pre-loader");
const SsrFalseLoader = counted("ssr-false");
const AwaitedLoader = counted("awaited");
const SideLoader = counted("side-loader");
const ModalLoader = counted("modal-loader");
const HeldLoader = counted("held-loader");
const UnderCacheLoader = counted("under-cache-loader");

const Notes = createHandle<string>();

/** Deferrable by its own flag, and reads the barrier: refused (R12). */
const FlaggedRenderedLoader = createLoader(async (ctx) => {
  ran("flagged-rendered");
  await ctx.rendered();
  return { notes: ctx.get(Notes) };
});

/** Deferrable by the loading() above it, and reads the barrier (R12). */
const BehindRenderedLoader = createLoader(async (ctx) => {
  ran("behind-rendered");
  await ctx.rendered();
  return { notes: ctx.get(Notes) };
});

/** Not deferrable, reads the barrier of a tree with a flagged unit (R13). */
const OuterRenderedLoader = createLoader(async (ctx) => {
  ran("outer-rendered");
  await ctx.rendered();
  return { notes: ctx.get(Notes) };
});

const FromMiddleware = createVar<string>();
const FromLayout = createVar<string>();

/** Deferred work reporting what it can read from context (R10). */
const ContextLoader = createLoader(async (ctx) => {
  ran("context-loader");
  return {
    middleware: `middleware:${ctx.get(FromMiddleware) ?? "missing"}`,
    layout: `layout:${ctx.get(FromLayout) ?? "missing"}`,
  };
});

function ContextLayout(ctx: HandlerContext): React.ReactNode {
  ran("context-layout");
  ctx.set(FromLayout, "set");
  return <p>context-layout</p>;
}

async function AwaitedPage(ctx: HandlerContext): Promise<React.ReactNode> {
  ran("awaited-page");
  const { value } = await ctx.use(AwaitedLoader);
  return <p>{value}</p>;
}

const errors: string[] = [];

function makeRouter() {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  })
    .use(async (ctx, next) => {
      ctx.set(FromMiddleware, "set");
      await next();
    })
    .routes(
      urls(
        ({
          path,
          layout,
          loader,
          loading,
          cache,
          parallel,
          intercept,
          revalidate,
        }) => [
          layout(page("shell"), () => [
            path("/", page("home"), { name: "home" }),
            path("/elsewhere", page("elsewhere"), { name: "elsewhere" }),
            path("/product/:id", page("product"), { name: "product" }, () => [
              loader(PriceLoader),
              loader(ReviewsLoader, { prefetch: false }),
              loading(<p>product-loading</p>),
            ]),
            path("/cached-loader", page("cached-loader-page"), () => [
              loader(CachedReviewsLoader, { prefetch: false }, () => [
                cache({ ttl: 60 }),
              ]),
              loading(<p>cached-loader-loading</p>),
            ]),
            path("/orders", page("orders"), { name: "orders" }, () => [
              loader(OrdersLoader),
              loading(<p>orders-loading</p>, { prefetch: false }),
            ]),
            layout(page("section"), () => [
              loading(<p>section-loading</p>, { prefetch: false }),
              loader(SectionLoader),
              path(
                "/section/a",
                page("section-a"),
                { name: "sectionA" },
                () => [loader(SectionPageLoader)],
              ),
            ]),
            path("/cached", page("cached"), { name: "cached" }, () => [
              cache({ ttl: 60 }),
              loader(CachedPageLoader),
              loading(<p>cached-loading</p>, { prefetch: false }),
            ]),
            layout(page("above-cache"), () => [
              loading(<p>above-cache-loading</p>, { prefetch: false }),
              path("/above-cache", page("under-cache"), () => [
                cache({ ttl: 60 }),
                loader(UnderCacheLoader),
              ]),
            ]),
            path("/ppr", page("ppr"), { name: "ppr", ppr: true }, () => [
              loader(PprLiveLoader, { prefetch: false }),
              loader(PprBakeLoader, { ssr: false, prefetch: false }),
              loading(<p>ppr-loading</p>),
            ]),
            path("/pre", Prerender(page("pre")), { name: "pre" }, () => [
              loader(PreLoader),
              loading(<p>pre-loading</p>, { prefetch: false }),
            ]),
            path("/ssr-false", page("ssr-false-page"), () => [
              loader(SsrFalseLoader, { ssr: false, prefetch: false }),
              loading(<p>ssr-false-loading</p>),
            ]),
            path("/awaited", AwaitedPage, { name: "awaited" }, () => [
              loader(AwaitedLoader, { prefetch: false }),
            ]),
            path("/slot", page("slot-page"), { name: "slot" }, () => [
              parallel({ "@side": page("side") }, () => [
                loader(SideLoader),
                loading(<p>side-loading</p>, { prefetch: false }),
              ]),
            ]),
            path("/item/:id", page("item"), { name: "item" }, () => [
              loader(ReviewsLoader, { prefetch: false }),
              loading(<p>item-loading</p>, { prefetch: false }),
            ]),
            intercept("@modal", ".item", page("modal"), () => [
              loader(ModalLoader, { prefetch: false }),
            ]),
            layout(page("held"), () => [
              revalidate(() => {
                ran("held-predicate");
                return true;
              }),
              loader(HeldLoader, () => [
                revalidate(() => {
                  ran("held-loader-predicate");
                  return true;
                }),
              ]),
              path("/held", page("held-page"), { name: "held" }, () => [
                loader(ReviewsLoader, { prefetch: false }),
                loading(<p>held-loading</p>),
              ]),
            ]),
            path("/flagged-rendered", page("flagged-rendered-page"), () => [
              loader(FlaggedRenderedLoader, { prefetch: false }),
              loading(<p>flagged-rendered-loading</p>),
            ]),
            path("/behind-rendered", page("behind-rendered-page"), () => [
              loader(BehindRenderedLoader),
              loading(<p>behind-rendered-loading</p>, { prefetch: false }),
            ]),
            layout(ContextLayout, () => [
              path(
                "/context",
                page("context-page"),
                { name: "context" },
                () => [
                  loader(ContextLoader, { prefetch: false }),
                  loading(<p>context-loading</p>),
                ],
              ),
            ]),
            layout(page("outer"), () => [
              loader(OuterRenderedLoader),
              path(
                "/barrier-unit",
                (ctx) => {
                  ran("barrier-unit");
                  ctx.use(Notes)("unit-note");
                  return <p>barrier-unit</p>;
                },
                { name: "barrierUnit" },
                () => [loading(<p>barrier-loading</p>, { prefetch: false })],
              ),
              path(
                "/barrier-loader",
                (ctx) => {
                  ran("barrier-loader-page");
                  ctx.use(Notes)("page-note");
                  return <p>barrier-loader</p>;
                },
                { name: "barrierLoader" },
                () => [
                  loader(ReviewsLoader, { prefetch: false }),
                  loading(<p>barrier-loader-loading</p>),
                ],
              ),
            ]),
          ]),
        ],
      ),
    );
}

type Wire = {
  id: string;
  type: string;
  deferred?: boolean;
  component?: unknown;
  loading?: unknown;
  loaderData?: unknown;
};

const present = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== "$undefined";

/** The metadata row (`0:`) of a partial response, as the client receives it. */
function payloadOf(result: ServeShellRequestResult) {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row, "a Flight payload").toBeDefined();
  const { segments, matched, diff } = JSON.parse(row!.slice(2)).metadata as {
    segments: Wire[];
    matched: string[];
    diff: string[];
  };
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return {
    segments,
    matched,
    diff,
    ids: segments.map((segment) => segment.id),
    deferred: segments.filter((s) => s.deferred === true).map((s) => s.id),
    /** The one segment whose id ends with `suffix`. */
    find(suffix: string): Wire | undefined {
      return segments.find((segment) => segment.id.endsWith(suffix));
    },
    byId,
  };
}

/**
 * A store that reports its route records stale on demand. CFCacheStore does
 * inside the swr window; MemorySegmentCacheStore never does.
 */
class StaleRecordStore extends MemorySegmentCacheStore {
  stale = false;
  override async get(key: string) {
    const hit = await super.get(key);
    return hit && this.stale ? { ...hit, shouldRevalidate: true } : hit;
  }
}

function setup(cacheStore = new MemorySegmentCacheStore()) {
  const router = makeRouter();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** A prefetch of `url` from `from`, holding `segments`. */
  const prefetch = (url: string, from = "/", segments: string[] = []) =>
    serve(url, { partial: { from, segments, prefetch: true } });
  /** The fill the browser sends after adopting `prefetched`. */
  const fill = (url: string, prefetched: ReturnType<typeof payloadOf>) =>
    serve(url, {
      partial: {
        from: url,
        segments: prefetched.matched.filter(
          (id) => !prefetched.deferred.includes(id),
        ),
        fill: true,
      },
    });
  return { router, cacheStore, serve, prefetch, fill };
}

beforeEach(async () => {
  for (const key of Object.keys(runs)) delete runs[key];
  errors.length = 0;
  await resetShellTestState();
});

describe("R1: a flagged loader in a prefetch", () => {
  it("is not executed and is marked deferred; its unflagged sibling runs", async () => {
    const { prefetch } = setup();
    const result = await prefetch("/product/1");
    const payload = payloadOf(result);

    expect(count("reviews")).toBe(0);
    expect(count("price")).toBe(1);
    expect(count("product")).toBe(1);

    const reviews = payload.find(ReviewsLoader.$$id)!;
    expect(reviews).toMatchObject({ type: "loader", deferred: true });
    expect("loaderData" in reviews).toBe(false);
    const price = payload.find(PriceLoader.$$id)!;
    expect(price.deferred).toBeUndefined();
    expect(present(price.loaderData)).toBe(true);
    expect(await result.readDeferred()).toEqual([reviews.id]);
    expect(payload.matched).toContain(reviews.id);
  });

  it("does not read the loader's own cache(), even when it would hit", async () => {
    const { serve, prefetch } = setup();
    // A document request runs the loader and fills its cache.
    await serve("/cached-loader");
    expect(count("cachedReviews")).toBe(1);
    // A navigation serves the cached value without running it.
    const nav = payloadOf(
      await serve("/cached-loader", { partial: { from: "/" } }),
    );
    expect(count("cachedReviews")).toBe(1);
    expect(present(nav.find(CachedReviewsLoader.$$id)!.loaderData)).toBe(true);

    const payload = payloadOf(await prefetch("/cached-loader"));
    const cached = payload.find(CachedReviewsLoader.$$id)!;
    expect(cached.deferred).toBe(true);
    expect("loaderData" in cached).toBe(false);
    expect(count("cachedReviews")).toBe(1);
  });

  it("runs on a navigation with no prefetch to adopt, and on a document request", async () => {
    const { serve } = setup();
    const nav = payloadOf(
      await serve("/product/1", { partial: { from: "/" } }),
    );
    expect(count("reviews")).toBe(1);
    expect(nav.deferred).toEqual([]);
    expect(present(nav.find(ReviewsLoader.$$id)!.loaderData)).toBe(true);

    const document = await serve("/product/1");
    expect(count("reviews")).toBe(2);
    expect(document.flight).not.toContain('"deferred"');
  });
});

describe("R2: a flagged loading() entry in a prefetch", () => {
  it("skips the handler and its loaders, sends the fallback and marks the route deferred", async () => {
    const { prefetch } = setup();
    const result = await prefetch("/orders");
    const payload = payloadOf(result);

    expect(count("orders")).toBe(0);
    expect(count("orders-loader")).toBe(0);
    expect(count("shell")).toBe(1);

    const route = payload.segments.find((s) => s.type === "route")!;
    expect(route).toMatchObject({ deferred: true, component: null });
    expect(present(route.loading)).toBe(true);
    expect(result.flight).toContain("orders-loading");
    expect(payload.find(OrdersLoader.$$id)).toMatchObject({ deferred: true });
    expect(payload.deferred).toHaveLength(2);
  });

  it("skips every deeper entry of the chain for a flagged layout", async () => {
    const { prefetch, serve } = setup();
    const full = payloadOf(
      await serve("/section/a", { partial: { from: "/" } }),
    );
    for (const key of Object.keys(runs)) delete runs[key];

    const payload = payloadOf(await prefetch("/section/a"));
    expect(count("section")).toBe(0);
    expect(count("section-a")).toBe(0);
    expect(count("section-loader")).toBe(0);
    expect(count("section-page-loader")).toBe(0);

    const section = payload.segments.find(
      (s) => s.type === "layout" && s.deferred === true,
    )!;
    expect(section.component).toBeNull();
    expect(present(section.loading)).toBe(true);
    // Nothing deeper than the unit is in the payload or in `matched`.
    const deeper = full.matched.filter(
      (id) => id !== section.id && id.startsWith(section.id),
    );
    const routeId = deeper.find((id) => !id.includes("D"))!;
    expect(routeId).toBeDefined();
    expect(payload.matched).not.toContain(routeId);
    expect(payload.find(SectionPageLoader.$$id)).toBeUndefined();
    expect(payload.find(SectionLoader.$$id)).toMatchObject({ deferred: true });
  });

  it("defers a parallel slot with its own flagged loading() as its own unit", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/slot"));

    expect(count("slot-page")).toBe(1);
    expect(count("side")).toBe(0);
    expect(count("side-loader")).toBe(0);
    const slot = payload.segments.find((s) => s.type === "parallel")!;
    expect(slot).toMatchObject({ deferred: true, component: null });
    expect(present(slot.loading)).toBe(true);
    const route = payload.segments.find((s) => s.type === "route")!;
    expect(route.deferred).toBeUndefined();
    expect(payload.find(SideLoader.$$id)).toMatchObject({ deferred: true });
  });

  it("under an enabled cache() the route is rendered and stored as before; only its loader is deferred", async () => {
    const { prefetch, serve } = setup();
    const miss = payloadOf(await prefetch("/cached"));
    expect(count("cached")).toBe(1);
    expect(count("cached-loader")).toBe(0);
    const route = miss.segments.find((s) => s.type === "route")!;
    expect(route.deferred).toBeUndefined();
    expect(present(route.component)).toBe(true);
    expect(miss.deferred).toEqual([miss.find(CachedPageLoader.$$id)!.id]);

    // The record the MISS wrote serves the next prefetch and a navigation.
    const hit = payloadOf(await prefetch("/cached", "/elsewhere"));
    expect(count("cached")).toBe(1);
    expect(hit.deferred).toEqual([hit.find(CachedPageLoader.$$id)!.id]);

    const nav = payloadOf(await serve("/cached", { partial: { from: "/" } }));
    expect(count("cached")).toBe(1);
    expect(count("cached-loader")).toBe(1);
    expect(nav.deferred).toEqual([]);
  });

  it("a unit above a cache() boundary neither serves nor writes the record below it", async () => {
    const { prefetch, serve } = setup();
    const payload = payloadOf(await prefetch("/above-cache"));
    expect(count("above-cache")).toBe(0);
    expect(count("under-cache")).toBe(0);
    expect(payload.segments.find((s) => s.type === "route")).toBeUndefined();

    // Nothing was stored: the navigation renders the route for the first time.
    await serve("/above-cache", { partial: { from: "/" } });
    expect(count("under-cache")).toBe(1);
    expect(count("above-cache")).toBe(1);
  });

  it("on a ppr route the handler layer replays as before and the live loader is deferred", async () => {
    const { prefetch } = setup();
    const first = await prefetch("/ppr");
    const second = await prefetch("/ppr", "/elsewhere");
    expect(second.replayStatus?.outcome).toBe("HIT");
    for (const result of [first, second]) {
      const payload = payloadOf(result);
      const live = payload.find(PprLiveLoader.$$id)!;
      expect(payload.deferred).toEqual([live.id]);
      expect(present(payload.find(PprBakeLoader.$$id)!.loaderData)).toBe(true);
    }
    expect(count("ppr-live")).toBe(0);
  });

  it("on a Prerender route the stored handler serves and the loader behind the fallback is deferred", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/pre"));
    const bakes = count("pre");
    expect(count("pre-loader")).toBe(0);
    const route = payload.segments.find((s) => s.type === "route")!;
    expect(route.deferred).toBeUndefined();
    expect(present(route.component)).toBe(true);
    expect(payload.deferred).toEqual([payload.find(PreLoader.$$id)!.id]);

    await prefetch("/pre", "/elsewhere");
    expect(count("pre")).toBe(bakes);
  });
});

describe("R3: ssr: false with prefetch: false", () => {
  it("outside ppr the document awaits the loader and a prefetch skips it", async () => {
    const { serve, prefetch } = setup();
    await serve("/ssr-false");
    expect(count("ssr-false")).toBe(1);

    const payload = payloadOf(await prefetch("/ssr-false"));
    expect(count("ssr-false")).toBe(1);
    expect(payload.find(SsrFalseLoader.$$id)).toMatchObject({ deferred: true });
  });

  it("on a ppr route the flag is ignored for the bake lane", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/ppr"));
    const bake = payload.find(PprBakeLoader.$$id)!;
    expect(bake.deferred).toBeUndefined();
    expect(present(bake.loaderData)).toBe(true);
  });
});

describe("R5: the fill request", () => {
  it("runs the deferred loader once and emits only what the client does not hold", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/product/1"));
    expect(count("reviews")).toBe(0);

    const result = await fill("/product/1", prefetched);
    const payload = payloadOf(result);
    expect(count("reviews")).toBe(1);
    expect(count("price")).toBe(1);
    expect(count("product")).toBe(1);
    expect(count("shell")).toBe(1);
    expect(payload.ids).toEqual([prefetched.find(ReviewsLoader.$$id)!.id]);
    expect(present(payload.segments[0]!.loaderData)).toBe(true);
    expect(payload.deferred).toEqual([]);
    expect(payload.matched).toEqual(prefetched.matched);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
  });

  it("runs a deferred route unit: its handler and loader once, nothing it holds", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/orders"));
    const payload = payloadOf(await fill("/orders", prefetched));

    expect(count("orders")).toBe(1);
    expect(count("orders-loader")).toBe(1);
    expect(count("shell")).toBe(1);
    expect(payload.ids.sort()).toEqual([...prefetched.deferred].sort());
    expect(payload.deferred).toEqual([]);
    const route = payload.segments.find((s) => s.type === "route")!;
    expect(present(route.component)).toBe(true);
  });

  it("runs everything a deferred layout unit covered", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/section/a"));
    const payload = payloadOf(await fill("/section/a", prefetched));

    expect(count("section")).toBe(1);
    expect(count("section-a")).toBe(1);
    expect(count("section-loader")).toBe(1);
    expect(count("section-page-loader")).toBe(1);
    expect(count("shell")).toBe(1);
    expect(payload.segments.some((s) => s.type === "route")).toBe(true);
    expect(payload.deferred).toEqual([]);
  });

  it("skips held segments outright: no revalidate() predicate, no handler, nothing emitted", async () => {
    const { prefetch, fill, serve } = setup();
    const prefetched = payloadOf(await prefetch("/held"));
    expect(count("held")).toBe(1);
    expect(count("held-loader")).toBe(1);
    const before = { ...runs };

    const payload = payloadOf(await fill("/held", prefetched));
    expect(count("reviews")).toBe(1);
    expect(count("held")).toBe(before.held);
    expect(count("held-loader")).toBe(before["held-loader"]);
    expect(count("held-page")).toBe(before["held-page"]);
    expect(count("held-predicate")).toBe(before["held-predicate"] ?? 0);
    expect(count("held-loader-predicate")).toBe(
      before["held-loader-predicate"] ?? 0,
    );
    expect(payload.ids).toEqual(prefetched.deferred);

    // The same request without the fill marker consults the predicates.
    await serve("/held", {
      partial: {
        from: "/held",
        segments: prefetched.matched.filter(
          (id) => !prefetched.deferred.includes(id),
        ),
      },
    });
    expect(count("held-predicate")).toBeGreaterThan(
      before["held-predicate"] ?? 0,
    );
  });

  it("serves a cache() route's fill from the held record: the handler does not run again", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/cached"));
    const payload = payloadOf(await fill("/cached", prefetched));
    expect(count("cached")).toBe(1);
    expect(count("cached-loader")).toBe(1);
    expect(payload.ids).toEqual(prefetched.deferred);
  });

  it("does not refresh a stale cache() record: no handler of a held segment runs, in the background either", async () => {
    const cacheStore = new StaleRecordStore();
    const { serve, prefetch, fill } = setup(cacheStore);
    const prefetched = payloadOf(await prefetch("/cached"));
    expect(count("cached")).toBe(1);
    cacheStore.stale = true;
    const written = vi.spyOn(cacheStore, "set");

    await fill("/cached", prefetched);
    expect({
      handler: count("cached"),
      shell: count("shell"),
      loader: count("cached-loader"),
    }).toEqual({ handler: 1, shell: 1, loader: 1 });
    expect(written).not.toHaveBeenCalled();

    // Control: the refresh is left to a request that reads the record. A
    // navigation serves the stale one and re-renders it, whole.
    const nav = payloadOf(await serve("/cached", { partial: { from: "/" } }));
    expect(nav.deferred).toEqual([]);
    expect(count("cached")).toBe(2);
    expect(written).toHaveBeenCalledTimes(1);
    // The route's own segment, rendered: the boundary is the route.
    const record = written.mock.calls[0]![1] as { segments: unknown[] };
    expect(record.segments).toHaveLength(1);
    expect(JSON.stringify(record.segments)).toContain("cached-run-2");
    expect(JSON.stringify(record.segments)).not.toContain("deferred");
  });
});

describe("R7: deferral is never stored, and modes never answer each other", () => {
  it("adds X-Rango-Prefetch to Vary for a flagged route only", async () => {
    const { prefetch, serve } = setup();
    const flagged = await prefetch("/product/1");
    expect(flagged.response.headers.get("vary")).toContain("X-Rango-Prefetch");
    const nav = await serve("/product/1", { partial: { from: "/" } });
    expect(nav.response.headers.get("vary")).toContain("X-Rango-Prefetch");
    const plain = await prefetch("/elsewhere");
    expect(plain.response.headers.get("vary")).not.toContain(
      "X-Rango-Prefetch",
    );
  });

  describe("the document cache", () => {
    /** One cacheable route at /doc, flagged or not, behind the middleware. */
    function docCache(flagged: boolean) {
      const cacheStore = new MemorySegmentCacheStore();
      const router = createRouter({ prefetchCacheTTL: false })
        .use(createDocumentCacheMiddleware())
        .routes(
          urls(({ path, loader, loading }) => [
            path("/", page("doc-home"), { name: "home" }),
            path(
              "/doc",
              (ctx) => {
                ctx.headers.set("Cache-Control", "s-maxage=60");
                return <p>{`doc-run-${ran("doc")}`}</p>;
              },
              { name: "doc" },
              () => [
                loader(ReviewsLoader, flagged ? { prefetch: false } : {}),
                loading(<p>doc-loading</p>),
              ],
            ),
          ]),
        );
      const serve = (partial: ServeShellRequestOptions["partial"]) =>
        serveShellRequest(router, "/doc", { cacheStore, partial });
      return { serve };
    }
    const status = (r: ServeShellRequestResult) =>
      r.response.headers.get("x-document-cache-status");

    it("a route with no flag shares one slot between a prefetch and a navigation", async () => {
      const { serve } = docCache(false);
      // The prefetch warms the slot the navigation reads, and the other way
      // round: the two are the same body.
      expect(status(await serve({ from: "/", prefetch: true }))).toBe("MISS");
      const nav = await serve({ from: "/" });
      expect(status(nav)).toBe("HIT");
      expect(status(await serve({ from: "/", prefetch: true }))).toBe("HIT");
      expect({ doc: count("doc"), reviews: count("reviews") }).toEqual({
        doc: 1,
        reviews: 1,
      });
      expect(payloadOf(nav).deferred).toEqual([]);
    });

    it("a navigation is never answered with a body that carries deferred units", async () => {
      const { serve } = docCache(true);
      const first = await serve({ from: "/", prefetch: true });
      expect(status(first)).toBe("MISS");
      expect(payloadOf(first).deferred).toHaveLength(1);
      // The same prefetch again is the stored prefetch body.
      const again = await serve({ from: "/", prefetch: true });
      expect(status(again)).toBe("HIT");
      expect(payloadOf(again).deferred).toHaveLength(1);
      expect(count("reviews")).toBe(0);

      // A navigation with the same segments is not answered by it.
      const nav = await serve({ from: "/" });
      expect(status(nav)).toBe("MISS");
      expect(payloadOf(nav).deferred).toEqual([]);
      expect(count("reviews")).toBe(1);
      // And its own body is stored for the next navigation.
      const navAgain = await serve({ from: "/" });
      expect(status(navAgain)).toBe("HIT");
      expect(payloadOf(navAgain).deferred).toEqual([]);
      expect(count("reviews")).toBe(1);
    });

    it("a stored complete navigation body answers a later prefetch of a flagged route", async () => {
      const { serve } = docCache(true);
      expect(status(await serve({ from: "/" }))).toBe("MISS");
      expect(count("reviews")).toBe(1);

      // Complete, so the click that adopts it sends no fill, and serving it
      // ran nothing.
      const prefetched = await serve({ from: "/", prefetch: true });
      expect(status(prefetched)).toBe("HIT");
      expect(payloadOf(prefetched).deferred).toEqual([]);
      expect({ doc: count("doc"), reviews: count("reviews") }).toEqual({
        doc: 1,
        reviews: 1,
      });
    });

    it("a fill is never stored and never served from the cache", async () => {
      const { serve } = docCache(true);
      const prefetched = payloadOf(await serve({ from: "/", prefetch: true }));
      const held = prefetched.matched.filter(
        (id) => !prefetched.deferred.includes(id),
      );
      for (const expected of [1, 2]) {
        const filled = await serve({
          from: "/doc",
          segments: held,
          fill: true,
        });
        expect(status(filled)).toBeNull();
        expect(count("reviews")).toBe(expected);
        expect(filled.response.headers.get("cache-control")).toBe("no-store");
      }
    });
  });
});

describe("R8: where the flag cannot be honoured the work runs in the prefetch", () => {
  it("delivers a flagged loader its handler awaits with ctx.use()", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/awaited"));
    expect(count("awaited")).toBe(1);
    expect(count("awaited-page")).toBe(1);
    const awaited = payload.find(AwaitedLoader.$$id)!;
    expect(awaited.deferred).toBeUndefined();
    expect(present(awaited.loaderData)).toBe(true);
    expect(payload.deferred).toEqual([]);
  });

  it("defers nothing in a prefetch that resolves an intercept", async () => {
    const { prefetch } = setup();
    const result = await prefetch("/item/1", "/");
    const payload = payloadOf(result);
    expect(result.flight).toContain("modal-run-1");
    expect(count("modal-loader")).toBe(1);
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
  });
});

describe("R10: what deferred work can read from context", () => {
  it("control: on a navigation the loader reads what the layout above it set", async () => {
    const { serve } = setup();
    const result = await serve("/context", { partial: { from: "/" } });
    expect(count("context-layout")).toBe(1);
    expect(result.flight).toContain("middleware:set");
    expect(result.flight).toContain("layout:set");
  });

  it("in the fill, middleware context is there and a held layout's ctx.set() is not", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/context"));
    expect(count("context-loader")).toBe(0);
    expect(count("context-layout")).toBe(1);

    const result = await fill("/context", prefetched);
    expect(count("context-loader")).toBe(1);
    // The layout is held: the fill does not run it again.
    expect(count("context-layout")).toBe(1);
    expect(result.flight).toContain("middleware:set");
    expect(result.flight).toContain("layout:missing");
  });
});

describe("R12: a deferrable loader cannot call ctx.rendered()", () => {
  it("throws on a document request for a flagged loader, naming it and both fixes", async () => {
    const { serve } = setup();
    await serve("/flagged-rendered");
    const message = errors.find((m) => m.includes("ctx.rendered()"));
    expect(message).toBeDefined();
    expect(message).toContain(FlaggedRenderedLoader.$$id);
    expect(message).toContain("prefetch: false");
    expect(message).toMatch(/loading\(\)/);
    expect(message).toMatch(/stop calling ctx\.rendered\(\)/);
  });

  it("throws on a document request for a loader behind a flagged loading()", async () => {
    const { serve } = setup();
    await serve("/behind-rendered");
    const message = errors.find((m) => m.includes("ctx.rendered()"));
    expect(message).toBeDefined();
    expect(message).toContain(BehindRenderedLoader.$$id);
    expect(message).toContain("prefetch: false");
  });

  it("throws on a navigation too", async () => {
    const { serve } = setup();
    await serve("/flagged-rendered", { partial: { from: "/" } });
    expect(errors.some((m) => m.includes(FlaggedRenderedLoader.$$id))).toBe(
      true,
    );
  });
});

describe("R13: a prefetch that skipped a handler cannot satisfy the barrier", () => {
  it("rejects ctx.rendered() for a loader outside the unit, naming the skipped segment", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/barrier-unit"));
    expect(count("barrier-unit")).toBe(0);
    expect(count("outer-rendered")).toBe(1);
    const unit = payload.segments.find((s) => s.type === "route")!;
    expect(unit.deferred).toBe(true);
    const message = errors.find((m) => m.includes("ctx.rendered()"));
    expect(message).toBeDefined();
    expect(message).toContain(`"${unit.id}"`);
    expect(message).toContain(OuterRenderedLoader.$$id);
  });

  it("leaves the same loader alone on a navigation", async () => {
    const { serve } = setup();
    await serve("/barrier-unit", { partial: { from: "/" } });
    expect(count("barrier-unit")).toBe(1);
    expect(errors).toEqual([]);
  });

  it("is not triggered by a prefetch that defers only loaders", async () => {
    const { prefetch } = setup();
    const payload = payloadOf(await prefetch("/barrier-loader"));
    expect(payload.deferred).toEqual([payload.find(ReviewsLoader.$$id)!.id]);
    expect(count("barrier-loader-page")).toBe(1);
    expect(count("outer-rendered")).toBe(1);
    expect(errors).toEqual([]);
  });
});
