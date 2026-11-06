/**
 * A refresh whose render answers with a redirect, through the public testing
 * primitives: `router.prerender()` runs the real requestless producer and
 * `serveShellRequest` serves the route through the production request handler.
 *
 * An on-demand page whose item moved answers every request with `redirect()`.
 * Storing the page it used to render would serve a URL the app no longer
 * answers that way (and for a plain route the handler never runs again, so the
 * redirect would be unreachable), so the redirect itself is stored in place of
 * the page: a document request gets the 3xx, a client navigation the Flight
 * soft redirect, and a later refresh that renders a page replaces it.
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
  Passthrough,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import type { MemoryPrerenderStore } from "../../prerender/index.js";

/** slug -> where the item moved to. Absent: the item is where the URL says. */
const moved = new Map<string, string>();
const runs = { producer: 0, live: 0 };

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    const to = moved.get(ctx.params.slug);
    if (to !== undefined) throw redirect(to);
    return <h1>{`${ctx.params.slug}:render-${runs.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.slug}`] } },
);

// A Passthrough route: the build handler redirects, and its live handler would
// answer a request that found nothing in a prerender store.
const GuideDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    const to = moved.get(ctx.params.slug);
    if (to !== undefined) throw redirect(to);
    return <h1>{`guide:${ctx.params.slug}:render-${runs.producer}`}</h1>;
  },
  { onDemand: true },
);
const Guide = Passthrough(GuideDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}`}</h1>;
});

function makeRouter(prerender: { store: MemoryPrerenderStore }) {
  return createRouter({ prerender }).routes(
    urls(({ path }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/guides/:slug", Guide, { name: "guide" }),
      path("/start", () => <p>start</p>, { name: "start" }),
    ]),
  );
}

describe("on-demand prerender: a refresh that answers with a redirect", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    moved.clear();
    runs.producer = 0;
    runs.live = 0;
  });

  it("stores the redirect in place of the page: the request gets the 3xx, not the page it had", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
      tags: ["product:a"],
    });
    const before = await serveShellRequest(router, "/products/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("a:render-1");

    moved.set("a", "/products/a-new");
    const result = await prerender("/products/a");
    expect(result).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      tags: ["product:a"],
      ttl: 3600,
      redirect: { status: 302, location: "/products/a-new" },
    });
    // Stored, not rendered into a page: no entry to serve from.
    expect(store.entries()[0]?.[1]).toMatchObject({
      redirect: { status: 302, location: "/products/a-new" },
    });
    expect(store.entries()[0]?.[1]).not.toHaveProperty("entry");

    // A document request: the 3xx, in the shape redirect() builds. The page
    // stored before it is not served, and the producer does not run again.
    const after = await serveShellRequest(router, "/products/a");
    expect(after.response.status).toBe(302);
    expect(after.response.headers.get("Location")).toBe("/products/a-new");
    expect(after.response.headers.get("X-RSC-Redirect")).toBe("soft");
    expect(after.flight).toBeUndefined();
    expect(runs.producer).toBe(2);

    // And a second request replays the stored answer.
    const again = await serveShellRequest(router, "/products/a");
    expect(again.response.status).toBe(302);
    expect(runs.producer).toBe(2);
  });

  it("a client navigation gets the Flight soft redirect, not the page", async () => {
    const router = makeRouter({ store });
    await router.prerender({ env: {} })("/start");
    moved.set("b", "/products/b-new");
    await router.prerender({ env: {} })("/products/b");

    const navigation = await serveShellRequest(router, "/products/b", {
      partial: { from: "/start" },
    });

    // A 204 + X-RSC-Redirect is what the browser follows as a soft redirect:
    // a 3xx would be auto-followed by fetch instead.
    expect(navigation.response.status).toBe(204);
    expect(navigation.response.headers.get("X-RSC-Redirect")).toBe(
      "http://localhost/products/b-new",
    );
    expect(navigation.flight).toBeUndefined();
  });

  it("a later refresh that renders a page replaces the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("c", "/products/c-new");
    expect(await prerender("/products/c")).toMatchObject({
      status: "redirected",
    });
    expect(
      (await serveShellRequest(router, "/products/c")).response.status,
    ).toBe(302);

    // The item is back where the URL says.
    moved.delete("c");
    expect(await prerender("/products/c")).toMatchObject({
      status: "rendered",
    });
    const page = await serveShellRequest(router, "/products/c");
    expect(page.response.status).toBe(200);
    expect(page.flight).toContain("c:render-");
    expect(store.entries()[0]?.[1]).not.toHaveProperty("redirect");
  });

  it("onlyIfStale leaves a fresh redirect and reports it, and renders once it is stale", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      moved.set("d", "/products/d-new");
      await prerender("/products/d");

      // Fresh: nothing renders, and the result says what a request gets.
      expect(
        await prerender("/products/d", { onlyIfStale: true }),
      ).toMatchObject({
        ok: true,
        status: "redirected",
        redirect: { status: 302, location: "/products/d-new" },
      });
      expect(runs.producer).toBe(1);

      // Stale (ttl 3600): rendered again, so a route that stopped redirecting
      // gets its page back on the next sweep.
      clock.mockReturnValue(1_000_000 + 3_600_001);
      moved.delete("d");
      expect(
        await prerender("/products/d", { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "rendered" });
      expect(
        (await serveShellRequest(router, "/products/d")).response.status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });

  it("markStale reaches a stored redirect", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      moved.set("e", "/products/e-new");
      await prerender("/products/e");

      clock.mockReturnValue(1_000_000 + 5);
      await prerender.markStale(["product:e"]);
      moved.delete("e");

      expect(
        await prerender("/products/e", { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "rendered" });
    } finally {
      clock.mockRestore();
    }
  });

  it("a Passthrough route's stored redirect answers: its live handler does not run", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("f", "/guides/f-new");
    expect(await prerender("/guides/f")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/guides/f-new" },
    });

    const response = await serveShellRequest(router, "/guides/f");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe("/guides/f-new");
    expect(runs.live).toBe(0);
  });

  it("a route that is not on-demand still warms: the redirect is only an on-demand answer", async () => {
    const router = makeRouter({ store });
    const result = await router.prerender({ env: {} })("/start");
    // No cache configured: the warm refuses, and nothing was stored.
    expect(result).toMatchObject({ ok: false, path: "warm" });
    expect(store.size).toBe(0);
  });
});
