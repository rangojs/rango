/**
 * An on-demand refresh whose render answers `redirect()`, through the public
 * testing primitives: `router.prerender()` runs the real requestless
 * producer and `serveShellRequest` serves the route through the production
 * request handler.
 *
 * The data source is `moves`: a slug a test moves there is one whose handler
 * now throws `redirect()` to the new slug. The refresh stores that redirect
 * in place of the page, so a request is redirected, for a page a refresh
 * stored and for one the build baked, on a Passthrough route too, until a
 * refresh renders the page again. The stored redirect carries the route's
 * ttl and tags and is rechecked like the page it replaced.
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
  createRouter,
  Passthrough,
  Prerender,
  redirect,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
} from "../../prerender/index.js";

/** slug -> where its page moved: a path, or a full URL (`external`). */
const moves = new Map<string, string>();
const runs = { producer: 0, hot: 0, live: 0, layout: 0 };
/** Make the next redirect an off-host one with `{ external: true }`. */
let external = false;

/** A `moves` value that makes the handler throw a 410 Response instead. */
const GONE_410 = "410";

/** Throws the redirect a moved slug answers with. */
function followMove(slug: string, status?: number): void {
  const to = moves.get(slug);
  if (to === undefined) return;
  if (to === GONE_410) throw new Response("gone", { status: 410 });
  throw external
    ? redirect(to, { status, external: true })
    : redirect(to, status);
}

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    followMove(ctx.params.slug, 301);
    runs.producer += 1;
    return <h1>{`${ctx.params.slug}:render-${runs.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.slug}`] } },
);

// Stale as soon as written: every request schedules onRevalidate.
const HotDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    followMove(ctx.params.slug);
    runs.hot += 1;
    return <h1>{`hot:${ctx.params.slug}:render-${runs.hot}`}</h1>;
  },
  { onDemand: { ttl: 0 } },
);

// A param the build bakes (serveShellRequest bakes what getParams() lists for
// a Passthrough route, as `vite build` does), with a live handler for the rest.
const BakedDef = Prerender<{ slug: string }>(
  async () => [{ slug: "baked" }],
  async (ctx) => {
    followMove(ctx.params.slug);
    return <h1>{`frozen:${ctx.params.slug}`}</h1>;
  },
  { onDemand: true },
);
const Baked = Passthrough(BakedDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

// The page's handler reads nothing; its layout redirects.
const InLayoutDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`in-layout:${ctx.params.slug}`}</h1>,
  { onDemand: true },
);
function MovingLayout(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  runs.layout += 1;
  followMove(ctx.params.slug);
  return <header>chrome</header>;
}

// The handler's result streams behind loading(): its redirect surfaces while
// the payload serializes, where a request renders it as an error.
const StreamedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    await Promise.resolve();
    followMove(ctx.params.slug);
    return <h1>{`streamed:${ctx.params.slug}`}</h1>;
  },
  { onDemand: true },
);

function makeRouter(prerender: PrerenderConfig, basename?: string) {
  return createRouter({ prerender, ...(basename ? { basename } : {}) }).routes(
    urls(({ path, layout, loading }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/hot/:slug", HotDef, { name: "hot" }),
      path("/baked/:slug", Baked, { name: "baked" }),
      layout(MovingLayout, () => [
        path("/in-layout/:slug", InLayoutDef, { name: "inLayout" }),
      ]),
      path("/streamed/:slug", StreamedDef, { name: "streamed" }, () => [
        loading(<p>loading</p>),
      ]),
    ]),
  );
}

