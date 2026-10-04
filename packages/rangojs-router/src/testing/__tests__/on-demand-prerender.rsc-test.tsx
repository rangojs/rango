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
  Prerender,
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

const ArticleDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
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
  });

  afterEach(() => {
    setBuildVersions();
    vi.restoreAllMocks();
  });

  it("serves the stored payload while loaders resolve fresh", async () => {
    const router = makeRouter({ store });

    const result = await router.prerender("/article/intro", { env: {} });
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

    const result = await router.prerender("/personalized/a", { env: {} });

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
    await router.prerender("/article/a", { env: {} });
    expect((await serveShellRequest(router, "/article/a")).flight).toContain(
      "a:stamp-1",
    );

    const other = await serveShellRequest(router, "/article/b");
    expect(other.body).not.toContain("a:stamp-1");
  });

  describe("the trigger and the request handler use one key version", () => {
    it("with createRouter({ version })", async () => {
      setBuildVersions({ data: "d1", document: "h1" });
      const router = makeRouter({ store }, { version: "pinned" });

      const result = await router.prerender("/article/v", { env: {} });

      if (!result.ok) throw new Error(`expected ok, got ${result.status}`);
      expect(result.key).toContain(":pinned:");
      expect(store.entries()[0]?.[1].meta.version).toBe("pinned");
      expect((await serveShellRequest(router, "/article/v")).flight).toContain(
        "v:stamp-1",
      );
      expect(counts.producer).toBe(1);
    });

    it("with the router's data version from the build", async () => {
      setBuildVersions({
        data: "d-all",
        document: "h-all",
        routers: { "od-app": { data: "d-app", document: "h-app" } },
      });
      const router = makeRouter({ store }, { id: "od-app" });

      await router.prerender("/article/v", { env: {} });

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
    await router.prerender("/article/v", { env: {} });
    expect((await serveShellRequest(router, "/article/v")).flight).toContain(
      "v:stamp-1",
    );

    // Same document version: the handler is reused, the data version moved.
    setBuildVersions({ data: "d-2", document: "h-1" });
    await router.prerender("/article/v", { env: {} });
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

    const result = await router.prerender("/versions/a", { env: {} });

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
    await router.prerender("/hot/a", { env: {} });

    const env = { binding: "live" };
    await Promise.all([
      serveShellRequest(router, "/hot/a", { env }),
      serveShellRequest(router, "/hot/a", { env }),
    ]);
    expect(onRevalidate).toHaveBeenCalledTimes(1);
    expect(onRevalidate).toHaveBeenCalledWith(
      { route: "hot", params: { slug: "a" } },
      env,
    );

    // Settled: the next stale hit schedules again.
    await serveShellRequest(router, "/hot/a", { env });
    expect(onRevalidate).toHaveBeenCalledTimes(2);
  });
});
