/**
 * A refreshed page that starts answering `redirect()`, through the public
 * testing primitives: `router.prerender()` runs the real requestless producer,
 * and `serveShellRequest` serves the route through the production request
 * handler, which reads the overlay before the bundled manifest.
 *
 * A redirect is not a failed render and not a removal: the page is somewhere
 * else, so the refresh stores the redirect in place of the page and a request
 * gets it (a document request the 3xx, a client navigation `X-RSC-Redirect`)
 * instead of the page it replaced. A later refresh replaces it again.
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
  notFound,
  Passthrough,
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

/** The origin serveShellRequest resolves paths against. */
const ORIGIN = "http://localhost";

/** The data source: slug -> title. A missing slug is a deleted product. */
const titles = new Map<string, string>();
/** slug -> the URL its producer redirects to instead of rendering. */
const movedTo = new Map<string, string>();
/** Set to make the next redirect off-host (`redirect(url, { external: true })`). */
let external = false;
const runs = { producer: 0 };

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const target = movedTo.get(ctx.params.slug);
    if (target !== undefined) {
      runs.producer += 1;
      // The Prerender handler's type returns a ReactNode, so a redirect is
      // thrown: the shape a Response takes everywhere in the router once a
      // handler answers with one (handleHandlerResult throws a returned one).
      throw redirect(
        target,
        external ? { status: 302, external: true } : { status: 301 },
      );
    }
    const title = titles.get(ctx.params.slug);
    if (title === undefined) notFound(`no product ${ctx.params.slug}`);
    runs.producer += 1;
    return <h1>{`${ctx.params.slug}:${title}:render-${runs.producer}`}</h1>;
  },
  {
    onDemand: {
      ttl: 3600,
      tags: ({ params }) => [`product:${params.slug}`],
    },
  },
);

// Stale as soon as written: every hit on a page, or on a redirect a refresh
// stored in its place, schedules onRevalidate.
const HotDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const target = movedTo.get(ctx.params.slug);
    if (target !== undefined) throw redirect(target);
    return <h1>{`hot:${ctx.params.slug}`}</h1>;
  },
  { onDemand: { ttl: 0 } },
);

// A Passthrough route: its live handler answers a param with no stored entry,
// and the overlay answers once a refresh has stored one.
const LiveDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const target = movedTo.get(ctx.params.slug);
    if (target !== undefined) throw redirect(target);
    return <h1>{`frozen:${ctx.params.slug}`}</h1>;
  },
  { onDemand: true },
);
const Live = Passthrough(
  LiveDef,
  async (ctx: HandlerContext<{ slug: string }>) => {
    const target = movedTo.get(ctx.params.slug);
    if (target !== undefined) throw redirect(target);
    return <h1>{`live:${ctx.params.slug}`}</h1>;
  },
);

function makeRouter(prerender: PrerenderConfig) {
  return createRouter({ prerender }).routes(
    urls(({ path }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/hot/:slug", HotDef, { name: "hot" }),
      path("/live/:slug", Live, { name: "live" }),
    ]),
  );
}

describe("on-demand prerender: a page that redirects", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    titles.clear();
    movedTo.clear();
    external = false;
    runs.producer = 0;
    titles.set("a", "Alpha");
    titles.set("b", "Beta");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a refresh whose render answers redirect() stores it, and requests get the redirect instead of the page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const before = await serveShellRequest(router, "/products/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("a:Alpha:render-1");

    // The product moved: the producer answers redirect() instead of a page.
    movedTo.set("a", "/products/b");
    const result = await prerender("/products/a");
    expect(result).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      tags: ["product:a"],
      ttl: 3600,
      redirect: { status: 301, location: "/products/b" },
    } satisfies Partial<PrerenderResult>);

    // A document request is the 3xx, never the page the redirect replaced.
    const document = await serveShellRequest(router, "/products/a");
    expect(document.response.status).toBe(301);
    expect(document.response.headers.get("Location")).toBe("/products/b");
    expect(document.flight).toBeUndefined();

    // A client navigation is the soft redirect the router's lanes expect.
    const navigation = await serveShellRequest(router, "/products/a", {
      partial: { from: "/" },
    });
    expect(navigation.response.status).toBe(204);
    expect(navigation.response.headers.get("X-RSC-Redirect")).toBe(
      `${ORIGIN}/products/b`,
    );

    // The stored redirect is what serves: it does not expire between requests.
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(301);
  });

  it("a later refresh replaces the redirect with the page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");
    movedTo.set("a", "/products/b");
    await prerender("/products/a");
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(301);

    // The page is back in the data source.
    movedTo.delete("a");
    titles.set("a", "Alpha again");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha again:render-3");
  });

  it("a stored redirect is rechecked like a page: a stale one answers and schedules onRevalidate", async () => {
    const onRevalidate = vi.fn();
    const router = makeRouter({ store, onRevalidate });
    const prerender = router.prerender({ env: {} });
    await prerender("/hot/a");

    movedTo.set("a", "/products/b");
    expect(await prerender("/hot/a")).toMatchObject({
      ok: true,
      status: "redirected",
      ttl: 0,
    });
    expect(onRevalidate).not.toHaveBeenCalled();

    // The route's ttl (0) has passed: the redirect is stale. It still
    // answers, and the request schedules the recheck a stale page gets.
    const stale = await serveShellRequest(router, "/hot/a");
    expect(stale.response.status).toBe(302);
    expect(stale.response.headers.get("Location")).toBe("/products/b");
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onRevalidate.mock.calls[0]![0]).toEqual({
      route: "hot",
      params: { slug: "a" },
    });

    // The recheck while the product is still moved: the redirect again.
    expect(await prerender("/hot/a", { onlyIfStale: true })).toMatchObject({
      status: "redirected",
    });
  });

  it("an off-host redirect is answered as the app asked, and only with the opt-in", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/products/a");

    // Without `{ external: true }` the outgoing guard neutralizes the target,
    // exactly as it does for a live redirect (rsc/redirect-guard.ts).
    movedTo.set("a", "https://elsewhere.example/x");
    expect(await prerender("/products/a")).toMatchObject({
      status: "redirected",
      redirect: { status: 301, location: "https://elsewhere.example/x" },
    });
    expect(
      (await serveShellRequest(router, "/products/a")).response.headers.get(
        "Location",
      ),
    ).toBe("/");

    // With it, the stored redirect keeps the explicit opt-in: the brand is
    // out-of-band, so it travels in the envelope and is re-applied on serve.
    external = true;
    expect(await prerender("/products/a")).toMatchObject({
      status: "redirected",
      redirect: {
        status: 302,
        location: "https://elsewhere.example/x",
        external: true,
      },
    });
    const document = await serveShellRequest(router, "/products/a");
    expect(document.response.status).toBe(302);
    expect(document.response.headers.get("Location")).toBe(
      "https://elsewhere.example/x",
    );
  });

  it("a Passthrough route's stored redirect answers, not its live handler", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    // No stored entry: the live handler renders.
    const live = await serveShellRequest(router, "/live/a");
    expect(live.response.status).toBe(200);
    expect(live.flight).toContain("live:a");

    await prerender("/live/a");
    movedTo.set("a", "/products/b");
    // redirect()'s default status, kept as the handler wrote it.
    expect(await prerender("/live/a")).toMatchObject({
      status: "redirected",
      redirect: { status: 302, location: "/products/b" },
    });

    const document = await serveShellRequest(router, "/live/a");
    expect(document.response.status).toBe(302);
    expect(document.response.headers.get("Location")).toBe("/products/b");
  });
});
