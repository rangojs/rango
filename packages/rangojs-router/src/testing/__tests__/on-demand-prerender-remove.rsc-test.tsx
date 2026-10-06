/**
 * Removing a refreshed page from on-demand prerender (#1060), through the
 * public testing primitives: `router.prerender()` runs the real requestless
 * producer, `prerender.remove()` writes the "removed" marker, and
 * `serveShellRequest` serves the route through the production request handler.
 *
 * The data source is `catalog`: a product a test deletes from it is one the
 * producer answers with `notFound()`. A removed page is a 404 until a refresh
 * renders it again, and a product that is back in the data source does not
 * come back by itself: only a refresh replaces the marker.
 *
 * The second half pins what the runtime caches around the route serve after a
 * removal, which the marker does not reach.
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
import { createMemoryPrerenderStore } from "../index.js";
import {
  cacheTag,
  createLoader,
  createRouter,
  notFound,
  Passthrough,
  Prerender,
  updateTag,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
} from "../../cache/index.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderResult,
} from "../../prerender/index.js";

/** The origin serveShellRequest resolves paths against. */
const ORIGIN = "http://localhost";

class SharedMemoryStore extends MemorySegmentCacheStore {
  readonly scope = "global" as const;
}

/** The data source: slug -> title. A missing slug is a deleted product. */
const catalog = new Map<string, string>();
const runs = { producer: 0, hot: 0, live: 0, loader: 0, plain: 0 };
/** Set to make the next producer run fail like an upstream outage. */
let outage = false;
/** Set to make `<Flaky>` throw: an outage in one part of a render. */
let flaky = false;

const StockLoader = createLoader(async () => {
  runs.loader += 1;
  return { stock: `stock-run${runs.loader}` };
});

/** Set to throw a not-found error another realm made (matched by name). */
let foreignNotFound = false;

function product(slug: string): string {
  if (outage) throw new Error("upstream 500");
  if (foreignNotFound) {
    throw Object.assign(new Error("gone"), { name: "DataNotFoundError" });
  }
  const title = catalog.get(slug);
  if (title === undefined) notFound(`no product ${slug}`);
  return title;
}

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const title = product(ctx.params.slug);
    runs.producer += 1;
    return <h1>{`${ctx.params.slug}:${title}:render-${runs.producer}`}</h1>;
  },
  { onDemand: { tags: ({ params }) => [`product:${params.slug}`] } },
);

// Stale as soon as written: every hit on a page, or on the marker of a
// refresh that hit notFound(), schedules onRevalidate.
const HotProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const title = product(ctx.params.slug);
    runs.hot += 1;
    return <h1>{`hot:${title}:render-${runs.hot}`}</h1>;
  },
  { onDemand: { ttl: 0 } },
);

// Where a notFound() can come from in a render, other than the route handler:
// a component in the tree (sync or async), a layout handler, a parallel slot.
function Title({ slug }: { slug: string }): React.ReactNode {
  return <h1>{`title:${product(slug)}`}</h1>;
}
async function AsyncTitle({
  slug,
}: {
  slug: string;
}): Promise<React.ReactNode> {
  await Promise.resolve();
  return <h1>{`title:${product(slug)}`}</h1>;
}
async function Flaky(): Promise<React.ReactNode> {
  await Promise.resolve();
  if (flaky) throw new Error("upstream 500");
  return <p>stock</p>;
}

/** An on-demand page whose handler reads nothing: its tree does. */
const tree = (render: (slug: string) => React.ReactNode) =>
  Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => render(ctx.params.slug),
    { onDemand: true },
  );
const SyncComponentDef = tree((slug) => <Title slug={slug} />);
const AsyncComponentDef = tree((slug) => <AsyncTitle slug={slug} />);
const StaticDef = tree((slug) => <h1>{`title:${slug}`}</h1>);
// A missing item and a failing data source in one render, in both orders.
const MissingThenFailingDef = tree((slug) => (
  <>
    <AsyncTitle slug={slug} />
    <Flaky />
  </>
));
const FailingThenMissingDef = tree((slug) => (
  <>
    <Flaky />
    <AsyncTitle slug={slug} />
  </>
));

