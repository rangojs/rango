/**
 * A refresh whose render answers with `redirect()`, through the public testing
 * primitives: `router.prerender()` runs the real requestless producer and
 * `serveShellRequest` serves the route through the production request handler.
 *
 * A redirect is a render outcome, like `notFound()`, not a failure: the URL is
 * not a page any more, it sends the visitor elsewhere. The stored answer is the
 * redirect, so the page a previous refresh stored stops serving, and the
 * visitor gets the same 302 the live handler would have answered. Keeping the
 * old page (a `render-failed` refresh, replace-on-success) is the bug: a URL
 * that moved keeps showing the page it used to be.
 *
 * A "removed" marker would not do: a plain on-demand route never runs its
 * producer live (the eviction gate answers 404), and a Passthrough route runs
 * its LIVE handler, which is a different function from the producer that
 * decided the URL moved. Both would turn the redirect into something else.
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
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
} from "../../prerender/index.js";

/** The origin serveShellRequest resolves paths against. */
const ORIGIN = "http://localhost";

/** The data source: slug -> title. A missing slug is a deleted product. */
const catalog = new Map<string, string>();
/** Slugs whose URL moved: the producer answers a redirect for them. */
const moved = new Set<string>();
const runs = { producer: 0, live: 0 };
/** Set to make the next producer run fail like an upstream outage. */
let outage = false;

const movedTo = (slug: string): string => `/products/new-${slug}`;

function product(slug: string): string {
  if (outage) throw new Error("upstream 500");
  const title = catalog.get(slug);
  if (title === undefined) notFound(`no product ${slug}`);
  return title;
}

/**
 * A moved URL, decided inside the tree: a component that throws the redirect.
 * The throw surfaces through Flight's error collection, not the handler
 * boundary, so it is the path a real page's `if (!item) throw redirect(...)`
 * takes.
 */
async function MovedGuard({
  slug,
}: {
  slug: string;
}): Promise<React.ReactNode> {
  await Promise.resolve();
  if (moved.has(slug)) throw redirect(movedTo(slug));
  return null;
}

const ProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const title = product(ctx.params.slug);
    runs.producer += 1;
    return (
      <div>
        <MovedGuard slug={ctx.params.slug} />
        <h1>{`${ctx.params.slug}:${title}:render-${runs.producer}`}</h1>
      </div>
    );
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`product:${params.slug}`] } },
);

// The same page behind a live fallback: a "removed" marker would hand the
// request to this handler, which knows nothing about the move.
const LiveProductDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const title = product(ctx.params.slug);
    runs.producer += 1;
    return (
      <div>
        <MovedGuard slug={ctx.params.slug} />
        <h1>{`frozen:${title}`}</h1>
      </div>
    );
  },
  { onDemand: true },
);
const LiveProduct = Passthrough(LiveProductDef, async (ctx) => {
  runs.live += 1;
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

// A route whose HANDLER throws the redirect (a Response throw, which segment
// resolution rethrows rather than collecting): the other way into the same
// outcome.
const HandledDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    if (moved.has(ctx.params.slug)) throw redirect(movedTo(ctx.params.slug));
    runs.producer += 1;
    return <h1>{`handled:${product(ctx.params.slug)}`}</h1>;
  },
  { onDemand: true },
);

// An off-host redirect the app opted into: `{ external: true }` is an
// out-of-band brand on the Response, so a stored one has to keep it or the
// document guard neutralizes the target to the app root.
const OffhostDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    throw redirect(`https://accounts.example.com/sso?next=${ctx.params.slug}`, {
      external: true,
    });
  },
  { onDemand: true },
);

function makeRouter(prerender: PrerenderConfig) {
  return createRouter({ prerender }).routes(
    urls(({ path }) => [
      path("/products/:slug", ProductDef, { name: "product" }),
      path("/live/:slug", LiveProduct, { name: "live" }),
      path("/handled/:slug", HandledDef, { name: "handled" }),
      path("/offhost/:slug", OffhostDef, { name: "offhost" }),
    ]),
  );
}

