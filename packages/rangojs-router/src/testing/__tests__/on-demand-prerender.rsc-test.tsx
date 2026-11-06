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
import { withLocationStateKey } from "../location-state-key.js";
import { createMemoryPrerenderStore, setBuildVersions } from "../index.js";
import {
  cookies,
  createLoader,
  createLocationState,
  createRouter,
  notFound,
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

/** Slugs whose page moved: the render answers a redirect instead of a page. */
const moved = new Set<string>();

const MovedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    counts.producer += 1;
    if (moved.has(ctx.params.slug)) {
      throw redirect(`/article/new-${ctx.params.slug}`, 301);
    }
    return <h1>{`${ctx.params.slug}:stamp-${counts.producer}`}</h1>;
  },
  { onDemand: { ttl: 3600, tags: ({ params }) => [`moved:${params.slug}`] } },
);

// A redirect anywhere in the render counts, a server component included: the
// Flight error row carries the same Response.
const ComponentMovedDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    if (moved.has(ctx.params.slug)) {
      throw redirect(`/component-moved/${ctx.params.slug}`, 302);
    }
    return <h1>{ctx.params.slug}</h1>;
  },
  { onDemand: true },
);

const Flash = withLocationStateKey(
  createLocationState<{ text: string }>(),
  "Flash",
);

const StateRedirectDef = Prerender<{ slug: string }>(
  async () => [],
  async () => {
    throw redirect("/article/new-a", {
      state: [Flash({ text: "This page moved" })],
    });
  },
  { onDemand: true },
);

const OffHostDef = Prerender<{ slug: string }>(
  async () => [],
  async () => {
    throw redirect("https://accounts.example.com/oauth", { external: true });
  },
  { onDemand: true },
);

// One sibling redirects, another calls notFound(): both arrive as Flight error
// rows, so which outcome wins is firstFlightError's rule.
async function NotFoundSibling(): Promise<never> {
  notFound();
}

async function RedirectSibling(): Promise<never> {
  throw redirect("/sibling-moved", 302);
}

