/**
 * A redirecting on-demand refresh keeps the page, through the public testing
 * primitives: `router.prerender()` runs the real requestless producer,
 * `serveShellRequest` serves the route through the production request handler
 * (a document, and the client navigation the browser sends), and the store is
 * the public `createMemoryPrerenderStore()`.
 *
 * A redirect can depend on the request (a session or auth check), so it does
 * not show the page is gone: the refresh writes nothing and the stored page
 * keeps serving. Its result is `skipped-redirect`, not `render-failed` (a
 * crash, which also keeps the page) and not `removed` (a stored marker).
 *
 * Every handler kind that can redirect is covered: the route handler, a layout
 * handler, a parallel-slot handler, a `Passthrough` route's build handler, and
 * a handler streaming behind `loading()`.
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
} from "../../index.rsc.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderResult,
} from "../../prerender/index.js";

/** Slugs whose render redirects: the data source answers "elsewhere". */
const redirectSlugs = new Set<string>();
/** Set to make the layout handler throw: a render that fails another way. */
let layoutFails = false;
const runs = { page: 0, layout: 0, slot: 0, streamed: 0, passthrough: 0 };

/** Both a build handler's and a live handler's context carry the params. */
type Params = { params: { slug: string } };

/** What the page a refresh renders carries; a stored page replays it. */
const stamp = (kind: string, slug: string, run: number) =>
  `${kind}:${slug}:run-${run}`;

function Page(ctx: Params, kind: string, run: number): React.ReactNode {
  return <h1>{stamp(kind, ctx.params.slug, run)}</h1>;
}

const PageDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.page += 1;
    if (redirectSlugs.has(ctx.params.slug)) return redirect("/login") as never;
    return Page(ctx, "page", runs.page);
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`page:${params.slug}`] } },
);

// The route declares loading(), so its handler result is streamed: the
// redirect resolves after the response starts.
const StreamedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.streamed += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (redirectSlugs.has(ctx.params.slug)) return redirect("/login") as never;
    return Page(ctx, "streamed", runs.streamed);
  },
  { onDemand: true },
);

function Layout(ctx: Params): React.ReactNode {
  runs.layout += 1;
  if (layoutFails) throw new Error("layout down");
  if (redirectSlugs.has(ctx.params.slug)) return redirect("/login") as never;
  return <header>{`layout:${ctx.params.slug}`}</header>;
}

function Slot(ctx: Params): React.ReactNode {
  runs.slot += 1;
  if (redirectSlugs.has(ctx.params.slug)) return redirect("/login") as never;
  return <aside>{`slot:${ctx.params.slug}`}</aside>;
}

const FrozenDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.passthrough += 1;
    if (redirectSlugs.has(ctx.params.slug)) return redirect("/login") as never;
    return Page(ctx, "passthrough", runs.passthrough);
  },
  { onDemand: true },
);
const Frozen = Passthrough(FrozenDef, async (ctx) => Page(ctx, "live", 0));

// A route handler that answers a 401 instead of a page: a Response that is not
// a redirect is a failure, not a skipped refresh.
const UnauthorizedDef = Prerender<{ slug: string }>(
  async () => [],
  async () => new Response("nope", { status: 401 }) as never,
  { onDemand: true },
);

function makeRouter(prerender: PrerenderConfig) {
  return createRouter({ prerender }).routes(
    urls(({ path, layout, parallel, loading }) => [
      path("/page/:slug", PageDef, { name: "page" }),
      path("/streamed/:slug", StreamedDef, { name: "streamed" }, () => [
        loading(<p>loading</p>),
      ]),
      layout(Layout, () => [
        path("/in-layout/:slug", PageDef, { name: "inLayout" }),
      ]),
      layout(
        () => <header>chrome</header>,
        () => [
          parallel({ "@aside": Slot }),
          path("/with-slot/:slug", PageDef, { name: "withSlot" }),
        ],
      ),
      path("/passthrough/:slug", Frozen, { name: "passthrough" }),
      path("/unauthorized/:slug", UnauthorizedDef, { name: "unauthorized" }),
    ]),
  );
}

/** Every handler kind that can redirect, and the URL that exercises it. */
const KINDS = [
  { kind: "route handler", path: "/page/a", text: "page:a:run-" },
  { kind: "layout handler", path: "/in-layout/a", text: "page:a:run-" },
  { kind: "parallel-slot handler", path: "/with-slot/a", text: "page:a:run-" },
  {
    kind: "Passthrough build handler",
    path: "/passthrough/a",
    text: "passthrough:a:run-",
  },
  {
    kind: "handler behind loading()",
    path: "/streamed/a",
    text: "streamed:a:run-",
  },
] as const;

