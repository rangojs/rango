/**
 * router.prerender() for every route (docs/design/prerender-every-route.md),
 * through the public testing primitives: the runner warms a route that is not
 * `Prerender(..., { onDemand })` with a cookie-free GET through the router's
 * request handler, where every cache read misses and every write replaces the
 * entry under the key a visitor's request uses. `serveShellRequest` then
 * serves the next visitor's request through the production handler, so a
 * warmed `ppr` route is a real shell HIT and a warmed `cache()` route a real
 * record HIT.
 *
 * Design phase: these pin the decided behavior and fail until it is built.
 * Today the runner answers `skipped-not-on-demand` for every route here except
 * the on-demand one, and renders nothing.
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
  cookies,
  createLoader,
  createRouter,
  Prerender,
  urls,
} from "../../index.rsc.js";
import {
  MemorySegmentCacheStore,
  type SegmentCacheStore,
} from "../../cache/index.js";

/** The origin serveShellRequest resolves paths against: the warm targets it. */
const ORIGIN = "http://localhost";

/**
 * A store that declares its entries visible to every location, as a
 * single-process deployment may (the e2e test-app does the same). The shipped
 * MemorySegmentCacheStore declares itself local.
 */
class SharedMemoryStore extends MemorySegmentCacheStore {
  readonly scope = "global" as const;
}

/** Handler, producer and loader runs, to tell a stored render from a fresh one. */
const runs = { shelled: 0, cached: 0, producer: 0, cachedLoader: 0 };

/** What /shelled renders; a test moves it to tell an old shell from a new one. */
let content = "v1";

/**
 * Hold the next /shelled handler run until released, so a test can serve a
 * visitor while a warm is mid-render. `entered` reports that a run is held.
 */
let hold: Promise<void> | undefined;
let entered: (() => void) | undefined;

async function ShelledPage(): Promise<React.ReactNode> {
  runs.shelled += 1;
  const held = hold;
  if (held) {
    hold = undefined;
    entered?.();
    await held;
  }
  return <h1>{`shelled-${content}`}</h1>;
}

function CachedPage(): React.ReactNode {
  runs.cached += 1;
  return <p>{`cached-run-${runs.cached}`}</p>;
}

function PersonalPage(): React.ReactNode {
  return <p>{`personal-${cookies().get("session")?.value ?? "anonymous"}`}</p>;
}

const CachedStampLoader = createLoader(async () => {
  runs.cachedLoader += 1;
  return { stamp: `loader-${runs.cachedLoader}` };
});

const ArticleDef = Prerender<{ slug: string }>(
  async () => [],
  async (ctx) => {
    runs.producer += 1;
    return <h1>{`${ctx.params.slug}:stamp-${runs.producer}`}</h1>;
  },
  { onDemand: true },
);

function makeRouter(store: SegmentCacheStore) {
  return createRouter({
    cache: { store },
    prerender: { store: createMemoryPrerenderStore() },
  }).routes(
    urls(({ path, loader, cache }) => [
      path("/shelled", ShelledPage, { name: "shelled", ppr: true }),
      path("/personal", PersonalPage, { name: "personal", ppr: true }),
      cache({ ttl: 300 }, () => [
        path("/cached", CachedPage, { name: "cached" }),
      ]),
      path("/article/:slug", ArticleDef, { name: "article" }, () => [
        loader(CachedStampLoader, () => [cache({ ttl: 300 })]),
      ]),
    ]),
  );
}