function ProductLayout(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  return <header>{`layout:${product(ctx.params.slug)}`}</header>;
}
function ProductSlot(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  return <aside>{`slot:${product(ctx.params.slug)}`}</aside>;
}

const LiveProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`frozen:${product(ctx.params.slug)}`}</h1>,
  { onDemand: true },
);
const LiveProduct = Passthrough(LiveProductDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

// A Passthrough route whose build handler declines a missing item instead of
// calling notFound(): the live handler is meant to answer for it.
const DecliningDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const title = catalog.get(ctx.params.slug);
    if (title === undefined) return ctx.passthrough();
    return <h1>{`frozen:${title}`}</h1>;
  },
  { onDemand: true },
);
const Declining = Passthrough(DecliningDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

// A param the build bakes: serveShellRequest bakes what getParams() lists for
// a Passthrough route, as `vite build` does. The live handler answers
// notFound() for a deleted item, like the build handler.
const BakedDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => <h1>{`frozen:${product(ctx.params.slug)}`}</h1>,
  { onDemand: true },
);
const Baked = Passthrough(BakedDef, async (ctx) => (
  <h1>{`live:${product(ctx.params.slug)}`}</h1>
));

function PlainPage(): React.ReactNode {
  runs.plain += 1;
  return <p>{`plain-run${runs.plain}`}</p>;
}

let hookResult: PrerenderResult | undefined;

