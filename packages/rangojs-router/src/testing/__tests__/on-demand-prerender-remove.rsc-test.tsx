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
const runs = { producer: 0, live: 0, loader: 0, plain: 0 };
/** Set to make the next producer run fail like an upstream outage. */
let outage = false;

const StockLoader = createLoader(async () => {
  runs.loader += 1;
  return { stock: `stock-run${runs.loader}` };
});

function product(slug: string): string {
  if (outage) throw new Error("upstream 500");
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

// Stale as soon as written: every hit on a page would schedule onRevalidate.
const HotProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`hot:${product(ctx.params.slug)}`}</h1>,
  { onDemand: { ttl: 0 } },
);

const LiveProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`frozen:${product(ctx.params.slug)}`}</h1>,
  { onDemand: true },
);
const LiveProduct = Passthrough(LiveProductDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

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
      urls(({ path, loader, cache }) => [
        path("/products/:slug", ProductDef, { name: "product" }),
        path("/hot/:slug", HotProductDef, { name: "hot" }),
        path("/live/:slug", LiveProduct, { name: "live" }),
        path("/plain", PlainPage, { name: "plain" }),
        // The same page with a cached loader, under a route cache().
        cache({ ttl: 300 }, () => [
          path("/cached/:slug", ProductDef, { name: "cachedProduct" }, () => [
            loader(StockLoader, () => [cache({ ttl: 300 })]),
          ]),
        ]),
        path("/doc/:slug", ProductDef, { name: "docProduct" }),
        // A "product deleted" webhook: invalidate the tag the document
        // carries, then remove the page.
        path(
          "/hooks/product-deleted/:slug",
          async (ctx: HandlerContext<{ slug: string }>) => {
            await updateTag(`product:${ctx.params.slug}`);
            hookResult = await router
              .prerender({ env: ctx.env })
              .remove(`/doc/${ctx.params.slug}`);
            return <p>{`hook-${hookResult.status}`}</p>;
          },
          { name: "productDeleted" },
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

  it("a removed page schedules no onRevalidate", async () => {
    const onRevalidate = vi.fn();
    const router = makeRouter({ store, onRevalidate });
    const prerender = router.prerender({ env: {} });
    await prerender("/hot/a");
    await serveShellRequest(router, "/hot/a");
    // The stale page schedules it.
    expect(onRevalidate).toHaveBeenCalledTimes(1);

    await prerender.remove("/hot/a");
    const gone = await serveShellRequest(router, "/hot/a");

    expect(gone.response.status).toBe(404);
    expect(onRevalidate).toHaveBeenCalledTimes(1);
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
      // invalidation for (the next test).
      const stale = await serveShellRequest(router, "/doc/a");
      expect(stale.response.status).toBe(200);
      expect(stale.response.headers.get("x-document-cache-status")).toBe("HIT");
      expect(stale.body).toContain("a:Alpha:render-1");
    });

    it("updateTag(tag), then prerender.remove(url): the next request is a 404", async () => {
      const router = makeRouter({ store }, new SharedMemoryStore());
      await router.prerender({ env: {}, origin: ORIGIN })("/doc/a");
      expect(
        (await serveShellRequest(router, "/doc/a")).response.headers.get(
          "x-document-cache-status",
        ),
      ).toBe("HIT");

      await serveShellRequest(router, "/hooks/product-deleted/a");

      expect(hookResult).toMatchObject({ ok: true, status: "removed" });
      for (let i = 0; i < 2; i++) {
        const gone = await serveShellRequest(router, "/doc/a");
        expect(gone.response.status).toBe(404);
        expect(gone.body).not.toContain("a:Alpha");
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
