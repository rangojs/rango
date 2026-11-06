/**
 * A refresh whose render redirects, through the public testing primitives:
 * `router.prerender()` runs the real requestless producer, and
 * `serveShellRequest` serves the route through the production request handler.
 *
 * A page that moved is not a page: the refresh stores the redirect in place of
 * the page, and every request shape answers with it (a document GET, a client
 * navigation, an action's re-render) instead of the page or the build-time
 * entry under it. A later refresh that renders a page replaces the redirect.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import { createMemoryPrerenderStore } from "../index.js";
import {
  createRouter,
  notFound,
  Prerender,
  redirect,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderResult,
} from "../../prerender/index.js";

const runs = { producer: 0, layout: 0 };

/** What the data source says for a slug: a page title, or where it moved. */
type Item = { title: string } | { movedTo: string } | null;
const catalog = new Map<string, Item>();
/** Set to make a redirect carry location state (a flash message). */
let flash = false;
/** Set to make a redirect off-host. */
let external = false;

function item(slug: string): Item {
  return catalog.get(slug) ?? null;
}

/** The route handler: a page, a redirect for a moved item, a 404 for a gone one. */
function page(slug: string): React.ReactNode {
  const found = item(slug);
  if (found === null) notFound(`no item ${slug}`);
  if ("movedTo" in found) {
    if (flash) {
      return redirect(found.movedTo, {
        status: 301,
        state: [{} as never],
      }) as never;
    }
    if (external) {
      return redirect(found.movedTo, {
        status: 301,
        external: true,
      }) as never;
    }
    return redirect(found.movedTo, 301) as never;
  }
  runs.producer += 1;
  return <h1>{`${slug}:${found.title}:render-${runs.producer}`}</h1>;
}

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => page(ctx.params.slug),
  { onDemand: { ttl: 3600, tags: ({ params }) => [`item:${params.slug}`] } },
);

/**
 * A redirect from a layout handler rather than the route's: the render's
 * redirect counts wherever a handler produces one, as a `notFound()` does.
 */
function MovedLayout(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  const found = item(ctx.params.slug);
  if (found !== null && "movedTo" in found) {
    runs.layout += 1;
    return redirect(found.movedTo, 302) as never;
  }
  return <header>chrome</header>;
}

const LayoutDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`in-layout:${ctx.params.slug}`}</h1>,
  { onDemand: true },
);

function PlainPage(): React.ReactNode {
  return <p>target</p>;
}

function makeRouter(prerender: PrerenderConfig) {
  const router = createRouter({ prerender }).routes(
    urls(({ path, layout }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      layout(MovedLayout, () => [
        path("/in-layout/:slug", LayoutDef, { name: "inLayout" }),
      ]),
      path("/target", PlainPage, { name: "target" }),
      path(
        "/trigger/:slug",
        async (ctx: HandlerContext<{ slug: string }>) => {
          hookResult = await router.prerender({ env: ctx.env })(
            `/products/${ctx.params.slug}`,
          );
          return <p>{hookResult.status}</p>;
        },
        { name: "trigger" },
      ),
    ]),
  );
  return router;
}

let hookResult: PrerenderResult | undefined;

describe("on-demand prerender: a refresh whose render redirects", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    catalog.clear();
    catalog.set("a", { title: "Alpha" });
    catalog.set("moved", { movedTo: "/target" });
    for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
    flash = false;
    external = false;
    hookResult = undefined;
  });

  it("stores the redirect in place of the page and answers every request shape with it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:Alpha:render-1");

    // The item moved: the refresh stores the redirect, not a page and not a
    // "removed" marker (a visitor who bookmarked the old URL must land on the
    // new one, not on a 404).
    catalog.set("a", { movedTo: "/target" });
    const refreshed = await prerender("/products/a");
    expect(refreshed).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      location: "/target",
      tags: ["item:a"],
      ttl: 3600,
    });

    // A document GET: the redirect, with no page in it.
    const document = await serveShellRequest(router, "/products/a");
    expect(document.response.status).toBe(301);
    expect(document.response.headers.get("Location")).toBe("/target");
    expect(document.body).not.toContain("a:Alpha");

    // A client navigation: the soft form of the same redirect (a 3xx would be
    // auto-followed by fetch and render HTML the client cannot parse).
    const partial = await serveShellRequest(router, "/products/a", {
      partial: { from: "/products/b" },
    });
    expect(partial.response.status).toBe(204);
    // Resolved server-side, as the wire form of every soft redirect is.
    expect(partial.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/target",
    );
    expect(partial.response.headers.get("Location")).toBeNull();

    // The page was replaced, not merely shadowed: nothing renders again.
    expect(runs.producer).toBe(1);

    // A later refresh that renders a page replaces the redirect.
    catalog.set("a", { title: "Alpha again" });
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha again:render-2");
  });

  it("a redirect from a layout handler is stored like the route handler's", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    catalog.set("a", { movedTo: "/target" });

    expect(await prerender("/in-layout/a")).toMatchObject({
      ok: true,
      status: "redirected",
      routeName: "inLayout",
      location: "/target",
    });
    expect(runs.layout).toBe(1);

    const served = await serveShellRequest(router, "/in-layout/a");
    expect(served.response.status).toBe(302);
    expect(served.response.headers.get("Location")).toBe("/target");
  });

  it("a redirect carrying location state is per-visitor: skipped-personalized, and the page keeps serving", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(200);

    catalog.set("a", { movedTo: "/target" });
    flash = true;
    expect(await prerender("/products/a")).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "skipped-personalized",
      routeName: "product",
    });
    // Nothing was written: the previous page is still the entry.
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:Alpha:render-1");
  });

  it("an off-host redirect keeps its { external: true } opt-in through the store", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    catalog.set("a", { movedTo: "https://accounts.example.com/oauth" });
    external = true;

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "redirected",
      location: "https://accounts.example.com/oauth",
    });
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(301);
    expect(served.response.headers.get("Location")).toBe(
      "https://accounts.example.com/oauth",
    );
  });

  it("onlyIfStale leaves a fresh redirect alone and reports it; a stale one renders again", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    catalog.set("a", { movedTo: "/target" });
    await prerender("/products/a");
    const renders = runs.producer;

    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      {
        ok: true,
        status: "redirected",
        location: "/target",
      },
    );
    expect(runs.producer).toBe(renders);

    // Stale (a markStale() on the route's tag), and no longer moved: the
    // sweep renders the page and the redirect is gone.
    catalog.set("a", { title: "Alpha home" });
    await prerender.markStale(["item:a"]);
    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      { ok: true, status: "rendered" },
    );
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha home");
  });

  it("a refresh inside an action stores the redirect, and the action's re-render is the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");

    catalog.set("a", { movedTo: "/target" });
    const served = await serveShellRequest(router, "/trigger/a");
    expect(served.body).toContain("redirected");
    expect(hookResult).toMatchObject({ ok: true, status: "redirected" });

    const after = await serveShellRequest(router, "/products/a");
    expect(after.response.status).toBe(301);
    expect(after.response.headers.get("Location")).toBe("/target");
  });
});