/** A document request and a client navigation, and what both rendered. */
async function serveBoth(
  router: ReturnType<typeof makeRouter>,
  path: string,
): Promise<{ document: number; navigation: number; flight: string }> {
  const document = await serveShellRequest(router, path);
  const navigation = await serveShellRequest(router, path, { partial: true });
  return {
    document: document.response.status,
    navigation: navigation.response.status,
    flight: `${document.flight ?? ""}\n${navigation.flight ?? ""}`,
  };
}

describe("on-demand prerender: a redirecting refresh keeps the page", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    redirectSlugs.clear();
    layoutFails = false;
    for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { kind, path, text } of KINDS) {
    it(`${kind}: skipped-redirect, nothing written, the stored page keeps serving`, async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });

      expect(await prerender(path)).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const before = store.entries()[0]![1];
      const served = await serveBoth(router, path);
      expect(served.flight).toContain(`${text}1`);

      redirectSlugs.add("a");
      expect(await prerender(path)).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        target: path,
      });
      // Nothing written: the entry is the one the earlier refresh stored.
      expect(store.entries()).toHaveLength(1);
      expect(store.entries()[0]![1]).toBe(before);

      // The old page still answers a document request and a navigation.
      const after = await serveBoth(router, path);
      expect(after.document).toBe(200);
      expect(after.navigation).toBe(200);
      expect(after.flight).toContain(`${text}1`);
      expect(after.flight).not.toContain(`${text}2`);

      // A refresh that renders a page again replaces it.
      redirectSlugs.clear();
      expect(await prerender(path)).toMatchObject({
        ok: true,
        status: "rendered",
      });
      expect(store.entries()[0]![1]).not.toBe(before);
      const replaced = (await serveBoth(router, path)).flight;
      expect(replaced).toContain(text);
      expect(replaced).not.toContain(`${text}1`);
    });
  }

  it("a cold store: skipped-redirect stores nothing, so nothing serves the page", async () => {
    const router = makeRouter({ store });
    redirectSlugs.add("a");

    const result = await router.prerender({ env: {} })("/page/a");

    expect(result).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "skipped-redirect",
      routeName: "page",
    });
    // No page and no "removed" marker: a redirect is not a removal.
    expect(store.size).toBe(0);
  });

  it("markStale() then an onlyIfStale refresh renders the page again", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/page/a");
    redirectSlugs.add("a");
    expect(await prerender("/page/a")).toMatchObject({
      status: "skipped-redirect",
    });
    // The entry the redirecting refresh left is still fresh, so a sweep
    // leaves it: nothing was written and nothing went stale.
    expect(await prerender("/page/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "already-fresh",
    });

    redirectSlugs.clear();
    await prerender.markStale(["page:a"]);
    expect(await prerender("/page/a", { onlyIfStale: true })).toMatchObject({
      ok: true,
      status: "rendered",
    });
    expect((await serveBoth(router, "/page/a")).flight).toContain(
      "page:a:run-3",
    );
  });

  it("a render that redirects and fails another way stays render-failed", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/in-layout/a");
    const before = store.entries()[0]![1];

    // The layout throws before the route handler's redirect runs.
    layoutFails = true;
    redirectSlugs.add("a");
    const result = await prerender("/in-layout/a");

    expect(result).toMatchObject({
      ok: false,
      status: "render-failed",
    });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(store.entries()[0]![1]).toBe(before);
  });

  it("a Response that is not a redirect stays render-failed", async () => {
    const router = makeRouter({ store });

    const result = await router.prerender({ env: {} })("/unauthorized/a");

    expect(result).toMatchObject({
      ok: false,
      path: "on-demand",
      status: "render-failed",
    });
    expect(store.size).toBe(0);
  });

  it("throwOnError throws a PrerenderError carrying skipped-redirect", async () => {
    const router = makeRouter({ store });
    redirectSlugs.add("a");

    const thrown: unknown = await router
      .prerender({ env: {} })("/page/a", { throwOnError: true })
      .catch((error: unknown) => error);

    expect((thrown as { result: PrerenderResult }).result).toMatchObject({
      ok: false,
      status: "skipped-redirect",
    });
  });

  it("many() reports the redirecting target on its own and renders the rest", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/page/b");
    redirectSlugs.add("a");

    const results = await prerender.many(["/page/a", "/page/b"]);

    expect(results.map((result) => result.status)).toEqual([
      "skipped-redirect",
      "rendered",
    ]);
    expect(store.size).toBe(1);
  });
});
