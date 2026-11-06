/**
 * A refresh whose render answers `redirect()` instead of a page, through the
 * public testing primitives: `router.prerender()` runs the real requestless
 * producer, `serveShellRequest` serves the route through the production request
 * handler (document and client navigation), and `prerender.remove()` /
 * `markStale()` / `onlyIfStale` act on the stored redirect as they do on a page.
 *
 * The page stored before the redirect must stop serving. The redirect is stored
 * in its place, so the visitor is redirected rather than served a URL the app
 * moved away from — on a plain on-demand route too, which has no live handler to
 * answer (its gated producer throws, so a "removed" marker would be a 404).
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

/** What the data source says about a slug: a page, or where it moved. */
const moved = new Map<string, string>();
const runs = { producer: 0, live: 0, layout: 0 };

/** The destination a moved slug redirects to. */
const destination = (slug: string) => `/new/${slug}`;

function MovedLayout(
  ctx: HandlerContext<{ slug: string }>,
): React.ReactNode | Response {
  runs.layout += 1;
  const target = moved.get(ctx.params.slug);
  // A layout handler's redirect is a render outcome like a route handler's.
  if (target) return redirect(destination(ctx.params.slug));
  return <header>{`layout:${ctx.params.slug}`}</header>;
}

const MovedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    const target = moved.get(ctx.params.slug);
    if (target) return redirect(destination(ctx.params.slug));
    return <h1>{`page:${ctx.params.slug}:render-${runs.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`page:${params.slug}`] } },
);

// A Passthrough route: its live handler answers a request nothing stored
// answers, and redirects a moved slug itself. So the answer a live handler
// gives and the answer the stored redirect gives can be compared directly.
const MovedLive = Passthrough(MovedDef, async (ctx) => {
  runs.live += 1;
  if (moved.has(ctx.params.slug)) return redirect(destination(ctx.params.slug));
  return <h1>{`live:${ctx.params.slug}:run-${runs.live}`}</h1>;
});

const ExternalDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    if (moved.get(ctx.params.slug) === "external") {
      return redirect("https://accounts.example/oauth", {
        status: 308,
        external: true,
      });
    }
    return <h1>{`page:${ctx.params.slug}`}</h1>;
  },
  { onDemand: true },
);

function makeRouter(
  prerender: PrerenderConfig,
  options: { basename?: string } = {},
) {
  return createRouter({ prerender, ...options }).routes(
    urls(({ path, layout }) => [
      path("/moved/:slug", MovedDef, { name: "moved" }),
      path("/moved-live/:slug", MovedLive, { name: "movedLive" }),
      path("/external/:slug", ExternalDef, { name: "external" }),
      layout(MovedLayout, () => [
        path("/in-layout/:slug", MovedDef, { name: "inLayout" }),
      ]),
    ]),
  );
}

/**
 * What a visitor's response answers a redirect with: a document request gets
 * the 302 and its `Location`, a client navigation the 204 soft form with the
 * resolved target in `X-RSC-Redirect`.
 */
function visit(result: Awaited<ReturnType<typeof serveShellRequest>>): {
  status: number;
  location: string | null;
  soft: string | null;
} {
  return {
    status: result.response.status,
    location: result.response.headers.get("location"),
    soft: result.response.headers.get("x-rsc-redirect"),
  };
}

describe("on-demand prerender: a render that redirects", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    moved.clear();
    for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stores the redirect over the page, and the visitor gets it", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/moved/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const before = await serveShellRequest(router, "/moved/a");
    expect(before.response.status).toBe(200);
    expect(before.flight).toContain("page:a:render-1");

    moved.set("a", "new");
    expect(await prerender("/moved/a")).toMatchObject({
      ok: true,
      path: "on-demand",
      status: "redirected",
      routeName: "moved",
      tags: ["page:a"],
      ttl: 3600,
    });

    // Document request: the redirect, not the page stored before it, and
    // without running the producer again.
    const after = await serveShellRequest(router, "/moved/a");
    expect(visit(after)).toEqual({
      status: 302,
      location: "/new/a",
      soft: "soft",
    });
    expect(after.body).not.toContain("page:a:render-1");
    expect(runs.producer).toBe(2);

    // Client navigation: the soft form, carrying the resolved target.
    const partial = await serveShellRequest(router, "/moved/a", {
      partial: true,
    });
    expect(visit(partial)).toEqual({
      status: 204,
      location: null,
      soft: "http://localhost/new/a",
    });
    expect(runs.producer).toBe(2);
  });

  it("a later refresh that renders a page replaces the redirect", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/moved/a");

    moved.set("a", "new");
    expect(await prerender("/moved/a")).toMatchObject({ status: "redirected" });
    expect(visit(await serveShellRequest(router, "/moved/a")).status).toBe(302);

    moved.delete("a");
    expect(await prerender("/moved/a")).toMatchObject({ status: "rendered" });
    const back = await serveShellRequest(router, "/moved/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("page:a:render-3");
  });

  it("onlyIfStale leaves a fresh redirect and reports redirected", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    moved.set("a", "new");
    await prerender("/moved/a");

    expect(await prerender("/moved/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "redirected",
    });
    // Nothing rendered: the one producer run is the first refresh's.
    expect(runs.producer).toBe(1);
  });

  it("markStale() rechecks it like a page", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    moved.set("a", "new");
    expect(await prerender("/moved/a")).toMatchObject({ status: "redirected" });

    // The redirect is stamped with the route's tags, so the tag reaches it.
    await prerender.markStale(["page:a"]);
    moved.delete("a");

    expect(await prerender("/moved/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "rendered",
    });
    expect(runs.producer).toBe(2);
    expect((await serveShellRequest(router, "/moved/a")).response.status).toBe(
      200,
    );
  });

  it("prerender.remove() replaces the redirect, and a plain route answers 404", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    moved.set("a", "new");
    expect(await prerender("/moved/a")).toMatchObject({ status: "redirected" });
    expect(visit(await serveShellRequest(router, "/moved/a")).status).toBe(302);

    expect(await prerender.remove("/moved/a")).toMatchObject({
      ok: true,
      status: "removed",
      tags: [],
    });

    const gone = await serveShellRequest(router, "/moved/a");
    expect(gone.response.status).toBe(404);
    expect(gone.response.headers.get("location")).toBeNull();
  });

  it("a Passthrough route answers a stored redirect exactly like its live handler", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    // Moved, and nothing stored for it yet: the live handler answers.
    moved.set("a", "new");
    const liveDocument = visit(
      await serveShellRequest(router, "/moved-live/a"),
    );
    const livePartial = visit(
      await serveShellRequest(router, "/moved-live/a", { partial: true }),
    );
    expect(liveDocument).toEqual({
      status: 302,
      location: "/new/a",
      soft: "soft",
    });
    expect(livePartial).toEqual({
      status: 204,
      location: null,
      soft: "http://localhost/new/a",
    });
    const liveRuns = runs.live;

    // The refresh stores the redirect, and the store answers from now on: the
    // same two answers, without running the live handler again.
    expect(await prerender("/moved-live/a")).toMatchObject({
      status: "redirected",
    });
    expect(visit(await serveShellRequest(router, "/moved-live/a"))).toEqual(
      liveDocument,
    );
    expect(
      visit(
        await serveShellRequest(router, "/moved-live/a", { partial: true }),
      ),
    ).toEqual(livePartial);
    expect(runs.live).toBe(liveRuns);
  });

  it("a layout handler's redirect is stored too", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    expect(await prerender("/in-layout/a")).toMatchObject({
      status: "rendered",
    });

    moved.set("a", "new");
    expect(await prerender("/in-layout/a")).toMatchObject({
      status: "redirected",
    });
    expect(visit(await serveShellRequest(router, "/in-layout/a"))).toEqual({
      status: 302,
      location: "/new/a",
      soft: "soft",
    });
  });

  it("a root-relative target takes the serving request's basename", async () => {
    const router = makeRouter({ store }, { basename: "/app" });
    const prerender = router.prerender({ env: {} });
    await prerender("/app/moved/a");
    moved.set("a", "new");
    await prerender("/app/moved/a");

    // Stored as the app wrote it; the prefix is applied when it is served, so
    // it matches what a live handler's redirect() sends under the same basename.
    expect(visit(await serveShellRequest(router, "/app/moved/a"))).toEqual({
      status: 302,
      location: "/app/new/a",
      soft: "soft",
    });
  });

  it("an external redirect keeps its opt-in across the store", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/external/a");
    moved.set("a", "external");
    await prerender("/external/a");

    // The `{ external: true }` opt-in is a WeakSet brand on the Response, which
    // cannot be stored: the entry keeps it as data and re-applies it on serve.
    expect(visit(await serveShellRequest(router, "/external/a"))).toEqual({
      status: 308,
      location: "https://accounts.example/oauth",
      soft: "soft",
    });
  });
});