function makeRouter(
  prerender: PrerenderConfig,
  cacheStore?: MemorySegmentCacheStore,
) {
  const router = createRouter({
    prerender,
    ...(cacheStore
      ? {
          cache: { store: cacheStore },
          cacheProfiles: { default: { ttl: 300 } },
        }
      : {}),
  })
    .use("/doc/*", createDocumentCacheMiddleware())
    // The document opts in and carries the product's tag, as an app whose
    // pages are document-cached would set them.
    .use("/doc/*", async (ctx, next) => {
      ctx.header("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
      cacheTag(`product:${ctx.url.pathname.split("/").pop()}`);
      return next();
    })
    .routes(
      urls(({ path, loader, cache, layout, parallel }) => [
        path("/products/:slug", ProductDef, { name: "product" }),
        path("/hot/:slug", HotProductDef, { name: "hot" }),
        path("/live/:slug", LiveProduct, { name: "live" }),
        path("/declining/:slug", Declining, { name: "declining" }),
        path("/baked/:slug", Baked, { name: "baked" }),
        path("/plain", PlainPage, { name: "plain" }),
        path("/tree/sync/:slug", SyncComponentDef, { name: "treeSync" }),
        path("/tree/async/:slug", AsyncComponentDef, { name: "treeAsync" }),
        path("/tree/missing-failing/:slug", MissingThenFailingDef, {
          name: "treeMissingFailing",
        }),
        path("/tree/failing-missing/:slug", FailingThenMissingDef, {
          name: "treeFailingMissing",
        }),
        layout(ProductLayout, () => [
          path("/in-layout/:slug", StaticDef, { name: "inLayout" }),
        ]),
        layout(
          () => <header>chrome</header>,
          () => [
            parallel({ "@aside": ProductSlot }),
            path(
              "/with-slot/:slug",
              tree((slug) => <h1>{`title:${slug}`}</h1>),
              {
                name: "withSlot",
              },
            ),
          ],
        ),
        // The same page with a cached loader, under a route cache().
        cache({ ttl: 300 }, () => [
          path("/cached/:slug", ProductDef, { name: "cachedProduct" }, () => [
            loader(StockLoader, () => [cache({ ttl: 300 })]),
          ]),
        ]),
        path("/doc/:slug", ProductDef, { name: "docProduct" }),
        // A "product deleted" webhook: remove the page, then invalidate the
        // tag the cached document carries. In that order: see the tests.
        path(
          "/hooks/product-deleted/:slug",
          async (ctx: HandlerContext<{ slug: string }>) => {
            hookResult = await router
              .prerender({ env: ctx.env })
              .remove(`/doc/${ctx.params.slug}`);
            await updateTag(`product:${ctx.params.slug}`);
            return <p>{`hook-${hookResult.status}`}</p>;
          },
          { name: "productDeleted" },
        ),
        // The invalidation alone, so a test can put a visitor between it and
        // the removal. updateTag() needs a request, hence a route.
        path(
          "/hooks/invalidate/:slug",
          async (ctx: HandlerContext<{ slug: string }>) => {
            await updateTag(`product:${ctx.params.slug}`);
            return <p>invalidated</p>;
          },
          { name: "invalidate" },
        ),
      ]),
    );
  return router;
}

describe("on-demand prerender: removing a refreshed page", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    catalog.clear();
    catalog.set("a", "Alpha");
    catalog.set("b", "Beta");
    for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
    outage = false;
    flaky = false;
    foreignNotFound = false;
    hookResult = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prerender.remove(): the next request is a 404 until a refresh brings the page back", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const before = await serveShellRequest(router, "/products/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("a:Alpha:render-1");

    // The product is still in the data source: a removal does not wait for it.
    const removed = await prerender.remove("/products/a");
    expect(removed).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "removed",
      target: "/products/a",
      routeName: "product",
      tags: [],
    });
    // Nothing was rendered to remove it.
    expect(runs.producer).toBe(1);

    for (let i = 0; i < 2; i++) {
      const gone = await serveShellRequest(router, "/products/a");
      expect(gone.response.status).toBe(404);
      expect(gone.body).not.toContain("a:Alpha");
    }
    // Neither request rendered the page in place of the removed one.
    expect(runs.producer).toBe(1);
    // Its neighbor is untouched.
    await prerender("/products/b");
    expect((await serveShellRequest(router, "/products/b")).flight).toContain(
      "b:Beta:render-2",
    );

    catalog.set("a", "Alpha again");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
      tags: ["product:a"],
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha again:render-3");
    expect(store.size).toBe(2);
  });

  it("a refresh whose handler calls notFound() removes the page; a later refresh restores it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");
    expect((await serveShellRequest(router, "/products/a")).flight).toContain(
      "a:Alpha:render-1",
    );

    catalog.delete("a");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "removed",
      routeName: "product",
    });
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(404);

    // Back in the data source, not refreshed yet: the marker still answers.
    catalog.set("a", "Alpha returns");
    const stillGone = await serveShellRequest(router, "/products/a");
    expect(stillGone.response.status).toBe(404);
    expect(stillGone.body).not.toContain("Alpha returns");

    expect(await prerender("/products/a")).toMatchObject({
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha returns:render-2");
  });

  it("a refresh that fails any other way keeps serving the page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");

    outage = true;
    const failed = await prerender("/products/a");
    outage = false;

    expect(failed).toMatchObject({ ok: false, status: "render-failed" });
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:Alpha:render-1");
  });

  it("a sweep with onlyIfStale leaves a removed page removed", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");
    await prerender.remove("/products/a");

    const swept = await prerender.many(["/products/a", "/products/b"], {
      onlyIfStale: true,
    });

    expect(swept.map((r) => r.status)).toEqual(["removed", "rendered"]);
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(404);
  });

  it("a Passthrough route's removed page is answered by its live handler", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/live/a");
    expect((await serveShellRequest(router, "/live/a")).flight).toContain(
      "frozen:Alpha",
    );
    expect(runs.live).toBe(0);

    expect(await prerender.remove("/live/a")).toMatchObject({
      ok: true,
      status: "removed",
    });

    const live = await serveShellRequest(router, "/live/a");
    expect(live.response.status).toBe(200);
    expect(live.flight).toContain("live:a:run-1");
    expect(live.flight).not.toContain("frozen:Alpha");

    await prerender("/live/a");
    expect((await serveShellRequest(router, "/live/a")).flight).toContain(
      "frozen:Alpha",
    );
  });

  it("prerender.remove() refuses a route that is not on-demand, and renders nothing", async () => {
    const router = makeRouter({ store }, new SharedMemoryStore());

    const result = await router
      .prerender({ env: {}, origin: ORIGIN })
      .remove("/plain");

    expect(result).toEqual({
      ok: false,
      path: "on-demand",
      status: "skipped-not-on-demand",
      target: "/plain",
      routeName: "plain",
    });
    expect(runs.plain).toBe(0);
    expect(store.size).toBe(0);
  });

  it("prerender.remove.many(): one result per target, in input order", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender.many(["/products/a", "/products/b"]);

    const results = await prerender.remove.many(
      ["/products/a", "/nowhere", "/products/b", "/plain"],
      { concurrency: 2 },
    );

    expect(results.map((r) => r.status)).toEqual([
      "removed",
      "no-match",
      "removed",
      "skipped-not-on-demand",
    ]);
    for (const slug of ["a", "b"]) {
      expect(
        (await serveShellRequest(router, `/products/${slug}`)).response.status,
      ).toBe(404);
    }
  });

  describe("a notFound() anywhere in the render removes the page", () => {
    const cases: Array<[where: string, path: string]> = [
      ["the route handler", "/products/a"],
      ["a server component", "/tree/sync/a"],
      ["an async server component", "/tree/async/a"],
      ["a layout handler", "/in-layout/a"],
      ["a parallel slot handler", "/with-slot/a"],
    ];
    for (const [where, path] of cases) {
      it(where, async () => {
        const router = makeRouter({ store });
        const prerender = router.prerender({ env: {} });
        expect(await prerender(path)).toMatchObject({ status: "rendered" });
        expect((await serveShellRequest(router, path)).response.status).toBe(
          200,
        );

        catalog.delete("a");

        expect(await prerender(path)).toMatchObject({
          ok: true,
          status: "removed",
        });
        expect((await serveShellRequest(router, path)).response.status).toBe(
          404,
        );
      });
    }

    it("an error named DataNotFoundError from another realm counts too", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      await prerender("/products/a");

      foreignNotFound = true;

      expect(await prerender("/products/a")).toMatchObject({
        status: "removed",
      });
    });
  });

  describe("a failing data source never removes a page", () => {
    // One render that hits a missing item and an outage: the outage decides,
    // whichever component reports first. The page keeps serving.
    for (const path of ["/tree/missing-failing/a", "/tree/failing-missing/a"]) {
      it(`${path}: render-failed, and the page stays`, async () => {
        const router = makeRouter({ store });
        const prerender = router.prerender({ env: {} });
        expect(await prerender(path)).toMatchObject({ status: "rendered" });

        catalog.delete("a");
        flaky = true;
        const failed = await prerender(path);

        expect(failed).toMatchObject({ ok: false, status: "render-failed" });
        expect((failed as { error: Error }).error.message).toBe("upstream 500");
        const served = await serveShellRequest(router, path);
        expect(served.response.status).toBe(200);
        expect(served.flight).toContain("title:Alpha");

        // Without the outage the same render is a notFound(): removed.
        flaky = false;
        expect(await prerender(path)).toMatchObject({ status: "removed" });
      });
    }
  });

  describe("a notFound() removal is rechecked, a remove() is permanent", () => {
    it("the stale marker keeps answering 404 and schedules onRevalidate; an onlyIfStale refresh brings the page back", async () => {
      const onRevalidate = vi.fn();
      const router = makeRouter({ store, onRevalidate });
      const prerender = router.prerender({ env: {} });
      await prerender("/hot/a");

      // The data source loses the item for a moment.
      catalog.delete("a");
      expect(await prerender("/hot/a")).toMatchObject({
        ok: true,
        status: "removed",
        ttl: 0,
      });
      expect(onRevalidate).not.toHaveBeenCalled();

      // The route's ttl (0) has passed: the marker is stale. It still
      // answers, and the request schedules the recheck a stale page gets.
      const gone = await serveShellRequest(router, "/hot/a");
      expect(gone.response.status).toBe(404);
      expect(onRevalidate).toHaveBeenCalledTimes(1);
      expect(onRevalidate.mock.calls[0]![0]).toEqual({
        route: "hot",
        params: { slug: "a" },
      });

      // The recheck while the item is still missing: removed again.
      expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
        status: "removed",
      });

      // The item is back. The marker answers until the next recheck.
      catalog.set("a", "Alpha back");
      expect((await serveShellRequest(router, "/hot/a")).response.status).toBe(
        404,
      );
      expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const back = await serveShellRequest(router, "/hot/a");
      expect(back.response.status).toBe(200);
      expect(back.flight).toContain("hot:Alpha back");
    });

    it("remove(): no onRevalidate for the marker, and an onlyIfStale refresh leaves it", async () => {
      const onRevalidate = vi.fn();
      const router = makeRouter({ store, onRevalidate });
      const prerender = router.prerender({ env: {} });
      await prerender("/hot/a");
      await serveShellRequest(router, "/hot/a");
      // The stale page schedules it.
      expect(onRevalidate).toHaveBeenCalledTimes(1);
      const rendersBefore = runs.hot;

      await prerender.remove("/hot/a");
      const gone = await serveShellRequest(router, "/hot/a");

      expect(gone.response.status).toBe(404);
      expect(onRevalidate).toHaveBeenCalledTimes(1);
      // The documented onRevalidate wiring: it finds the marker and stops.
      expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
        ok: true,
        status: "removed",
      });
      expect(runs.hot).toBe(rendersBefore);
      // Only a refresh without onlyIfStale brings the page back.
      expect(await prerender("/hot/a")).toMatchObject({ status: "rendered" });
    });
  });

  describe("a page the build baked", () => {
    // What a delete in place of the marker would get wrong: the build-time
    // entry is still in the bundle, and would answer again.
    it("removed with remove(): a 404, not the build-time entry; a refresh brings a page back", async () => {
      catalog.set("baked", "Baked");
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      // Never refreshed: the build-time entry serves, and keeps serving.
      for (let i = 0; i < 2; i++) {
        const baked = await serveShellRequest(router, "/baked/baked");
        expect(baked.response.status).toBe(200);
        expect(baked.flight).toContain("frozen:Baked");
      }
      expect(store.size).toBe(0);

      catalog.delete("baked");
      expect(await prerender.remove("/baked/baked")).toMatchObject({
        ok: true,
        status: "removed",
      });

      for (let i = 0; i < 2; i++) {
        const gone = await serveShellRequest(router, "/baked/baked");
        expect(gone.response.status).toBe(404);
        expect(gone.body).not.toContain("frozen:Baked");
      }

      catalog.set("baked", "Baked again");
      expect(await prerender("/baked/baked")).toMatchObject({
        status: "rendered",
      });
      expect(
        (await serveShellRequest(router, "/baked/baked")).flight,
      ).toContain("frozen:Baked again");
    });

    it("removed by a refresh that hits notFound(): the same", async () => {
      catalog.set("baked", "Baked");
      const router = makeRouter({ store });
      expect(
        (await serveShellRequest(router, "/baked/baked")).flight,
      ).toContain("frozen:Baked");

      catalog.delete("baked");
      expect(await router.prerender({ env: {} })("/baked/baked")).toMatchObject(
        { ok: true, status: "removed" },
      );

      const gone = await serveShellRequest(router, "/baked/baked");
      expect(gone.response.status).toBe(404);
      expect(gone.body).not.toContain("frozen:Baked");
    });
  });

  it("a Passthrough route whose build handler declines with ctx.passthrough(): the live handler answers, not the page stored earlier", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/declining/a");
    expect((await serveShellRequest(router, "/declining/a")).flight).toContain(
      "frozen:Alpha",
    );

    catalog.delete("a");
    expect(await prerender("/declining/a")).toMatchObject({
      ok: false,
      status: "skipped-passthrough",
    });

    const live = await serveShellRequest(router, "/declining/a");
    expect(live.flight).toContain("live:a:run-1");
    expect(live.flight).not.toContain("frozen:Alpha");
  });

  describe("what the route's runtime caches serve after a removal", () => {
    it("a route cache() and a loader's own cache() do not bring the page back: the request is a 404", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      const prerender = router.prerender({ env: {}, origin: ORIGIN });
      // The refresh is followed by its warm, which fills the loader's cache.
      expect(await prerender("/cached/a")).toMatchObject({
        status: "rendered",
        caches: { writes: { item: 1 } },
      });
      const cached = await serveShellRequest(router, "/cached/a");
      expect(cached.flight).toContain("a:Alpha:render-1");
      expect(cached.flight).toContain("stock-run1");

      const removed = await prerender.remove("/cached/a");

      // No warm follows a removal: there is no page to rebuild a cache on.
      expect(removed).toMatchObject({ ok: true, status: "removed" });
      expect(removed).not.toHaveProperty("caches");
      const gone = await serveShellRequest(router, "/cached/a");
      expect(gone.response.status).toBe(404);
      expect(gone.body).not.toContain("a:Alpha");
    });

    it("the document cache serves the document it stored until that entry is invalidated or expires", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      const prerender = router.prerender({ env: {}, origin: ORIGIN });
      // The warm after the refresh stores the document.
      expect(await prerender("/doc/a")).toMatchObject({
        status: "rendered",
        caches: { document: "stored" },
      });
      const hit = await serveShellRequest(router, "/doc/a");
      expect(hit.response.headers.get("x-document-cache-status")).toBe("HIT");

      await prerender.remove("/doc/a");

      // The document cache answers ahead of the router: it never sees the
      // marker. This is the entry the removal has to be paired with an
      // invalidation for (the next tests). A queue or cron has no request to
      // call updateTag() from, so there it serves until it expires.
      const stale = await serveShellRequest(router, "/doc/a");
      expect(stale.response.status).toBe(200);
      expect(stale.response.headers.get("x-document-cache-status")).toBe("HIT");
      expect(stale.body).toContain("a:Alpha:render-1");
    });

    /** Refresh /doc/a and confirm the document cache holds it. */
    async function documentCached(router: ReturnType<typeof makeRouter>) {
      await router.prerender({ env: {}, origin: ORIGIN })("/doc/a");
      const hit = await serveShellRequest(router, "/doc/a");
      expect(hit.response.headers.get("x-document-cache-status")).toBe("HIT");
    }

    it("prerender.remove(url), then updateTag(tag): the next request is a 404", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      await documentCached(router);

      await serveShellRequest(router, "/hooks/product-deleted/a");

      expect(hookResult).toMatchObject({ ok: true, status: "removed" });
      for (let i = 0; i < 2; i++) {
        const gone = await serveShellRequest(router, "/doc/a");
        expect(gone.response.status).toBe(404);
        expect(gone.body).not.toContain("a:Alpha");
      }
    });

    it("in that order a visitor between the two calls cannot bring the page back", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      await documentCached(router);

      await router.prerender({ env: {} }).remove("/doc/a");
      // Between the calls: still the stored document. A request that reached
      // the router instead would find the marker, and a 404 is not stored.
      const between = await serveShellRequest(router, "/doc/a");
      expect(between.response.status).toBe(200);
      expect(between.response.headers.get("x-document-cache-status")).toBe(
        "HIT",
      );
      await serveShellRequest(router, "/hooks/invalidate/a");

      for (let i = 0; i < 2; i++) {
        const gone = await serveShellRequest(router, "/doc/a");
        expect(gone.response.status).toBe(404);
        expect(gone.body).not.toContain("a:Alpha");
      }
    });

    it("the reverse order, updateTag(tag) then remove(url), lets that visitor put the removed page back in the document cache", async () => {
      // Why the order matters. After the invalidation the page is still in
      // the prerender store, so the visitor is served it and the document
      // cache stores it again; the removal that follows cannot reach it.
      const router = makeRouter({ store }, new SharedMemoryStore());
      await documentCached(router);

      await serveShellRequest(router, "/hooks/invalidate/a");
      const between = await serveShellRequest(router, "/doc/a");
      expect(between.response.status).toBe(200);
      expect(between.response.headers.get("x-document-cache-status")).toBe(
        "MISS",
      );
      await router.prerender({ env: {} }).remove("/doc/a");

      for (let i = 0; i < 2; i++) {
        const back = await serveShellRequest(router, "/doc/a");
        expect(back.response.status).toBe(200);
        expect(back.response.headers.get("x-document-cache-status")).toBe(
          "HIT",
        );
        expect(back.body).toContain("a:Alpha");
      }
    });

    it("a Passthrough route's live handler serves through its own caches, as for a page never refreshed", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      const prerender = router.prerender({ env: {} });
      await prerender("/live/a");
      await prerender.remove("/live/a");

      const first = await serveShellRequest(router, "/live/a");
      const second = await serveShellRequest(router, "/live/a");

      // No cache() on the route: the live handler runs for each request.
      expect(first.flight).toContain("live:a:run-1");
      expect(second.flight).toContain("live:a:run-2");
    });
  });
});
