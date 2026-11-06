/**
 * A refresh whose render answers `redirect()`, through the public testing
 * primitives: `router.prerender()` runs the real requestless producer, and
 * `serveShellRequest` serves the route through the production request handler,
 * which reads the writable overlay before the bundled manifest.
 *
 * The render produced no page: it produced a redirect. The refresh stores that
 * redirect in place of the page, so the next request answers it instead of
 * serving the page the app moved away from. A raw Response that is not a
 * redirect is not storable and stays a failed render: the page keeps serving.
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
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
} from "../../prerender/index.js";

/** The data source: slug -> title. A slug that moved answers a redirect. */
const catalog = new Map<string, string>();
/** slug -> where the product page moved to. */
const moved = new Map<string, string>();
/** Set to make the next render throw a Response that is no redirect. */
let rawResponse = false;
const runs = { producer: 0 };

// A Prerender handler returns ReactNode, so a route handler answers a redirect
// by throwing one; a layout handler may return it (Handler allows a Response).
const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    const target = moved.get(ctx.params.slug);
    if (target !== undefined) throw redirect(target);
    if (rawResponse) throw new Response("raw payload");
    const title = catalog.get(ctx.params.slug);
    if (title === undefined) notFound(`no product ${ctx.params.slug}`);
    return <h1>{`${ctx.params.slug}:${title}:render-${runs.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.slug}`] } },
);

// The other spelling a render can answer with: a layout handler returns the
// Response, so it short-circuits through handleHandlerResult instead of a
// throw.
const movedLayout = async (): Promise<React.ReactNode | Response> =>
  moved.has("laid") ? redirect("/products/b") : <main>chrome</main>;

const LaidDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`laid:${ctx.params.slug}`}</h1>,
  { onDemand: true },
);

// A page that moved off this host, opted in with `{ external: true }`: the
// opt-in is the out-of-band brand on the Response, so a stored redirect has to
// carry the intent to stay off-host when it is served again.
const OffHostDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    throw redirect(`https://shop.example/${ctx.params.slug}`, {
      external: true,
    });
  },
  { onDemand: true },
);

function makeRouter(config: PrerenderConfig) {
  return createRouter({ prerender: config }).routes(
    urls(({ path, layout }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/offhost/:slug", OffHostDef, { name: "offhost" }),
      layout(movedLayout, () => [
        path("/laid/:slug", LaidDef, { name: "laid" }),
      ]),
    ]),
  );
}

describe("on-demand prerender: a refresh that answers redirect()", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    catalog.clear();
    catalog.set("a", "Alpha");
    catalog.set("b", "Beta");
    moved.clear();
    rawResponse = false;
    runs.producer = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the redirect and the next document request answers it, not the page it replaced", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const before = await serveShellRequest(router, "/products/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("a:Alpha:render-1");

    // The product moved: the render now answers a redirect instead of a page.
    moved.set("a", "/products/b");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      tags: ["product:a"],
      ttl: 3600,
    });

    const after = await serveShellRequest(router, "/products/a");
    expect(after.response.status).toBe(302);
    expect(after.response.headers.get("Location")).toBe("/products/b");
    expect(after.flight ?? "").not.toContain("a:Alpha:render-1");

    // A client navigation is answered the same way, as a soft redirect the
    // client navigates to without a document reload.
    const partial = await serveShellRequest(router, "/products/a", {
      partial: { from: "/" },
    });
    expect(partial.response.status).toBe(204);
    expect(partial.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/products/b",
    );
  });

  it("a layout handler that returns the redirect stores it too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/laid/x")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    moved.set("laid", "/products/b");
    expect(await prerender("/laid/x")).toMatchObject({
      ok: true,
      status: "redirected",
    });

    const served = await serveShellRequest(router, "/laid/x");
    expect(served.response.status).toBe(302);
    expect(served.response.headers.get("Location")).toBe("/products/b");
  });

  it("a later refresh that renders a page replaces the redirect; one that hits notFound() removes it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    await prerender("/products/a");
    moved.set("a", "/products/b");
    await prerender("/products/a");
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(302);

    // The page came back: the refresh replaces the redirect with it.
    moved.delete("a");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha:render-3");

    // And a redirect does not survive a removal either.
    moved.set("a", "/products/b");
    await prerender("/products/a");
    expect(await prerender.remove("/products/a")).toMatchObject({
      ok: true,
      status: "removed",
    });
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(404);
  });

  it("a refresh that hits notFound() after a redirect stores the marker, not the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    await prerender("/products/a");
    moved.set("a", "/products/b");
    await prerender("/products/a");

    moved.delete("a");
    catalog.delete("a");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "removed",
    });
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(404);
  });

  it("onlyIfStale leaves a fresh redirect alone and reports it, and re-renders once it is stale", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    await prerender("/products/a");
    moved.set("a", "/products/b");
    await prerender("/products/a");

    // Fresh: nothing is rendered, and the result says what the entry is.
    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      { ok: true, status: "redirected" },
    );
    expect(runs.producer).toBe(2);

    // Stale: the sweep renders again and stores what it renders.
    moved.delete("a");
    await prerender.markStale(["product:a"]);
    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      { ok: true, status: "rendered" },
    );
    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:Alpha:render-3");
  });

  it("a Response that is not a redirect is not storable: render-failed, and the page keeps serving", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    await prerender("/products/a");
    rawResponse = true;
    const failed = await prerender("/products/a");
    expect(failed).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "render-failed",
    });

    const served = await serveShellRequest(router, "/products/a");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("a:Alpha:render-1");
  });

  it("redirect(url, { external: true }) stays off-host when the stored redirect is served", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/offhost/a")).toMatchObject({
      ok: true,
      status: "redirected",
    });

    const served = await serveShellRequest(router, "/offhost/a");
    expect(served.response.status).toBe(302);
    expect(served.response.headers.get("Location")).toBe(
      "https://shop.example/a",
    );
  });
});
