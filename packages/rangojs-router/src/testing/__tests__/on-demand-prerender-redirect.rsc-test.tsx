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
  type HandlerContext,
} from "../../index.rsc.js";
import type { MemoryPrerenderStore } from "../../prerender/index.js";

/**
 * slug -> where the item moved to, and whether the handler opts out of the
 * same-origin rule for it. Absent: the item is where the URL says.
 */
const moved = new Map<string, { to: string; external?: boolean }>();
const runs = { producer: 0, live: 0 };

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    const m = moved.get(ctx.params.slug);
    if (m !== undefined) {
      throw m.external ? redirect(m.to, { external: true }) : redirect(m.to);
    }
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
    const m = moved.get(ctx.params.slug);
    if (m !== undefined) {
      throw m.external ? redirect(m.to, { external: true }) : redirect(m.to);
    }
    return <h1>{`guide:${ctx.params.slug}:render-${runs.producer}`}</h1>;
  },
  { onDemand: true },
);
const Guide = Passthrough(GuideDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}`}</h1>;
});

// A redirect can come from anywhere in the render, and the producer reports
// it the same way: a layout handler's, and a component's (which surfaces while
// the tree is encoded, through the Flight error sink, not the resolution).
function MovedLayout(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  const m = moved.get(ctx.params.slug);
  if (m !== undefined) throw redirect(m.to);
  return <header>{ctx.params.slug}</header>;
}

function MovedComponent({ slug }: { slug: string }): React.ReactNode {
  const m = moved.get(slug);
  if (m !== undefined) throw redirect(m.to);
  return <p>{slug}</p>;
}

const InLayoutDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <p>{`in-layout:${ctx.params.slug}`}</p>,
  { onDemand: true },
);

const InComponentDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <MovedComponent slug={ctx.params.slug} />,
  { onDemand: true },
);

// A parallel slot's handler runs inside the same segment resolution, after
// the chain above it: its redirect reaches the producer the same way.
function MovedSlot(ctx: HandlerContext<{ slug: string }>): React.ReactNode {
  const m = moved.get(ctx.params.slug);
  if (m !== undefined) throw redirect(m.to);
  return <aside>{ctx.params.slug}</aside>;
}

function makeRouter(
  prerender: { store: MemoryPrerenderStore },
  options: { basename?: string } = {},
) {
  return createRouter({ prerender, ...options }).routes(
    urls(({ path, layout, parallel }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/guides/:slug", Guide, { name: "guide" }),
      path("/start", () => <p>start</p>, { name: "start" }),
      layout(MovedLayout, () => [
        path("/in-layout/:slug", InLayoutDef, { name: "inLayout" }),
      ]),
      layout(
        () => <div>chrome</div>,
        () => [
          parallel({ "@aside": MovedSlot }),
          path("/in-slot/:slug", InLayoutDef, { name: "inSlot" }),
        ],
      ),
      path(
        "/in-component/:slug",
        InComponentDef,
        { name: "inComponent" },
        () => [parallel({ "@aside": MovedSlot })],
      ),
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

    moved.set("a", { to: "/products/a-new" });
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
    moved.set("b", { to: "/products/b-new" });
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

    moved.set("c", { to: "/products/c-new" });
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
      moved.set("d", { to: "/products/d-new" });
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
      moved.set("e", { to: "/products/e-new" });
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

    moved.set("f", { to: "/guides/f-new" });
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

  it("an external redirect keeps its opt-in: the document request is the off-host Location, not the app root", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("x", {
      to: "https://elsewhere.example/landing",
      external: true,
    });
    // `{ external: true }` is the opt-in out of the same-origin guard, which
    // lives on the Response as an out-of-band brand. A stored entry cannot
    // carry a brand, so the flag travels and the serve path re-brands: without
    // it the outgoing guard rewrites the Location to "/".
    await prerender("/products/x");

    const response = await serveShellRequest(router, "/products/x");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe(
      "https://elsewhere.example/landing",
    );
  });

  it("a basename app's stored redirect keeps the basename in its Location", async () => {
    // A live request prefixes an app-local redirect target with the basename
    // (prefixBasename, route-definition/redirect.ts). A producer render is a
    // request too: its context carries `_basename`, so the stored Location is
    // the one the handler answers with.
    const router = makeRouter({ store }, { basename: "/app" });
    const prerender = router.prerender({ env: {} });

    moved.set("y", { to: "/products/y-new" });
    expect(await prerender("/app/products/y")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/app/products/y-new" },
    });

    const response = await serveShellRequest(router, "/app/products/y");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe(
      "/app/products/y-new",
    );
  });

  it("a redirect from a layout handler is stored too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("l", { to: "/products/l-new" });
    expect(await prerender("/in-layout/l")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/products/l-new" },
    });
    const response = await serveShellRequest(router, "/in-layout/l");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe("/products/l-new");
  });

  it("a redirect a component throws while the tree is encoded is stored too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("c", { to: "/products/c-new" });
    // Flight reports a component's throw through its error sink and finishes
    // the encode; the producer re-throws it and reports the redirect from
    // there, not from the segment resolution.
    expect(await prerender("/in-component/c")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/products/c-new" },
    });
    const response = await serveShellRequest(router, "/in-component/c");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe("/products/c-new");
  });

  it("a redirect from a parallel slot handler is stored too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("s", { to: "/products/s-new" });
    expect(await prerender("/in-slot/s")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/products/s-new" },
    });
    const response = await serveShellRequest(router, "/in-slot/s");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe("/products/s-new");
  });

  it("a route with its own slot that redirects is stored: the route's answer wins", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.set("r", { to: "/products/r-new" });
    expect(await prerender("/in-component/r")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: { status: 302, location: "/products/r-new" },
    });
    const response = await serveShellRequest(router, "/in-component/r");
    expect(response.response.status).toBe(302);
    expect(response.response.headers.get("Location")).toBe("/products/r-new");
  });

  it("a route that is not on-demand still warms: the redirect is only an on-demand answer", async () => {
    const router = makeRouter({ store });
    const result = await router.prerender({ env: {} })("/start");
    // No cache configured: the warm refuses, and nothing was stored.
    expect(result).toMatchObject({ ok: false, path: "warm" });
    expect(store.size).toBe(0);
  });
});
