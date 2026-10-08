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
  Static,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";
import {
  SEGMENT_FRAGMENT_CAPABILITY_HEADER,
  SEGMENT_FRAGMENT_RECOVERY_HEADER,
} from "../../segment-fragments.js";
import {
  ratingsFor,
  runs as cachedRuns,
} from "./fixtures/prefetch-false-use-cache-data.js";

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
const SectionPlainLoader = counted("section-plain-loader");
const SectionOwnLoader = counted("section-own-loader");
const SectionCachedLoader = counted("section-cached-loader");
const TwinCachedLoader = counted("twin-cached-loader");
const RevalLoader = counted("reval-loader");
const CachedPageLoader = counted("cached-loader");
/** Reads a "use cache" function: its own run is counted, and the function's. */
const RatingsLoader = createLoader(async () => {
  ran("ratings-loader");
  return { value: await ratingsFor("loader") };
});
const PprLiveLoader = counted("ppr-live");
const PprBakeLoader = counted("ppr-bake");
const PreLoader = counted("pre-loader");
const SsrFalseLoader = counted("ssr-false");
const AwaitedLoader = counted("awaited");
const SideLoader = counted("side-loader");
const ModalLoader = counted("modal-loader");
const HeldLoader = counted("held-loader");
const UnderCacheLoader = counted("under-cache-loader");
const StaticLoader = counted("static-loader");
const GalleryLoader = counted("gallery-loader");

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

// Flagged loaders that something else reads with ctx.use(), in time or late
// (docs/design/prefetch-false.md, "Limits").
const EarlyDepLoader = counted("early-dep");
const LateDepLoader = counted("late-dep");
const StreamedEarlyDepLoader = counted("streamed-early-dep");
const StreamedLateDepLoader = counted("streamed-late-dep");

/** Not deferred itself; reads the flagged loader before its first await. */
const EarlyReaderLoader = createLoader(async (ctx) => {
  const dep = await ctx.use(EarlyDepLoader);
  return { dep: dep.value };
});

/** Not deferred itself; reads the flagged loader after an await. */
const LateReaderLoader = createLoader(async (ctx) => {
  await tick();
  const dep = await ctx.use(LateDepLoader);
  return { dep: dep.value };
});

/** Under loading(), so streamed: reads before its first await. */
async function StreamedEarlyPage(
  ctx: HandlerContext,
): Promise<React.ReactNode> {
  const { value } = await ctx.use(StreamedEarlyDepLoader);
  return <p>{value}</p>;
}

