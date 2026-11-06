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
import { getCacheVersions } from "../../cache/index.js";
import type {
  MemoryPrerenderStore,
  PrerenderConfig,
  PrerenderStoredEntry,
  WritablePrerenderStore,
} from "../../prerender/index.js";

/** Producer renders and loader runs, to tell a stored payload from a render. */
const counts = { producer: 0, loader: 0, moved: 0, live: 0 };

/**
 * The pages whose URL changed: slug -> the slug the app redirects to. A slug
 * in here makes the producer answer `redirect()` instead of a page, which is
 * how an app sends a visitor to the page's new address.
 */
const moved = new Map<string, string>();

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

// A route whose handler may redirect instead of answering a page. A Prerender
// handler returns a ReactNode, so a redirect is thrown, as notFound() is.
const MovedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    const target = moved.get(ctx.params.slug);
    if (target !== undefined) throw redirect(`/article/${target}`, 308);
    counts.moved += 1;
    return <h1>{`${ctx.params.slug}:stamp-${counts.moved}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`article:${params.slug}`] } },
);

// The same answer from a Passthrough route's build handler: the stored
// redirect answers, and the live handler (which would render per request) is
// not run.
const MovedLive = Passthrough(MovedDef, async (ctx) => {
  counts.live += 1;
  return <h1>{`live:${ctx.params.slug}`}</h1>;
});

// An off-host redirect with redirect()'s explicit opt-in: the serve path has
// to carry it, or the open-redirect guard rewrites the target to the app root.
const OffHostDef = Prerender<{ slug: string }>(
  async () => [],
  async () => {
    throw redirect("https://accounts.example.com/session", {
      status: 302,
      external: true,
    });
  },
  { onDemand: true },
);

function makeRouter(
  config: PrerenderConfig,
  options: { id?: string; version?: string } = {},
) {
  return createRouter({ ...options, prerender: config }).routes(
    urls(({ path, loader }) => [
      path("/article/:slug", ArticleDef, { name: "article" }, () => [
        loader(StampLoader),
      ]),
      path("/personalized/:slug", PersonalizedDef, { name: "personalized" }),
      path("/versions/:slug", VersionsDef, { name: "versions" }),
      path("/hot/:slug", HotDef, { name: "hot" }),
      path("/moved/:slug", MovedDef, { name: "moved" }),
      path("/moved-live/:slug", MovedLive, { name: "movedLive" }),
      path("/off-host/:slug", OffHostDef, { name: "offHost" }),
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
    counts.moved = 0;
    counts.live = 0;
    moved.clear();
    holdRender = undefined;
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

  // A page whose URL changed: the handler answers redirect(), the way an app
  // sends a visitor (and a crawler) to the page's new address. The refresh
  // stores that answer, so the URL stops serving the page a previous refresh
  // stored and answers the redirect without rendering per request.
  it("a refresh whose handler redirects stores the redirect: the URL answers it, not the page stored before", async () => {
    const router = makeRouter({ store });
    const prerender = router.prerender({ env: {} });

    expect(await prerender("/moved/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const page = await serveShellRequest(router, "/moved/a");
    expect(page.response.status).toBe(200);
    expect(page.flight).toContain("a:stamp-1");

    // The page moved. A refresh now answers redirect() instead of a page.
    moved.set("a", "b");
    try {
      expect(await prerender("/moved/a")).toMatchObject({
        ok: true,
        path: "on-demand",
        status: "redirected",
        target: "/moved/a",
        routeName: "moved",
        redirect: { status: 308, location: "/article/b" },
      });

      // The visitor gets the redirect: not the page stored a moment ago, and
      // not a render per request (the producer ran once, for the refresh).
      // Nothing rides along: no body, no Flight payload.
      const redirected = await serveShellRequest(router, "/moved/a");
      expect(redirected.response.status).toBe(308);
      expect(redirected.response.headers.get("location")).toBe("/article/b");
      expect(redirected.body).toBe("");
      expect(redirected.flight).toBeUndefined();
      expect(counts.moved).toBe(1);

      // A client navigation is answered the same way a handler's redirect is:
      // a soft redirect the router follows, not a 3xx the fetch would.
      const partial = await serveShellRequest(router, "/moved/a", {
        partial: true,
      });
      // The soft redirect carries the absolute same-origin target, as it does
      // for a handler's redirect on a client navigation.
      expect(partial.response.headers.get("x-rsc-redirect")).toBe(
        "http://localhost/article/b",
      );
      expect(counts.moved).toBe(1);
    } finally {
      moved.delete("a");
    }

    // Moved back: a refresh replaces the redirect with the page.
    expect(await prerender("/moved/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const back = await serveShellRequest(router, "/moved/a");
    expect(back.response.status).toBe(200);
    expect(back.flight).toContain("a:stamp-2");
  });

  // The other route kind: a Passthrough route's stored redirect answers too,
  // and the live handler (a render per request) is not run for it.
  it("a Passthrough route's stored redirect answers, not its live handler", async () => {
    const router = makeRouter({ store });
    moved.set("a", "b");
    try {
      expect(
        await router.prerender({ env: {} })("/moved-live/a"),
      ).toMatchObject({ ok: true, status: "redirected" });

      const redirected = await serveShellRequest(router, "/moved-live/a");
      expect(redirected.response.status).toBe(308);
      expect(redirected.response.headers.get("location")).toBe("/article/b");
      expect(counts.live).toBe(0);
    } finally {
      moved.delete("a");
    }
  });

  // redirect(url, { external: true }) is an out-of-band opt-in on the Response
  // object (redirect-origin.ts). The serve path builds its own Response, so it
  // has to carry the flag or the open-redirect guard sends the visitor to the
  // app root instead of the off-host target.
  it("an off-host redirect keeps redirect()'s external opt-in across the store", async () => {
    const router = makeRouter({ store });

    expect(await router.prerender({ env: {} })("/off-host/a")).toMatchObject({
      ok: true,
      status: "redirected",
      redirect: {
        status: 302,
        location: "https://accounts.example.com/session",
        external: true,
      },
    });

    const redirected = await serveShellRequest(router, "/off-host/a");
    expect(redirected.response.status).toBe(302);
    expect(redirected.response.headers.get("location")).toBe(
      "https://accounts.example.com/session",
    );
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
