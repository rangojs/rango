/**
 * On-demand prerender, refresh then serve, through the public testing
 * primitives: `router.prerender()` runs the real requestless producer (real
 * Flight serializer), and `serveShellRequest` serves the route through the
 * production request handler, which resolves the router's `prerender` config
 * and reads the overlay before the bundled manifest. `dispatch` cannot serve
 * it: it renders response routes only (it throws on a component route), and
 * the overlay is read in the RSC match pipeline.
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
import { createMemoryPrerenderStore, setBuildVersions } from "../index.js";
import {
  cookies,
  createLoader,
  createRouter,
  Passthrough,
  Prerender,
  redirect,
  urls,
} from "../../index.rsc.js";
import {
  expectNoInternalFields,
  serveEveryShape,
} from "./helpers/response-shapes.js";
import { getCacheVersions } from "../../cache/index.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderStoredEntry,
  WritablePrerenderStore,
} from "../../prerender/index.js";

/** Producer renders and loader runs, to tell a stored payload from a render. */
const counts = { producer: 0, loader: 0 };

const StampLoader = createLoader(async () => {
  counts.loader += 1;
  return { value: `loader-${counts.loader}` };
});

/** Set to hold the article's render open, to land a markStale() inside it. */
let holdRender: { entered: () => void; gate: Promise<void> } | undefined;

const ArticleDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    if (holdRender) {
      holdRender.entered();
      await holdRender.gate;
    }
    counts.producer += 1;
    return <h1>{`${ctx.params.slug}:stamp-${counts.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`article:${params.slug}`] } },
);

const PersonalizedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    cookies().get("session");
    return <h1>{ctx.params.slug}</h1>;
  },
  { onDemand: true },
);

// No route ttl: the router-level default applies.
const HotDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => <h1>{`hot:${ctx.params.slug}`}</h1>,
  { onDemand: true },
);

const VersionsDef = Prerender<{ slug: string }>(
  async () => [],
  async () => {
    const versions = getCacheVersions();
    return <p>{`versions:${versions.data}/${versions.document}`}</p>;
  },
  { onDemand: true },
);

// ---------------------------------------------------------------------------
// A redirecting refresh keeps the page: one route per kind of handler that can
// answer redirect(), each flipped between rendering its page and redirecting.
// A page's stamp counts its renders, so a stored payload and a fresh render
// are told apart in the served Flight text.
// ---------------------------------------------------------------------------

/** Per-kind switch: true makes that kind's handler answer redirect("/login"). */
const redirecting = {
  route: false,
  passthrough: false,
  layout: false,
  slot: false,
  loading: false,
  /** The route behind loading() throws while the layout's child fails. */
  failingLayout: false,
};

const renderCounts: Record<string, number> = {};
/** Renders started per kind, page or redirect: proves a refresh did not run. */
const renderAttempts: Record<string, number> = {};

function attempt(kind: string): void {
  renderAttempts[kind] = (renderAttempts[kind] ?? 0) + 1;
}

/** A page stamped once per render, tagged so one markStale() reaches every kind. */
function pageOf(kind: string, slug: string): React.ReactNode {
  renderCounts[kind] = (renderCounts[kind] ?? 0) + 1;
  return <h1>{`${kind}:${slug}:r${renderCounts[kind]}`}</h1>;
}

const redirectTag = ({ params }: { params: Record<string, string> }) => [
  `redirect:${params.slug}`,
];

const RedirectRouteDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    attempt("route");
    if (redirecting.route) throw redirect("/login");
    return pageOf("route", ctx.params.slug);
  },
  { onDemand: { ttl: 3600, tags: redirectTag } },
);

const RedirectPassthroughDef = Passthrough(
  Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => {
      attempt("passthrough");
      if (redirecting.passthrough) throw redirect("/login");
      return pageOf("passthrough", ctx.params.slug);
    },
    { onDemand: { ttl: 3600, tags: redirectTag } },
  ),
  async (ctx) => <h1>{`live:${ctx.params.slug}`}</h1>,
);

const RedirectLayoutPageDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => pageOf("layout", ctx.params.slug),
  { onDemand: { ttl: 3600, tags: redirectTag } },
);

const RedirectSlotPageDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => pageOf("slot", ctx.params.slug),
  { onDemand: { ttl: 3600, tags: redirectTag } },
);

const RedirectLoadingDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    attempt("loading");
    if (redirecting.loading) throw redirect("/login");
    return pageOf("loading", ctx.params.slug);
  },
  { onDemand: { ttl: 3600, tags: redirectTag } },
);

const FailingPageDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    attempt("failing");
    if (redirecting.failingLayout) throw redirect("/login");
    return pageOf("failing", ctx.params.slug);
  },
  { onDemand: { ttl: 3600, tags: redirectTag } },
);

/**
 * A component that fails while the tree is encoded, as a real page's can. A
 * synchronous throw is reported during the layout segment's own encode, so it
 * is collected before the streamed handler's redirect rejection lands.
 */
function FailingChild(): React.ReactNode {
  throw new Error("child failed");
}

function makeRouter(
  config: PrerenderConfig,
  options: { id?: string; version?: string } = {},
) {
  return createRouter({ ...options, prerender: config }).routes(
    urls(({ path, layout, loading, loader, parallel }) => [
      path("/article/:slug", ArticleDef, { name: "article" }, () => [
        loader(StampLoader),
      ]),
      path("/personalized/:slug", PersonalizedDef, { name: "personalized" }),
      path("/versions/:slug", VersionsDef, { name: "versions" }),
      path("/hot/:slug", HotDef, { name: "hot" }),
      path("/home", () => <p>home</p>, { name: "home" }),
      path("/redir-route/:slug", RedirectRouteDef, { name: "redirectRoute" }),
      path("/redir-passthrough/:slug", RedirectPassthroughDef, {
        name: "redirectPassthrough",
      }),
      layout(
        () => {
          attempt("layout");
          if (redirecting.layout) throw redirect("/login");
          return <main>layout</main>;
        },
        () => [
          path("/redir-layout/:slug", RedirectLayoutPageDef, {
            name: "redirectLayout",
          }),
        ],
      ),
      layout(
        () => <main>slots</main>,
        () => [
          parallel({
            // Returned, not thrown: a slot's handler result is not run
            // through handleHandlerResult (segment-resolution/revalidation.ts
            // keeps it as the segment component), so a Response reaches the
            // encoder. The cast is the shape an untyped app writes.
            "@side": () => {
              attempt("slot");
              if (redirecting.slot) {
                return redirect("/login") as unknown as React.ReactNode;
              }
              return <aside>side</aside>;
            },
          }),
          path("/redir-slot/:slug", RedirectSlotPageDef, {
            name: "redirectSlot",
          }),
        ],
      ),
      path(
        "/redir-loading/:slug",
        RedirectLoadingDef,
        {
          name: "redirectLoading",
        },
        () => [loading(<p>loading spinner</p>)],
      ),
      // A streamed handler that redirects while the layout's own child fails:
      // the redirect is the render's answer, the failure is the render's
      // failure, and the failure is what a refresh reports.
      layout(
        () =>
          redirecting.failingLayout ? (
            <main>
              <FailingChild />
            </main>
          ) : (
            <main>failing</main>
          ),
        () => [
          path(
            "/redir-failing/:slug",
            FailingPageDef,
            {
              name: "redirectFailing",
            },
            () => [loading(<p>failing spinner</p>)],
          ),
        ],
      ),
    ]),
  );
}

describe("on-demand prerender: router.prerender() then serve", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    counts.producer = 0;
    counts.loader = 0;
    holdRender = undefined;
    for (const key of Object.keys(redirecting)) {
      (redirecting as Record<string, boolean>)[key] = false;
    }
    for (const key of Object.keys(renderCounts)) delete renderCounts[key];
    for (const key of Object.keys(renderAttempts)) delete renderAttempts[key];
  });

  afterEach(() => {
    setBuildVersions();
    vi.restoreAllMocks();
  });

  it("serves the stored payload while loaders resolve fresh", async () => {
    const router = makeRouter({ store });

    const result = await router.prerender({ env: {} })("/article/intro");
    expect(result).toMatchObject({
      ok: true,
      status: "rendered",
      routeName: "article",
      tags: ["article:intro"],
      ttl: 3600,
    });
    expect(counts.producer).toBe(1);

    const first = await serveShellRequest(router, "/article/intro");
    const second = await serveShellRequest(router, "/article/intro");
    expect(first.response.status).toBe(200);
    // The producer did not run in either request: both serve its one render.
    expect(counts.producer).toBe(1);
    expect(first.flight).toContain("intro:stamp-1");
    expect(second.flight).toContain("intro:stamp-1");
    // Loaders are never stored: each request ran the loader again.
    expect(first.flight).toContain("loader-1");
    expect(second.flight).toContain("loader-2");
  });

  it("returns skipped-personalized and stores nothing when the producer reads cookies()", async () => {
    const router = makeRouter({ store });

    const result = await router.prerender({ env: {} })("/personalized/a");

    expect(result).toMatchObject({
      ok: false,
      status: "skipped-personalized",
      routeName: "personalized",
    });
    expect(store.size).toBe(0);
  });

  it("the router verifies a store's answer: another param set's entry is not served", async () => {
    // A naive store that answers every key with the last envelope written.
    let last: PrerenderStoredEntry | null = null;
    const naive: WritablePrerenderStore = {
      async get() {
        return last;
      },
      async set(_key, stored) {
        last = stored;
      },
    };
    const router = makeRouter({ store: naive });
    await router.prerender({ env: {} })("/article/a");
    expect((await serveShellRequest(router, "/article/a")).flight).toContain(
      "a:stamp-1",
    );

    const other = await serveShellRequest(router, "/article/b");
    expect(other.body).not.toContain("a:stamp-1");
  });

  describe("the trigger and the request handler use one key version", () => {
    it("with the router's data version from the build", async () => {
      setBuildVersions({
        data: "d-all",
        document: "h-all",
        routers: { "od-app": { data: "d-app", document: "h-app" } },
      });
      const router = makeRouter({ store }, { id: "od-app" });

      await router.prerender({ env: {} })("/article/v");

      expect(store.entries()[0]?.[1].meta.version).toBe("d-app");
      expect((await serveShellRequest(router, "/article/v")).flight).toContain(
        "v:stamp-1",
      );

      // A client-only deploy keeps the data version: the refreshed page stays.
      setBuildVersions({
        data: "d-all",
        document: "h-all-2",
        routers: { "od-app": { data: "d-app", document: "h-app-2" } },
      });
      expect((await serveShellRequest(router, "/article/v")).flight).toContain(
        "v:stamp-1",
      );

      // A server deploy moves it: the entry is no longer read.
      setBuildVersions({
        data: "d-all-2",
        document: "h-all-3",
        routers: { "od-app": { data: "d-app-2", document: "h-app-3" } },
      });
      expect(
        (await serveShellRequest(router, "/article/v")).flight ?? "",
      ).not.toContain("v:stamp-1");
    });
  });

  it("a long-lived handler follows a data version change, as the trigger does", async () => {
    setBuildVersions({ data: "d-1", document: "h-1" });
    const router = makeRouter({ store });
    await router.prerender({ env: {} })("/article/v");
    expect((await serveShellRequest(router, "/article/v")).flight).toContain(
      "v:stamp-1",
    );

    // Same document version: the handler is reused, the data version moved.
    setBuildVersions({ data: "d-2", document: "h-1" });
    await router.prerender({ env: {} })("/article/v");
    expect(store.entries().map(([, e]) => e.meta.version)).toEqual([
      "d-1",
      "d-2",
    ]);
    expect((await serveShellRequest(router, "/article/v")).flight).toContain(
      "v:stamp-2",
    );
  });

  it("a cache key built inside a refresh carries the router's versions", async () => {
    const warn = vi.spyOn(console, "warn");
    setBuildVersions({
      data: "d-all",
      document: "h-all",
      routers: { "od-app": { data: "d-app", document: "h-app" } },
    });
    const router = makeRouter({ store }, { id: "od-app" });

    const result = await router.prerender({ env: {} })("/versions/a");

    expect(result).toMatchObject({ ok: true, status: "rendered" });
    expect((await serveShellRequest(router, "/versions/a")).flight).toContain(
      "versions:d-app/h-app",
    );
    expect(
      warn.mock.calls.some((args) =>
        String(args[0]).includes("built outside a request"),
      ),
    ).toBe(false);
  });

  it("schedules onRevalidate once per stale key while one is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onRevalidate = vi.fn(() => gate);
    // Stale as soon as written (ttl 0), so every serve is a stale hit.
    let reads = 0;
    const counting: MemoryPrerenderStore = {
      ...store,
      async get(key) {
        const stored = await store.get(key);
        reads += 1;
        // Both requests have read (and so checked the in-flight set) before
        // the first scheduled task settles.
        if (reads === 2) setTimeout(release, 0);
        return stored;
      },
    };
    const router = makeRouter({
      store: counting,
      ttl: 0,
      onRevalidate,
    });
    await router.prerender({ env: {} })("/hot/a");
    // The refresh read the key once before its write (the removal race
    // check): count the two requests' reads only.
    reads = 0;

    const env = { binding: "live" };
    await Promise.all([
      serveShellRequest(router, "/hot/a", { env }),
      serveShellRequest(router, "/hot/a", { env }),
    ]);
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onRevalidate).toHaveBeenCalledWith(
      { route: "hot", params: { slug: "a" } },
      env,
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    );

    // Settled: the next stale hit schedules again.
    await serveShellRequest(router, "/hot/a", { env });
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });

  // #1072: a refresh that started before markStale() renders pre-invalidation
  // content, so the entry it stores is stale although its ttl has not passed.
  it("a refresh that started before markStale() leaves an entry the next request treats as stale", async () => {
    const onRevalidate = vi.fn();
    const router = makeRouter({ store, onRevalidate });
    const prerender = router.prerender({ env: {} });

    // Control: an undisturbed refresh is fresh (ttl 3600), no revalidation.
    await prerender("/article/calm");
    await serveShellRequest(router, "/article/calm");
    expect(onRevalidate).not.toHaveBeenCalled();

    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    holdRender = { entered, gate };
    const refresh = prerender("/article/intro");
    await hasEntered;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prerender.markStale(["article:intro"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    holdRender = undefined;
    release();
    expect(await refresh).toMatchObject({ ok: true, status: "rendered" });

    const served = await serveShellRequest(router, "/article/intro");
    expect(served.response.status).toBe(200);
    expect(served.flight).toContain("intro:stamp-");
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onRevalidate.mock.calls[0]![0]).toEqual({
      route: "article",
      params: { slug: "intro" },
    });
  });

  // A refresh right after markStale() in the same process renders content
  // newer than the mark: the entry is fresh, whatever millisecond each ran in.
  it("markStale() then a refresh in the same tick leaves a fresh entry that schedules no onRevalidate", async () => {
    const onRevalidate = vi.fn();
    const router = makeRouter({ store, onRevalidate });
    const prerender = router.prerender({ env: {} });
    const slugs = Array.from({ length: 25 }, (_, i) => `tick-${i}`);

    for (const slug of slugs) {
      await prerender.markStale([`article:${slug}`]);
      await prerender(`/article/${slug}`);
    }
    for (const slug of slugs) {
      expect(
        await prerender(`/article/${slug}`, { onlyIfStale: true }),
      ).toMatchObject({ ok: true, status: "already-fresh" });
      await serveShellRequest(router, `/article/${slug}`);
    }
    expect(onRevalidate).not.toHaveBeenCalled();
  });
});

// A render that answers redirect() says nothing about the page itself: the
// redirect can depend on the request (a session or auth check), so the refresh
// stores nothing, neither a page nor a "removed" marker, and the page stored
// before keeps serving. The result is its own status, skipped-redirect, so a
// sweep does not report a failure for a page that is fine.
describe("on-demand prerender: a redirecting refresh keeps the page", () => {
  let store: MemoryPrerenderStore;

  beforeEach(async () => {
    await resetShellTestState();
    store = createMemoryPrerenderStore();
    for (const key of Object.keys(redirecting)) {
      (redirecting as Record<string, boolean>)[key] = false;
    }
    for (const key of Object.keys(renderCounts)) delete renderCounts[key];
    for (const key of Object.keys(renderAttempts)) delete renderAttempts[key];
  });

  afterEach(() => {
    setBuildVersions();
    vi.restoreAllMocks();
  });

  const kinds = [
    ["route", "/redir-route/a", "route", "redirectRoute", "route"],
    [
      "passthrough",
      "/redir-passthrough/a",
      "passthrough",
      "redirectPassthrough",
      "passthrough",
    ],
    ["layout", "/redir-layout/a", "layout", "redirectLayout", "layout"],
    ["slot", "/redir-slot/a", "slot", "redirectSlot", "slot"],
    ["loading", "/redir-loading/a", "loading", "redirectLoading", "loading"],
  ] as const;

  for (const [kind, url, label, routeName, attemptKey] of kinds) {
    it(`${kind}: reports skipped-redirect, stores nothing and keeps serving the page`, async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });

      // A page is stored first, so there is something a redirect could destroy.
      expect(await prerender(url)).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const stored = await serveShellRequest(router, url);
      expect(stored.response.status).toBe(200);
      expect(stored.flight).toContain(`${label}:a:r1`);

      // The same render now answers redirect(): its own result, and no write.
      (redirecting as Record<string, boolean>)[kind] = true;
      const attemptsBefore = renderAttempts[attemptKey] ?? 0;
      expect(await prerender(url)).toMatchObject({
        ok: false,
        path: "on-demand",
        status: "skipped-redirect",
        target: url,
        routeName,
      });
      expect(store.size).toBe(1);
      expect(store.entries()[0]![1].entry).toBeDefined();
      // The handler that answers the redirect ran, and only it did.
      expect(renderAttempts[attemptKey], "the refresh rendered").toBe(
        attemptsBefore + 1,
      );
      const attemptsAfterRefresh = renderAttempts[attemptKey];

      // A document and a client navigation both still get the stored page.
      const document = await serveShellRequest(router, url);
      expect(document.response.status).toBe(200);
      expect(document.flight).toBe(stored.flight);
      const navigation = await serveShellRequest(router, url, {
        partial: { from: "/home" },
      });
      expect(navigation.response.status).toBe(200);
      expect(navigation.flight).toContain(`${label}:a:r1`);

      // The entry is untouched, so it is still fresh and nothing re-rendered.
      expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
        ok: true,
        status: "already-fresh",
      });
      expect(renderAttempts[attemptKey], "no serve rendered it").toBe(
        attemptsAfterRefresh,
      );

      // Marked stale, a sweep renders it again: still a redirect, still no
      // write, and the stored page is what the next request gets.
      await prerender.markStale([`redirect:a`]);
      expect(await prerender(url, { onlyIfStale: true })).toMatchObject({
        ok: false,
        status: "skipped-redirect",
      });
      expect(store.size).toBe(1);
      expect(renderAttempts[attemptKey], "the sweep rendered it").toBe(
        attemptsAfterRefresh + 1,
      );
      expect((await serveShellRequest(router, url)).flight).toContain(
        `${label}:a:r1`,
      );

      // A later refresh that renders a page replaces the entry.
      (redirecting as Record<string, boolean>)[kind] = false;
      expect(await prerender(url)).toMatchObject({
        ok: true,
        status: "rendered",
      });
      expect((await serveShellRequest(router, url)).flight).toContain(
        `${label}:a:r${renderCounts[label]}`,
      );
    });
  }

  it("every response shape serves the stored page, with no internal field", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    await prerender("/redir-route/a");
    redirecting.route = true;
    expect(await prerender("/redir-route/a")).toMatchObject({
      status: "skipped-redirect",
    });

    const shapes = await serveEveryShape(router, {
      from: "/home",
      to: "/redir-route/a",
    });
    for (const { name, result } of shapes) {
      expect(result.response.status, name).toBe(200);
      expect(result.flight, name).toContain(
        name.startsWith("document from") ? "home" : "route:a:r1",
      );
    }
    expectNoInternalFields(shapes);
  });

  it("a render that redirects and also fails stays render-failed", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });
    const url = "/redir-failing/a";

    expect(await prerender(url)).toMatchObject({
      ok: true,
      status: "rendered",
    });
    // The handler behind loading() answers redirect() while the layout's own
    // child fails: the failure is what a refresh reports, and the page stays.
    redirecting.failingLayout = true;
    const result = await prerender(url);
    expect(result).toMatchObject({ ok: false, status: "render-failed" });
    if (result.ok) throw new Error("expected fail");
    expect((result.error as Error).message).toBe("child failed");
    expect(store.size).toBe(1);
    expect((await serveShellRequest(router, url)).flight).toContain(
      "failing:a:r1",
    );
  });

  it("a non-redirect Response from a handler stays render-failed", async () => {
    // A handler that answers with a Response other than a redirect is a
    // failure, not an answer: the page stays and the result says so.
    const failing = Prerender<{ slug: string }>(
      async () => [],
      async () => {
        throw new Response("nope", { status: 500 });
      },
      { onDemand: true },
    );
    const router = createRouter({ prerender: { store } }).routes(
      urls(({ path }) => [
        path("/redir-500/:slug", failing, { name: "redirect500" }),
      ]),
    );
    const result = await router.prerender({ env: {} })("/redir-500/a");
    expect(result).toMatchObject({ ok: false, status: "render-failed" });
    expect(store.size).toBe(0);
  });
});