/** Under loading(), so streamed: reads after an await. */
async function StreamedLatePage(ctx: HandlerContext): Promise<React.ReactNode> {
  await tick();
  const { value } = await ctx.use(StreamedLateDepLoader);
  return <p>{value}</p>;
}

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
          transition,
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
            path("/ratings", page("ratings-page"), () => [
              loader(RatingsLoader, { prefetch: false }),
              loading(<p>ratings-loading</p>),
            ]),
            path(
              "/ratings-unit",
              async () => {
                ran("ratings-unit");
                return <p>{await ratingsFor("handler")}</p>;
              },
              () => [loading(<p>ratings-unit-loading</p>, { prefetch: false })],
            ),
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
              // Siblings inside the section: no loading() of its own, its own
              // flagged loading(), and a cache() route.
              path("/section/plain", page("section-plain"), () => [
                loader(SectionPlainLoader),
              ]),
              path("/section/own", page("section-own"), () => [
                loader(SectionOwnLoader),
                loading(<p>section-own-loading</p>, { prefetch: false }),
              ]),
              path("/section/cached", page("section-cached"), () => [
                cache({ ttl: 60 }),
                loader(SectionCachedLoader),
              ]),
              path("/section/animated", page("section-animated"), () => [
                transition(),
              ]),
            ]),
            // A flagged layout that re-renders on every navigation, and a
            // flagged loader that does: held segments, never deferred.
            layout(page("reval"), () => [
              loading(<p>reval-loading</p>, { prefetch: false }),
              revalidate(() => {
                ran("reval-predicate");
                return true;
              }),
              path("/reval/a", page("reval-a"), { name: "revalA" }),
              path("/reval/b", page("reval-b"), { name: "revalB" }),
            ]),
            path("/reval-loader", page("reval-loader-page"), () => [
              loader(RevalLoader, { prefetch: false }, () => [
                revalidate(() => {
                  ran("reval-loader-predicate");
                  return true;
                }),
              ]),
              loading(<p>reval-loader-loading</p>),
            ]),
            // The section's twin with no flag: what the cache() route under
            // it does is what the one under the flagged layout must do.
            layout(page("twin"), () => [
              loading(<p>twin-loading</p>),
              path("/twin/a", page("twin-a"), { name: "twinA" }),
              path("/twin/cached", page("twin-cached"), () => [
                cache({ ttl: 60 }),
                loader(TwinCachedLoader),
              ]),
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
            // An intercept whose target sits under a flagged layout.
            layout(page("gallery"), () => [
              loading(<p>gallery-loading</p>, { prefetch: false }),
              loader(GalleryLoader),
              path("/gallery/:id", page("photo"), { name: "photo" }),
            ]),
            intercept("@modal", ".photo", page("photo-modal")),
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
                layout(page("held-orphan"), () => [
                  revalidate(() => {
                    ran("held-orphan-predicate");
                    return true;
                  }),
                ]),
              ]),
            ]),
            path("/static", Static(page("static")), { name: "static" }, () => [
              loader(StaticLoader),
              loading(<p>static-loading</p>, { prefetch: false }),
            ]),
            path("/reads-early", page("reads-early"), () => [
              loader(EarlyReaderLoader),
              loader(EarlyDepLoader, { prefetch: false }),
              loading(<p>reads-early-loading</p>),
            ]),
            path("/reads-late", page("reads-late"), () => [
              loader(LateReaderLoader),
              loader(LateDepLoader, { prefetch: false }),
              loading(<p>reads-late-loading</p>),
            ]),
            path("/streamed-early", StreamedEarlyPage, () => [
              loader(StreamedEarlyDepLoader, { prefetch: false }),
              loading(<p>streamed-early-loading</p>),
            ]),
            path("/streamed-late", StreamedLatePage, () => [
              loader(StreamedLateDepLoader, { prefetch: false }),
              loading(<p>streamed-late-loading</p>),
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
  transition?: unknown;
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
  for (const key of Object.keys(cachedRuns)) delete cachedRuns[key];
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

  // The fill is where the deferred loader runs, so that is where its cache()
  // is read and written: the prefetch above reads neither, by intent.
  it("a fill serves the loader's cache() when it is warm: the loader does not run", async () => {
    const { serve, prefetch, fill } = setup();
    await serve("/cached-loader");
    expect(count("cachedReviews")).toBe(1);

    const prefetched = payloadOf(await prefetch("/cached-loader"));
    const filled = await fill("/cached-loader", prefetched);
    expect(count("cachedReviews")).toBe(1);
    expect(
      present(payloadOf(filled).find(CachedReviewsLoader.$$id)!.loaderData),
    ).toBe(true);
    expect(filled.flight).toContain("cachedReviews-run-1");
  });

  it("a fill runs the loader and stores its cache() when it is cold, and the next visit's fill hits", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/cached-loader"));
    expect(count("cachedReviews")).toBe(0);

    const first = await fill("/cached-loader", prefetched);
    expect(count("cachedReviews")).toBe(1);
    expect(first.flight).toContain("cachedReviews-run-1");

    // The next visit: its prefetch still reads nothing, its fill hits.
    const again = payloadOf(await prefetch("/cached-loader"));
    expect(again.deferred).toEqual(prefetched.deferred);
    expect(count("cachedReviews")).toBe(1);
    const second = await fill("/cached-loader", again);
    expect(count("cachedReviews")).toBe(1);
    expect(second.flight).toContain("cachedReviews-run-1");
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

  // The browser decides how the click commits from the segments it has,
  // before the fill brings the route: a plain click to a route with
  // transition() commits in a transition. `viewTransition: false`: the
  // layout itself has no boundary to place.
  it("a flagged layout's placeholder carries a transition when a route it skips declares transition()", async () => {
    const { prefetch } = setup();
    const unit = async (path: string) =>
      payloadOf(await prefetch(path)).segments.find(
        (s) => s.type === "layout" && s.deferred === true,
      )!;

    expect((await unit("/section/animated")).transition).toEqual({
      viewTransition: false,
    });
    expect(count("section-animated"), "the route did not run").toBe(0);
    expect(present((await unit("/section/a")).transition)).toBe(false);
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

  it("on a Static route the handler is served as usual and the loader behind the fallback is deferred", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/static"));
    const route = prefetched.segments.find((s) => s.type === "route")!;
    expect(route.deferred).toBeUndefined();
    expect(present(route.component)).toBe(true);
    expect(count("static")).toBe(1);
    expect(count("static-loader")).toBe(0);
    expect(prefetched.deferred).toEqual([
      prefetched.find(StaticLoader.$$id)!.id,
    ]);

    const filled = payloadOf(await fill("/static", prefetched));
    expect(filled.ids).toEqual(prefetched.deferred);
    expect({
      handler: count("static"),
      loader: count("static-loader"),
    }).toEqual({ handler: 1, loader: 1 });
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
    expect(result.response.headers.get("cache-control")).toBe(
      "private, no-cache",
    );
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
    // The layout nested under the route: an orphan layout, held like the rest.
    expect(count("held-orphan")).toBe(1);
    const before = { ...runs };

    const payload = payloadOf(await fill("/held", prefetched));
    expect(count("reviews")).toBe(1);
    expect(count("held")).toBe(before.held);
    expect(count("held-loader")).toBe(before["held-loader"]);
    expect(count("held-page")).toBe(before["held-page"]);
    expect(count("held-orphan")).toBe(1);
    expect(count("held-predicate")).toBe(before["held-predicate"] ?? 0);
    expect(count("held-loader-predicate")).toBe(
      before["held-loader-predicate"] ?? 0,
    );
    expect(count("held-orphan-predicate")).toBe(
      before["held-orphan-predicate"] ?? 0,
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
    expect(count("held-orphan-predicate")).toBeGreaterThan(
      before["held-orphan-predicate"] ?? 0,
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

describe('"use cache" in deferred work', () => {
  it("inside a flagged loader: a prefetch reads nothing, the first fill runs and stores, the second fill hits", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/ratings"));
    expect(prefetched.deferred).toHaveLength(1);
    expect({ loader: count("ratings-loader"), fn: cachedRuns.loader }).toEqual({
      loader: 0,
      fn: undefined,
    });

    const first = await fill("/ratings", prefetched);
    expect({ loader: count("ratings-loader"), fn: cachedRuns.loader }).toEqual({
      loader: 1,
      fn: 1,
    });
    expect(first.flight).toContain("loader-ratings-1");

    // A warm entry changes nothing for a prefetch: it still defers.
    const again = payloadOf(await prefetch("/ratings"));
    expect(again.deferred).toEqual(prefetched.deferred);
    expect({ loader: count("ratings-loader"), fn: cachedRuns.loader }).toEqual({
      loader: 1,
      fn: 1,
    });
    const second = await fill("/ratings", again);
    // The loader runs again; the function it reads does not.
    expect({ loader: count("ratings-loader"), fn: cachedRuns.loader }).toEqual({
      loader: 2,
      fn: 1,
    });
    expect(second.flight).toContain("loader-ratings-1");
  });

  it("inside a deferred handler: a prefetch reads nothing, the first fill runs and stores, the second fill hits", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/ratings-unit"));
    expect(prefetched.deferred).toHaveLength(1);
    expect({ unit: count("ratings-unit"), fn: cachedRuns.handler }).toEqual({
      unit: 0,
      fn: undefined,
    });

    const first = await fill("/ratings-unit", prefetched);
    await first.readDeferred();
    expect({ unit: count("ratings-unit"), fn: cachedRuns.handler }).toEqual({
      unit: 1,
      fn: 1,
    });
    expect(first.flight).toContain("handler-ratings-1");

    const again = payloadOf(await prefetch("/ratings-unit"));
    expect(again.deferred).toEqual(prefetched.deferred);
    expect({ unit: count("ratings-unit"), fn: cachedRuns.handler }).toEqual({
      unit: 1,
      fn: 1,
    });
    const second = await fill("/ratings-unit", again);
    await second.readDeferred();
    expect({ unit: count("ratings-unit"), fn: cachedRuns.handler }).toEqual({
      unit: 2,
      fn: 1,
    });
    expect(second.flight).toContain("handler-ratings-1");
  });
});

describe("R7: deferral is never stored, and modes never answer each other", () => {
  // What a route answers with when the feature is not in play.
  const PREFETCH_CACHE_CONTROL = "private, max-age=300";
  // What a response nothing may reuse answers with (rsc-rendering.ts).
  const NOT_REUSED = "private, no-cache";
  const VARY = `accept, X-Rango-State, X-RSC-Router-Client-Path, ${SEGMENT_FRAGMENT_CAPABILITY_HEADER}, ${SEGMENT_FRAGMENT_RECOVERY_HEADER}`;
  const headersOf = (r: ServeShellRequestResult) => ({
    vary: r.response.headers.get("vary"),
    cacheControl: r.response.headers.get("cache-control"),
    scope: r.response.headers.get("x-rsc-prefetch-scope"),
  });

  it("a route with no flag answers a prefetch and a navigation as it does without the feature", async () => {
    const { prefetch, serve } = setup();
    expect(headersOf(await prefetch("/elsewhere"))).toEqual({
      vary: VARY,
      cacheControl: PREFETCH_CACHE_CONTROL,
      scope: null,
    });
    expect(
      headersOf(await serve("/elsewhere", { partial: { from: "/" } })),
    ).toEqual({ vary: VARY, cacheControl: null, scope: null });
  });

  // `Vary` names the prefetch header on this response only. A navigation has
  // the same URL as its prefetch, and a browser that kept the body answers
  // from it without asking while it reloads a document for back/forward: the
  // header keeps a deferring body from answering a navigation there.
  it("a prefetch that defers is for its source page only, is not to be reused and never answers a navigation", async () => {
    const { prefetch } = setup();
    for (const url of ["/product/1", "/orders"]) {
      const result = await prefetch(url);
      expect(payloadOf(result).deferred.length).toBeGreaterThan(0);
      expect(headersOf(result)).toEqual({
        vary: `${VARY}, X-Rango-Prefetch`,
        cacheControl: NOT_REUSED,
        scope: "source",
      });
    }
  });

  it("a flagged tree answers like any other when nothing is deferred", async () => {
    const { serve } = setup();
    expect(
      headersOf(await serve("/product/1", { partial: { from: "/" } })),
    ).toEqual({ vary: VARY, cacheControl: null, scope: null });

    // A prefetch from a page that holds the flagged segments.
    const held = payloadOf(
      await serve("/orders", { partial: { from: "/" } }),
    ).matched;
    const result = await serve("/orders", {
      partial: { from: "/orders", segments: held, prefetch: true },
    });
    expect(payloadOf(result).deferred).toEqual([]);
    expect(headersOf(result)).toEqual({
      vary: VARY,
      cacheControl: PREFETCH_CACHE_CONTROL,
      scope: null,
    });
  });

  describe("the document cache", () => {
    class CountingStore extends MemorySegmentCacheStore {
      reads = 0;
      writes = 0;
      override getResponse(key: string) {
        this.reads++;
        return super.getResponse(key);
      }
      override putResponse(
        ...args: Parameters<MemorySegmentCacheStore["putResponse"]>
      ) {
        this.writes++;
        return super.putResponse(...args);
      }
    }

    /** A handler whose response opts into the document cache. */
    const cacheable = (name: string) => (ctx: HandlerContext) => {
      ctx.headers.set("Cache-Control", "s-maxage=60");
      return <p>{`${name}-run-${ran(name)}`}</p>;
    };

    /**
     * Two cacheable routes under one layout, behind the middleware. The
     * layout's loader, flagged or not, is what a prefetch from "/" defers; a
     * client on /doc holds the layout, so its prefetch of /doc/other defers
     * nothing.
     */
    function docCache(flagged: boolean) {
      const cacheStore = new CountingStore();
      const router = createRouter({ prefetchCacheTTL: false })
        .use(createDocumentCacheMiddleware())
        .routes(
          urls(({ path, layout, loader, loading }) => [
            path("/", page("doc-home"), { name: "home" }),
            layout(page("doc-layout"), () => [
              loader(ReviewsLoader, flagged ? { prefetch: false } : {}),
              loading(<p>doc-loading</p>),
              path("/doc", cacheable("doc"), { name: "doc" }),
              path("/doc/other", cacheable("doc-other"), { name: "docOther" }),
            ]),
          ]),
        );
      /** One request, with what it read from and wrote to the store. */
      const serve = async (
        partial: ServeShellRequestOptions["partial"],
        url = "/doc",
      ) => {
        const before = { reads: cacheStore.reads, writes: cacheStore.writes };
        const result = await serveShellRequest(router, url, {
          cacheStore,
          partial,
        });
        return {
          result,
          status: result.response.headers.get("x-document-cache-status"),
          reads: cacheStore.reads - before.reads,
          writes: cacheStore.writes - before.writes,
        };
      };
      return { serve };
    }

    it("a route with no flag reads the store once per request and shares one entry", async () => {
      const { serve } = docCache(false);
      // The prefetch warms what the navigation reads, and the other way
      // round: the two are the same body.
      expect(await serve({ from: "/", prefetch: true })).toMatchObject({
        status: "MISS",
        reads: 1,
        writes: 1,
      });
      const nav = await serve({ from: "/" });
      expect(nav).toMatchObject({ status: "HIT", reads: 1, writes: 0 });
      expect(await serve({ from: "/", prefetch: true })).toMatchObject({
        status: "HIT",
        reads: 1,
        writes: 0,
      });
      expect(await serve(undefined)).toMatchObject({
        status: "MISS",
        reads: 1,
        writes: 1,
      });
      expect({ doc: count("doc"), reviews: count("reviews") }).toEqual({
        doc: 2,
        reviews: 2,
      });
      expect(payloadOf(nav.result).deferred).toEqual([]);
    });

    it("a prefetch that defers writes nothing, and a navigation is never answered with it", async () => {
      const { serve } = docCache(true);
      for (let i = 0; i < 2; i++) {
        const prefetched = await serve({ from: "/", prefetch: true });
        // No status: the response is not one this cache stores.
        expect(prefetched).toMatchObject({
          status: null,
          reads: 1,
          writes: 0,
        });
        expect(payloadOf(prefetched.result).deferred).toHaveLength(1);
        expect(prefetched.result.response.headers.get("cache-control")).toBe(
          "private, no-cache",
        );
      }
      expect(count("reviews")).toBe(0);

      // A navigation with the same segments renders its own body.
      const nav = await serve({ from: "/" });
      expect(nav).toMatchObject({ status: "MISS", reads: 1, writes: 1 });
      expect(payloadOf(nav.result).deferred).toEqual([]);
      expect(count("reviews")).toBe(1);
      const navAgain = await serve({ from: "/" });
      expect(navAgain).toMatchObject({ status: "HIT", reads: 1, writes: 0 });
      expect(payloadOf(navAgain.result).deferred).toEqual([]);
      expect(count("reviews")).toBe(1);
    });

    it("a stored complete navigation body answers a later prefetch of a flagged route", async () => {
      const { serve } = docCache(true);
      expect((await serve({ from: "/" })).status).toBe("MISS");
      expect(count("reviews")).toBe(1);

      // Complete, so the click that adopts it sends no fill, and serving it
      // ran nothing.
      const prefetched = await serve({ from: "/", prefetch: true });
      expect(prefetched).toMatchObject({ status: "HIT", reads: 1, writes: 0 });
      expect(payloadOf(prefetched.result).deferred).toEqual([]);
      expect({ doc: count("doc"), reviews: count("reviews") }).toEqual({
        doc: 1,
        reviews: 1,
      });
    });

    it("a prefetch of a flagged tree that defers nothing is stored and served as any prefetch", async () => {
      const { serve } = docCache(true);
      const held = payloadOf((await serve({ from: "/" })).result).matched;
      const from = { from: "/doc", segments: held };

      const prefetched = await serve({ ...from, prefetch: true }, "/doc/other");
      expect(prefetched).toMatchObject({ status: "MISS", reads: 1, writes: 1 });
      expect(payloadOf(prefetched.result).deferred).toEqual([]);
      expect(
        await serve({ ...from, prefetch: true }, "/doc/other"),
      ).toMatchObject({ status: "HIT", reads: 1, writes: 0 });
      // The same body answers the navigation.
      const nav = await serve(from, "/doc/other");
      expect(nav).toMatchObject({ status: "HIT", reads: 1, writes: 0 });
      expect(payloadOf(nav.result).ids).toEqual(
        payloadOf(prefetched.result).ids,
      );
      expect(count("doc-other")).toBe(1);
    });

    it("a fill is never stored and never served from the cache", async () => {
      const { serve } = docCache(true);
      const prefetched = payloadOf(
        (await serve({ from: "/", prefetch: true })).result,
      );
      const held = prefetched.matched.filter(
        (id) => !prefetched.deferred.includes(id),
      );
      for (const expected of [1, 2]) {
        const filled = await serve({
          from: "/doc",
          segments: held,
          fill: true,
        });
        expect(filled).toMatchObject({ status: null, reads: 0, writes: 0 });
        expect(count("reviews")).toBe(expected);
        expect(filled.result.response.headers.get("cache-control")).toBe(
          "private, no-cache",
        );
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

  it("an intercept prefetch renders a flagged layout of its target's chain", async () => {
    const { prefetch } = setup();
    // The route is replaced by the intercept; the layouts above it are
    // resolved by the shared funnel, which is where a prefetch defers.
    const result = await prefetch("/gallery/1", "/");
    const payload = payloadOf(result);
    expect(result.flight).toContain("photo-modal-run-1");
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
    expect({
      layout: count("gallery"),
      loader: count("gallery-loader"),
      route: count("photo"),
    }).toEqual({ layout: 1, loader: 1, route: 0 });
  });

  it("control: the same target with no intercept to resolve defers its flagged layout", async () => {
    const { serve } = setup();
    // From the target itself nothing intercepts: an ordinary prefetch.
    const payload = payloadOf(
      await serve("/gallery/1", {
        partial: { from: "/gallery/2", segments: [], prefetch: true },
      }),
    );
    expect(payload.deferred.length).toBeGreaterThan(0);
    expect(count("gallery")).toBe(0);
  });

  describe("a flagged loader something else reads with ctx.use()", () => {
    it("a loader that reads it before its first await: one run, in the prefetch, nothing deferred", async () => {
      const { prefetch } = setup();
      const payload = payloadOf(await prefetch("/reads-early"));
      expect(count("early-dep")).toBe(1);
      expect(payload.deferred).toEqual([]);
      expect(present(payload.find(EarlyDepLoader.$$id)!.loaderData)).toBe(true);
    });

    it("a streamed handler that reads it before its first await: one run, nothing deferred", async () => {
      const { prefetch } = setup();
      const payload = payloadOf(await prefetch("/streamed-early"));
      expect(count("streamed-early-dep")).toBe(1);
      expect(payload.deferred).toEqual([]);
    });

    // The two late readers. The loader runs for its reader after resolution
    // has emitted its segment as deferred, so the fill runs it again: data is
    // never missing, only fetched twice.
    it.each([
      ["a loader that reads it after an await", "/reads-late", "late-dep"],
      [
        "a streamed handler that reads it after an await",
        "/streamed-late",
        "streamed-late-dep",
      ],
    ])(
      "%s: it runs in the prefetch and again in the fill",
      async (_l, url, dep) => {
        const { prefetch, fill } = setup();
        const prefetched = payloadOf(await prefetch(url));
        expect(count(dep)).toBe(1);
        expect(prefetched.deferred).toHaveLength(1);

        const filled = payloadOf(await fill(url, prefetched));
        expect(count(dep)).toBe(2);
        expect(filled.ids).toEqual(prefetched.deferred);
        expect(present(filled.segments[0]!.loaderData)).toBe(true);
      },
    );
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

// The rule: the flag applies only to a segment the client does not have yet.
// A segment the client holds is never deferred, whether or not it re-renders.
describe("the flag applies only to a segment the client does not have yet", () => {
  const resetRuns = (): void => {
    for (const key of Object.keys(runs)) delete runs[key];
  };

  /** Navigate to `at` from "/", then count from zero. Returns what the client holds. */
  async function standingOn(
    serve: ReturnType<typeof setup>["serve"],
    at: string,
  ): Promise<string[]> {
    const { matched } = payloadOf(await serve(at, { partial: { from: "/" } }));
    resetRuns();
    return matched;
  }

  it("a new flagged layout takes a sibling route with it, and one fill runs everything once", async () => {
    const { prefetch, fill } = setup();
    const prefetched = payloadOf(await prefetch("/section/plain"));
    expect({
      layout: count("section"),
      route: count("section-plain"),
      loader: count("section-plain-loader"),
    }).toEqual({ layout: 0, route: 0, loader: 0 });
    expect(
      prefetched.segments.filter((s) => s.type === "layout" && s.deferred),
    ).toEqual([expect.objectContaining({ component: null })]);
    expect(prefetched.segments.some((s) => s.type === "route")).toBe(false);
    expect(prefetched.find(SectionPlainLoader.$$id)).toBeUndefined();

    const filled = payloadOf(await fill("/section/plain", prefetched));
    expect({
      layout: count("section"),
      route: count("section-plain"),
      loader: count("section-plain-loader"),
    }).toEqual({ layout: 1, route: 1, loader: 1 });
    expect(filled.deferred).toEqual([]);
  });

  it("under a held flagged layout a plain sibling's handler and loader run in the prefetch: nothing is deferred", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/section/a");

    const result = await serve("/section/plain", {
      partial: { from: "/section/a", segments: held, prefetch: true },
    });
    const payload = payloadOf(result);
    expect({
      layout: count("section"),
      route: count("section-plain"),
      loader: count("section-plain-loader"),
    }).toEqual({ layout: 0, route: 1, loader: 1 });
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
    expect(present(payload.find(SectionPlainLoader.$$id)!.loaderData)).toBe(
      true,
    );
    // What a navigation sends for the same request.
    const navigation = payloadOf(
      await serve("/section/plain", {
        partial: { from: "/section/a", segments: held },
      }),
    );
    expect(payload.ids).toEqual(navigation.ids);
    expect(payload.matched).toEqual(navigation.matched);
  });

  it("under a held flagged layout a sibling with its own flagged loading() is still its own unit", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/section/a");

    const result = await serve("/section/own", {
      partial: { from: "/section/a", segments: held, prefetch: true },
    });
    const prefetched = payloadOf(result);
    expect({
      layout: count("section"),
      route: count("section-own"),
      loader: count("section-own-loader"),
    }).toEqual({ layout: 0, route: 0, loader: 0 });
    const route = prefetched.segments.find((s) => s.type === "route")!;
    expect(route).toMatchObject({ deferred: true, component: null });
    expect(result.flight).toContain("section-own-loading");
    expect(prefetched.find(SectionOwnLoader.$$id)).toMatchObject({
      deferred: true,
    });

    // The fill the browser sends: what it held, the placeholders left out.
    const filled = payloadOf(
      await serve("/section/own", {
        partial: {
          from: "/section/own",
          segments: prefetched.matched.filter(
            (id) => !prefetched.deferred.includes(id),
          ),
          fill: true,
        },
      }),
    );
    expect({
      layout: count("section"),
      route: count("section-own"),
      loader: count("section-own-loader"),
    }).toEqual({ layout: 0, route: 1, loader: 1 });
    expect(filled.deferred).toEqual([]);
  });

  it("a held flagged layout whose revalidate() returns true is rendered by the prefetch, as by a navigation", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/reval/a");

    const request = { from: "/reval/a", segments: held };
    const navigation = payloadOf(await serve("/reval/b", { partial: request }));
    expect({
      predicate: count("reval-predicate"),
      layout: count("reval"),
      route: count("reval-b"),
    }).toEqual({ predicate: 1, layout: 1, route: 1 });
    resetRuns();

    const result = await serve("/reval/b", {
      partial: { ...request, prefetch: true },
    });
    const payload = payloadOf(result);
    expect({
      predicate: count("reval-predicate"),
      layout: count("reval"),
      route: count("reval-b"),
    }).toEqual({ predicate: 1, layout: 1, route: 1 });
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
    expect(payload.ids).toEqual(navigation.ids);
    expect(payload.matched).toEqual(navigation.matched);
    expect(payload.diff).toEqual(navigation.diff);
    const layout = payload.segments.find((s) => s.type === "layout")!;
    expect(present(layout.component)).toBe(true);
  });

  it("a flagged loader on a held segment that revalidates runs in the prefetch", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/reval-loader");

    const result = await serve("/reval-loader", {
      partial: { from: "/reval-loader", segments: held, prefetch: true },
    });
    const payload = payloadOf(result);
    expect({
      predicate: count("reval-loader-predicate"),
      loader: count("reval-loader"),
    }).toEqual({ predicate: 1, loader: 1 });
    expect(payload.deferred).toEqual([]);
    expect(present(payload.find(RevalLoader.$$id)!.loaderData)).toBe(true);
  });

  it("the same route with new params: the prefetch runs the handler and the flagged loader, and defers nothing", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/product/1");

    const request = { from: "/product/1", segments: held };
    const navigation = payloadOf(
      await serve("/product/2", { partial: request }),
    );
    const afterNavigation = { ...runs };
    resetRuns();

    const result = await serve("/product/2", {
      partial: { ...request, prefetch: true },
    });
    const payload = payloadOf(result);
    expect(runs).toEqual(afterNavigation);
    expect(count("reviews")).toBe(1);
    expect(count("product")).toBe(1);
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
    expect(payload.ids).toEqual(navigation.ids);
  });

  // The match forces a same-route render from an intercept source by
  // dropping the route from the set resolution works on. "Held" is what the
  // request listed: deferring on the forced set skipped the handler of a
  // route the response then left out as held, and the click got nothing.
  it("a same-route prefetch from an intercept source renders the route the client holds", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/orders");

    const request = {
      headers: { "X-RSC-Router-Intercept-Source": "/orders" },
      partial: { from: "/orders", segments: held },
    };
    const navigation = payloadOf(await serve("/orders", request));
    const afterNavigation = { ...runs };
    expect(afterNavigation.orders, "the route is rendered again").toBe(1);
    resetRuns();

    const result = await serve("/orders", {
      ...request,
      partial: { ...request.partial, prefetch: true },
    });
    const payload = payloadOf(result);
    expect(runs).toEqual(afterNavigation);
    expect(payload.deferred).toEqual([]);
    expect(result.flight).not.toContain('"deferred"');
    expect(payload.ids).toEqual(navigation.ids);
  });

  it("a flagged loader on a new segment is still deferred when the layout above it is held", async () => {
    const { serve } = setup();
    const held = await standingOn(serve, "/elsewhere");

    const payload = payloadOf(
      await serve("/product/1", {
        partial: { from: "/elsewhere", segments: held, prefetch: true },
      }),
    );
    expect(count("reviews")).toBe(0);
    expect(count("price")).toBe(1);
    expect(payload.deferred).toEqual([payload.find(ReviewsLoader.$$id)!.id]);
  });
});

// A cache() route under a flagged layout must use its record the way the
// same route under an unflagged layout does (issue found in review: the
// record was skipped for every prefetch of the tree, not only for one that
// deferred the layout).
describe("a cache() route under a flagged layout uses its record like its unflagged twin", () => {
  it("held layout: three prefetches run the cached handler once and defer nothing", async () => {
    const { serve } = setup();
    const visit = async (section: string) => {
      const { matched } = payloadOf(
        await serve(`/${section}/a`, { partial: { from: "/" } }),
      );
      const deferred: string[][] = [];
      for (let i = 0; i < 3; i++) {
        const payload = payloadOf(
          await serve(`/${section}/cached`, {
            partial: {
              from: `/${section}/a`,
              segments: matched,
              prefetch: true,
            },
          }),
        );
        deferred.push(payload.deferred);
      }
      return deferred;
    };

    expect(await visit("twin")).toEqual([[], [], []]);
    expect(await visit("section")).toEqual([[], [], []]);
    expect({
      twin: count("twin-cached"),
      section: count("section-cached"),
    }).toEqual({ twin: 1, section: 1 });
    // Loaders are never stored: each prefetch ran them.
    expect(count("section-cached-loader")).toBe(count("twin-cached-loader"));
  });

  it("new layout: three prefetch-and-fill visits run the cached handler once", async () => {
    const { serve, prefetch, fill } = setup();
    for (let i = 0; i < 3; i++) {
      const prefetched = payloadOf(await prefetch("/section/cached"));
      // The layout is deferred, and the record below it with it.
      expect(prefetched.segments.some((s) => s.type === "route")).toBe(false);
      await fill("/section/cached", prefetched);
    }
    for (let i = 0; i < 3; i++) {
      await serve("/twin/cached", { partial: { from: "/" } });
    }
    expect({
      twin: count("twin-cached"),
      section: count("section-cached"),
    }).toEqual({ twin: 1, section: 1 });
    // The layouts are above the boundary: rendered on every visit, both.
    expect(count("section")).toBe(count("twin"));
  });

  it("a fill that holds part of what the record covers does not write it", async () => {
    const { serve, cacheStore } = setup();
    // /cached: cache() on the route, so the record covers the route alone.
    const prefetched = payloadOf(
      await serve("/cached", {
        partial: { from: "/", segments: [], prefetch: true },
      }),
    );
    const written = cacheStore.getStats().size;
    expect(written).toBeGreaterThan(0);
    await cacheStore.clear();
    // The fill holds the route: it renders the loader, not the record's part.
    await serve("/cached", {
      partial: {
        from: "/cached",
        segments: prefetched.matched.filter(
          (id) => !prefetched.deferred.includes(id),
        ),
        fill: true,
      },
    });
    expect(cacheStore.getStats().size).toBe(0);
    expect(count("cached")).toBe(1);
  });
});