describe("on-demand prerender: a refresh that answers with a redirect", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    catalog.clear();
    catalog.set("a", "Alpha");
    moved.clear();
    runs.producer = 0;
    runs.live = 0;
    outage = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replaces the page: the visitor gets the 302, not the page the route served before", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "rendered",
    });
    const before = await serveShellRequest(router, "/products/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("a:Alpha:render-1");

    moved.add("a");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      target: "/products/a",
      routeName: "product",
      tags: ["product:a"],
      ttl: 3600,
    });

    // The page it replaced does not answer any more: the stored answer is the
    // redirect, for the document request and for a client navigation alike.
    const after = await serveShellRequest(router, "/products/a");
    expect(after.response.status).toBe(302);
    expect(after.response.headers.get("Location")).toBe(movedTo("a"));
    expect(after.body).not.toContain("a:Alpha");

    // Frozen like a page: the stored redirect answers, nothing re-renders.
    const again = await serveShellRequest(router, "/products/a");
    expect(again.response.status).toBe(302);
    expect(again.response.headers.get("Location")).toBe(movedTo("a"));

    // A client navigation must not have a 302 followed by fetch(): it gets the
    // Flight redirect the live handler's redirect() would produce.
    const partial = await serveShellRequest(router, "/products/a", {
      partial: true,
    });
    expect(partial.response.status).toBe(204);
    expect(partial.response.headers.get("X-RSC-Redirect")).toBe(
      `${ORIGIN}${movedTo("a")}`,
    );
    expect(partial.response.headers.get("Location")).toBeNull();

    // No request rendered: one producer run for the page, one for the redirect.
    expect(runs.producer).toBe(2);
  });

  it("a handler's redirect Response is the same outcome as a component's", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/handled/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });

    moved.add("a");
    expect(await prerender("/handled/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
    });

    const after = await serveShellRequest(router, "/handled/a");
    expect(after.response.status).toBe(302);
    expect(after.response.headers.get("Location")).toBe(movedTo("a"));
  });

  it("a Passthrough route stores the redirect: its live handler does not answer it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/live/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    expect((await serveShellRequest(router, "/live/a")).flight).toContain(
      "frozen:Alpha",
    );

    moved.add("a");
    expect(await prerender("/live/a")).toMatchObject({
      ok: true,
      status: "redirected",
    });

    const after = await serveShellRequest(router, "/live/a");
    expect(after.response.status).toBe(302);
    expect(after.response.headers.get("Location")).toBe(movedTo("a"));
    // A "removed" marker would have run the live handler here, which renders a
    // 200 page: the redirect outcome would be lost.
    expect(runs.live).toBe(0);
  });

  it("a refresh that renders the page again replaces the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.add("a");
    expect(await prerender("/products/a")).toMatchObject({
      status: "redirected",
    });
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(302);

    moved.delete("a");
    catalog.set("a", "Alpha returns");
    expect(await prerender("/products/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/products/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:Alpha returns:render-2");
  });

  it("is rechecked like a page: onlyIfStale leaves a fresh one, markStale re-renders it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.add("a");
    expect(await prerender("/products/a")).toMatchObject({
      status: "redirected",
    });

    // Fresh: the sweep renders nothing and the stored redirect keeps serving.
    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      {
        ok: true,
        path: "on-demand",
        status: "redirected",
        tags: ["product:a"],
        ttl: 3600,
      },
    );
    expect(
      (await serveShellRequest(router, "/products/a")).response.status,
    ).toBe(302);

    // Marked stale: the sweep renders again, and the URL still moved.
    await prerender.markStale(["product:a"]);
    expect(await prerender("/products/a", { onlyIfStale: true })).toMatchObject(
      { ok: true, status: "redirected" },
    );
  });

  it("keeps serving when a later refresh fails: replace-on-success", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    moved.add("a");
    await prerender("/products/a");

    outage = true;
    expect(await prerender("/products/a")).toMatchObject({
      ok: false,
      status: "render-failed",
    });
    outage = false;

    const kept = await serveShellRequest(router, "/products/a");
    expect(kept.response.status).toBe(302);
    expect(kept.response.headers.get("Location")).toBe(movedTo("a"));
  });

  it("keeps an explicit off-host target", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/offhost/a")).toMatchObject({
      ok: true,
      status: "redirected",
    });

    const res = await serveShellRequest(router, "/offhost/a");
    expect(res.response.status).toBe(302);
    expect(res.response.headers.get("Location")).toBe(
      "https://accounts.example.com/sso?next=a",
    );
  });
});