const MixedDef = Prerender<{ slug: string }>(
  async () => [],
  async () => (
    <div>
      <NotFoundSibling />
      <RedirectSibling />
    </div>
  ),
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
      path("/component-moved/:slug", ComponentMovedDef, {
        name: "componentMoved",
      }),
      path("/state-redirect/:slug", StateRedirectDef, {
        name: "stateRedirect",
      }),
      path("/off-host/:slug", OffHostDef, { name: "offHost" }),
      path("/mixed/:slug", MixedDef, { name: "mixed" }),
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
    moved.clear();
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

  /**
   * A page whose URL moved: the render answers with a redirect instead of a
   * page, so the stored page must stop serving and the request must answer the
   * redirect, exactly as the live handler would. A "removed" marker would
   * answer 404 on a plain on-demand route (its handler is evicted at build).
   */
  describe("a refresh whose render redirects", () => {
    it("stores the redirect in place of the page: the document and a client navigation both answer it", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });

      expect(await prerender("/moved/a")).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const before = await serveShellRequest(router, "/moved/a");
      expect(before.response.status).toBe(200);
      expect(before.flight).toContain("a:stamp-1");

      moved.add("a");
      expect(await prerender("/moved/a")).toMatchObject({
        ok: true,
        path: "on-demand",
        status: "redirected",
        target: "/moved/a",
        routeName: "moved",
        tags: ["moved:a"],
        ttl: 3600,
        location: "/article/new-a",
      });

      const document = await serveShellRequest(router, "/moved/a");
      expect(document.response.status).toBe(301);
      expect(document.response.headers.get("Location")).toBe("/article/new-a");
      // The stored page is gone: no stamp of it rides along.
      expect(document.body).not.toContain("a:stamp-1");

      // A client navigation gets the Flight form of the same redirect, as it
      // does from a live handler (204 + the resolved target).
      const partial = await serveShellRequest(router, "/moved/a", {
        partial: { from: "/hot/a" },
      });
      expect(partial.response.status).toBe(204);
      expect(partial.response.headers.get("X-RSC-Redirect")).toBe(
        "http://localhost/article/new-a",
      );

      // The URL moved back: the next refresh renders a page that replaces it.
      moved.delete("a");
      expect(await prerender("/moved/a")).toMatchObject({
        ok: true,
        status: "rendered",
      });
      const after = await serveShellRequest(router, "/moved/a");
      expect(after.response.status).toBe(200);
      expect(after.flight).toContain("a:stamp-");
      expect(after.flight).not.toContain("a:stamp-1");
    });

    it("onlyIfStale on a fresh redirect renders nothing and still says where it goes", async () => {
      const router = makeRouter({ store });
      const prerender = router.prerender({ env: {} });
      moved.add("a");
      await prerender("/moved/a");

      expect(await prerender("/moved/a", { onlyIfStale: true })).toMatchObject({
        ok: true,
        status: "redirected",
        location: "/article/new-a",
        ttl: 3600,
      });
      expect(counts.producer).toBe(1);
    });

    it("a redirect from a server component is stored too", async () => {
      const router = makeRouter({ store });
      moved.add("a");

      expect(
        await router.prerender({ env: {} })("/component-moved/a"),
      ).toMatchObject({
        ok: true,
        status: "redirected",
        location: "/component-moved/a",
      });
      const served = await serveShellRequest(router, "/component-moved/a");
      expect(served.response.status).toBe(302);
      expect(served.response.headers.get("Location")).toBe(
        "/component-moved/a",
      );
    });

    it("carries redirect(url, { state }) the way a live redirect does: the one-shot cookie on a document request, the Flight payload on a client navigation", async () => {
      const router = makeRouter({ store });
      expect(
        await router.prerender({ env: {} })("/state-redirect/a"),
      ).toMatchObject({ ok: true, status: "redirected" });

      const document = await serveShellRequest(router, "/state-redirect/a");
      expect(document.response.status).toBe(302);
      expect(document.response.headers.get("Location")).toBe("/article/new-a");
      // The state is per visitor on a document request: a one-shot cookie the
      // target's own document request reads, and a private response.
      expect(document.response.headers.get("Cache-Control")).toBe(
        "private, no-store",
      );
      const cookie = document.response.headers.get("Set-Cookie") ?? "";
      expect(cookie).toContain("-ls=");
      expect(decodeURIComponent(cookie)).toContain(
        '"p":"/article/new-a","s":{"__rsc_ls_Flash":{"text":"This page moved"}}',
      );

      // A client navigation carries it in the redirect payload instead.
      const partial = await serveShellRequest(router, "/state-redirect/a", {
        partial: { from: "/hot/a" },
      });
      expect(partial.body).toContain('"locationState"');
      expect(partial.body).toContain('"text":"This page moved"');
      expect(partial.body).toContain('"redirect"');
    });

    it("a redirect outranks a notFound() collected in the same render, and a real failure outranks both", async () => {
      const router = makeRouter({ store });

      // One component redirects, one calls notFound(): the redirect is an
      // answer for this URL, the notFound() may be an unrelated sibling.
      expect(await router.prerender({ env: {} })("/mixed/a")).toMatchObject({
        ok: true,
        status: "redirected",
        location: "/sibling-moved",
      });
    });

    it("an off-host redirect keeps its external opt-in: the guard does not neutralize the stored target", async () => {
      const router = makeRouter({ store });
      expect(await router.prerender({ env: {} })("/off-host/a")).toMatchObject({
        ok: true,
        status: "redirected",
      });

      const served = await serveShellRequest(router, "/off-host/a");
      expect(served.response.status).toBe(302);
      expect(served.response.headers.get("Location")).toBe(
        "https://accounts.example.com/oauth",
      );
    });
  });
});