describe("on-demand prerender: a refresh whose render answers redirect()", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    moves.clear();
    external = false;
    for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the redirect in place of the page: a document request is redirected, not served the old page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    expect((await serveShellRequest(router, "/products/a")).flight).toContain(
      "a:render-1",
    );

    moves.set("a", "/products/b");
    const result = await prerender("/products/a");
    expect(result).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      tags: ["product:a"],
      ttl: 3600,
    });
    // No page to warm a cache on.
    expect(result).not.toHaveProperty("caches");

    for (let i = 0; i < 2; i++) {
      const moved = await serveShellRequest(router, "/products/a");
      expect(moved.response.status).toBe(301);
      expect(moved.response.headers.get("location")).toBe("/products/b");
      expect(moved.body).not.toContain("a:render-1");
    }
    // Neither request rendered the page: the store answered.
    expect(runs.producer).toBe(1);
    // Its neighbor is untouched.
    await prerender("/products/c");
    expect((await serveShellRequest(router, "/products/c")).flight).toContain(
      "c:render-2",
    );
  });

  it("a client navigation and a server action are answered with the soft redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");

    moves.set("a", "/products/b");
    await prerender("/products/a");

    const navigation = await serveShellRequest(router, "/products/a", {
      partial: true,
    });
    expect(navigation.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/products/b",
    );
    expect(navigation.flight).toBeUndefined();

    // The action's re-render of the page it was called from.
    const noop = async (): Promise<string> => "done";
    const action = await serveShellRequest(router, "/products/a", {
      action: { ref: noop, id: "products#noop" },
    });
    expect(action.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/products/b",
    );
  });

  it("a refresh that renders the page again replaces the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");
    moves.set("a", "/products/b");
    await prerender("/products/a");
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(301);

    // Moved back, not refreshed yet: the stored redirect still answers.
    moves.delete("a");
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(301);

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:render-2");
    expect(store.size).toBe(1);
  });

  it("a page the build baked is redirected, ahead of its build-time entry and the Passthrough route's live handler", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    // Never refreshed: the build-time entry serves.
    expect((await serveShellRequest(router, "/baked/baked")).flight).toContain(
      "frozen:baked",
    );
    expect(store.size).toBe(0);

    moves.set("baked", "/baked/elsewhere");
    expect(await prerender("/baked/baked")).toMatchObject({
      ok: true,
      status: "redirected",
    });

    const moved = await serveShellRequest(router, "/baked/baked");
    expect(moved.response.status).toBe(302);
    expect(moved.response.headers.get("location")).toBe("/baked/elsewhere");
    expect(moved.body).not.toContain("frozen:baked");
    expect(runs.live).toBe(0);

    // A param only a refresh produced: the same, ahead of the live handler.
    moves.set("fresh", "/baked/elsewhere");
    expect(await prerender("/baked/fresh")).toMatchObject({
      status: "redirected",
    });
    expect(
      (await serveShellRequest(router, "/baked/fresh")).response.status,
    ).toBe(302);
    expect(runs.live).toBe(0);
    // Unmoved, unrefreshed: the live handler answers, as before.
    expect((await serveShellRequest(router, "/baked/other")).flight).toContain(
      "live:other:run-1",
    );
  });

  it("a layout handler's redirect is stored too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    expect(await prerender("/in-layout/a")).toMatchObject({
      status: "rendered",
    });

    moves.set("a", "/in-layout/b");
    expect(await prerender("/in-layout/a")).toMatchObject({
      ok: true,
      status: "redirected",
    });
    const layoutRuns = runs.layout;
    const moved = await serveShellRequest(router, "/in-layout/a");
    expect(moved.response.status).toBe(302);
    expect(moved.response.headers.get("location")).toBe("/in-layout/b");
    // The stored redirect answers before any handler runs.
    expect(runs.layout).toBe(layoutRuns);
  });

  it("a redirect a streamed handler answers is render-failed, and the page keeps serving", async () => {
    // A request renders that redirect into the stream as an error, not as a
    // 3xx, so a refresh does not store it either.
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    expect(await prerender("/streamed/a")).toMatchObject({
      status: "rendered",
    });

    moves.set("a", "/streamed/b");
    const failed = await prerender("/streamed/a");

    expect(failed).toMatchObject({ ok: false, status: "render-failed" });
    expect((failed as { error: unknown }).error).toBeInstanceOf(Response);
    const served = await serveShellRequest(router, "/streamed/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("streamed:a");
  });

  it("a Response that is not a redirect is render-failed, and the page keeps serving", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");

    moves.set("a", GONE_410);
    const failed = await prerender("/products/a");

    expect(failed).toMatchObject({ ok: false, status: "render-failed" });
    expect((failed as { error: Response }).error.status).toBe(410);
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:render-1");
  });

  describe("rechecked like the page it replaced", () => {
    it("a stale redirect still answers and schedules onRevalidate; once the page is back, an onlyIfStale refresh renders it", async () => {
      const onRevalidate = vi.fn();
      const router = makeRouter({ store, onRevalidate });
      const prerender = router.prerender({ env: {} });
      await prerender("/hot/a");

      moves.set("a", "/hot/b");
      expect(await prerender("/hot/a")).toMatchObject({
        ok: true,
        status: "redirected",
        ttl: 0,
      });
      expect(onRevalidate).not.toHaveBeenCalled();

      // The route's ttl (0) has passed: the redirect is stale. It still
      // answers, and the request schedules the recheck a stale page gets.
      const moved = await serveShellRequest(router, "/hot/a");
      expect(moved.response.status).toBe(302);
      expect(onRevalidate).toHaveBeenCalledTimes(1);
      expect(onRevalidate.mock.calls[0]![0]).toEqual({
        route: "hot",
        params: { slug: "a" },
      });

      // The recheck while it is still moved: redirected again.
      expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
        status: "redirected",
      });

      moves.delete("a");
      expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const back = await serveShellRequest(router, "/hot/a");
      expect(back.response.status).toBe(200);
      expect(back.flight).toContain("hot:a:render-2");
    });

    it("onlyIfStale leaves a fresh redirect, and renders again once markStale reaches it through the route's tags", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      await prerender("/products/a");
      moves.set("a", "/products/b");
      await prerender("/products/a");
      moves.delete("a");

      expect(
        await prerender("/products/a", { onlyIfStale: true }),
      ).toMatchObject({
        ok: true,
        status: "redirected",
        tags: ["product:a"],
        ttl: 3600,
      });
      expect(runs.producer).toBe(1);
      expect(
        (await serveShellRequest(router, "/products/a")).response.status,
      ).toBe(301);

      await prerender.markStale(["product:a"]);
      expect(
        await prerender("/products/a", { onlyIfStale: true }),
      ).toMatchObject({ status: "rendered" });
      expect(
        (await serveShellRequest(router, "/products/a")).response.status,
      ).toBe(200);
    });
  });

  describe("the redirect a request gets is the one a live render answers", () => {
    it("redirect(url, { external: true }) keeps its opt-in through the store", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      moves.set("a", "https://shop.example/products/a");
      external = true;
      expect(await prerender("/products/a")).toMatchObject({
        status: "redirected",
      });

      const moved = await serveShellRequest(router, "/products/a");
      expect(moved.response.status).toBe(301);
      expect(moved.response.headers.get("location")).toBe(
        "https://shop.example/products/a",
      );
    });

    it("an off-host redirect without the opt-in lands on the app root, as the guard lands a live one", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      moves.set("a", "https://shop.example/products/a");
      expect(await prerender("/products/a")).toMatchObject({
        status: "redirected",
      });

      const moved = await serveShellRequest(router, "/products/a");
      expect(moved.response.status).toBe(301);
      expect(moved.response.headers.get("location")).toBe("/");
    });

    it("a root-relative redirect carries the router's basename", async () => {
      const router = makeRouter({ store }, "/shop");
      const prerender = router.prerender({ env: {} });
      moves.set("a", "/products/b");
      expect(await prerender("/shop/products/a")).toMatchObject({
        status: "redirected",
      });

      const moved = await serveShellRequest(router, "/shop/products/a");
      expect(moved.response.status).toBe(301);
      expect(moved.response.headers.get("location")).toBe("/shop/products/b");
    });
  });
});