beforeEach(async () => {
  await resetShellTestState();
  runs.shelled = 0;
  runs.cached = 0;
  runs.producer = 0;
  runs.cachedLoader = 0;
  content = "v1";
  hold = undefined;
  entered = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("router.prerender() warms a route that is not on-demand", () => {
  it("warming a ppr route fills its shell: the next document request is a HIT", async () => {
    const router = makeRouter(new SharedMemoryStore());

    const result = await router.prerender({ env: {} })(`${ORIGIN}/shelled`);

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      routeName: "shelled",
    });
    const hit = await serveShellRequest(router, "/shelled");
    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("shelled-v1");
  });

  it("warming replaces a shell in place: the old shell serves until the new one is written", async () => {
    const router = makeRouter(new SharedMemoryStore());
    expect((await serveShellRequest(router, "/shelled")).shellStatus).toBe(
      "MISS",
    );
    const before = await serveShellRequest(router, "/shelled");
    expect(before.shellStatus).toBe("HIT");
    expect(before.prelude).toContain("shelled-v1");

    content = "v2";
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const warming = router.prerender({ env: {} })(`${ORIGIN}/shelled`);
    await Promise.race([blocked, warming]);

    // The warm is rendering and has written nothing: no eviction up front,
    // so a visitor still gets the old shell.
    const during = await serveShellRequest(router, "/shelled");
    expect(during.shellStatus).toBe("HIT");
    expect(during.prelude).toContain("shelled-v1");

    release();
    expect(await warming).toMatchObject({ ok: true, status: "warmed" });
    const after = await serveShellRequest(router, "/shelled");
    expect(after.shellStatus).toBe("HIT");
    expect(after.prelude).toContain("shelled-v2");
  });

  it("warming a route with cache() fills its record", async () => {
    const router = makeRouter(new SharedMemoryStore());

    const result = await router.prerender({ env: {} })(`${ORIGIN}/cached`);

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      routeName: "cached",
    });
    expect(runs.cached).toBe(1);
    const served = await serveShellRequest(router, "/cached");
    expect(served.flight).toContain("cached-run-1");
    // The visitor's request was a record HIT: the handler did not run again.
    expect(runs.cached).toBe(1);
  });

  it("warming replaces a cache() record a visitor wrote", async () => {
    const router = makeRouter(new SharedMemoryStore());
    await serveShellRequest(router, "/cached");
    expect((await serveShellRequest(router, "/cached")).flight).toContain(
      "cached-run-1",
    );

    const result = await router.prerender({ env: {} })(`${ORIGIN}/cached`);

    // The warm's read missed although a fresh record existed, and its write
    // replaced that record under the same key.
    expect(result).toMatchObject({ ok: true, status: "warmed" });
    expect(runs.cached).toBe(2);
    const after = await serveShellRequest(router, "/cached");
    expect(after.flight).toContain("cached-run-2");
    expect(runs.cached).toBe(2);
  });

  it("a store whose entries live in one process is refused, and nothing renders", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const router = makeRouter(new MemorySegmentCacheStore());

    const result = await router.prerender({ env: {} })(`${ORIGIN}/shelled`);

    expect(result).toMatchObject({
      ok: false,
      status: "skipped-store-not-shared",
      routeName: "shelled",
    });
    expect(runs.shelled).toBe(0);
    expect((await serveShellRequest(router, "/shelled")).shellStatus).toBe(
      "MISS",
    );
  });

  it("a custom store that declares no scope is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const inner = new MemorySegmentCacheStore();
    const custom: SegmentCacheStore = {
      get: (key) => inner.get(key),
      set: (key, data, ttl, swr) => inner.set(key, data, ttl, swr),
      delete: (key) => inner.delete(key),
    };
    const router = makeRouter(custom);

    const result = await router.prerender({ env: {} })(`${ORIGIN}/cached`);

    expect(result).toMatchObject({
      ok: false,
      status: "skipped-store-not-shared",
      routeName: "cached",
    });
    expect(runs.cached).toBe(0);
  });

  it("a route that reads cookies() stores no shell and reports skipped-personalized", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const router = makeRouter(new SharedMemoryStore());

    const result = await router.prerender({ env: {} })(`${ORIGIN}/personal`);

    expect(result).toMatchObject({
      ok: false,
      status: "skipped-personalized",
      routeName: "personal",
    });
    // The capture's identity guard refused the shell: nothing was stored.
    expect((await serveShellRequest(router, "/personal")).shellStatus).toBe(
      "MISS",
    );
  });
});

describe("router.prerender().many() mixing on-demand and warm targets", () => {
  it("returns one result per target, in order, each with its path's status", async () => {
    const router = makeRouter(new SharedMemoryStore());

    const results = await router
      .prerender({ env: {} })
      .many([`${ORIGIN}/article/m`, `${ORIGIN}/shelled`]);

    expect(results.map((r) => [r.status, r.routeName])).toEqual([
      ["rendered", "article"],
      ["warmed", "shelled"],
    ]);
    expect(results).toMatchObject([
      { ok: true, path: "on-demand" },
      { ok: true, path: "warm" },
    ]);
  });

  it("on a local store the on-demand target still renders and the warm target is refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const router = makeRouter(new MemorySegmentCacheStore());

    const results = await router
      .prerender({ env: {} })
      .many([`${ORIGIN}/article/m`, `${ORIGIN}/shelled`]);

    expect(results.map((r) => [r.ok, r.status])).toEqual([
      [true, "rendered"],
      [false, "skipped-store-not-shared"],
    ]);
    expect(runs.shelled).toBe(0);
  });
});

describe("an on-demand route keeps the requestless render of #640", () => {
  it("renders into the prerender store, then warms its loaders' own caches through the request handler", async () => {
    const router = makeRouter(new SharedMemoryStore());

    const result = await router.prerender({ env: {} })(
      `${ORIGIN}/article/intro`,
    );

    expect(result).toMatchObject({
      ok: true,
      status: "rendered",
      routeName: "article",
    });
    expect(runs.producer).toBe(1);
    // The producer stores no loader; the warm request that follows the store
    // write ran the loader once and filled its own cache().
    expect(runs.cachedLoader).toBe(1);
    const served = await serveShellRequest(router, "/article/intro");
    expect(served.flight).toContain("intro:stamp-1");
    expect(served.flight).toContain("loader-1");
    expect(runs.producer).toBe(1);
    expect(runs.cachedLoader).toBe(1);
  });
});
