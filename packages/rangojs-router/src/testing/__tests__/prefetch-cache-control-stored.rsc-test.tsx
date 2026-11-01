/**
 * A prefetch answer with nothing live in it leaves with the
 * router's prefetch Cache-Control (`private, max-age=<prefetchCacheTTL>`), so
 * the browser HTTP cache can answer a later prefetch or the click with it.
 * Nothing live means every segment the answer sends came from storage (a
 * route cache() record, a Prerender entry) and no loader runs, or the whole
 * answer is a document cache HIT. Every server writer refuses a failed render,
 * so a stored copy cannot carry one; a live segment or a loader can fail after
 * the 200's headers left (#1170), so any answer with one carries none. A
 * partial scoped to its source page keeps NOT_REUSED. Through the public
 * serveShellRequest primitive.
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

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import { createMemoryPrerenderStore } from "../index.js";
import {
  createLoader,
  createRouter,
  Prerender,
  redirect,
  urls,
  type Middleware,
} from "../../index.rsc.js";
import {
  createDocumentCacheMiddleware,
  MemorySegmentCacheStore,
} from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const STORED = "private, max-age=300";

const Stamp = createLoader(async () => ({ stamp: "loader-ran" }));

const Baked = Prerender(() => <article>baked</article>);
const BakedWithLoader = Prerender(() => <article>baked-loader</article>);

async function Failing(): Promise<React.ReactNode> {
  await new Promise((r) => setTimeout(r, 5));
  throw new Error("down after the headers");
}

function app(options: { prefetchCacheTTL?: number | false } = {}) {
  const cacheStore = new MemorySegmentCacheStore();
  /** Set: the outer middleware answers with a redirect after the render. */
  const bounce = { on: false };
  const router = createRouter({
    cache: { store: cacheStore },
    ...options,
  })
    .use(async (_ctx, next) => {
      const response = await next();
      if (!bounce.on) return response;
      // External: the partial gets the 200 Flight redirect, not a 204.
      return redirect("https://accounts.example.com/login", {
        external: true,
      });
    })
    .use("/stored-no-store", async (ctx, next) => {
      ctx.header("Cache-Control", "no-store");
      await next();
    })
    .use("/stored-max-age-zero", async (ctx, next) => {
      ctx.header("Cache-Control", "max-age=0");
      await next();
    })
    .use("/stored-must-revalidate", async (ctx, next) => {
      ctx.header("Cache-Control", "private, max-age=0, must-revalidate");
      await next();
    })
    .use("/stored-max-age-short", async (ctx, next) => {
      ctx.header("Cache-Control", "max-age=5");
      await next();
    })
    .routes(
      urls(({ path, layout, cache, loader, loading, errorBoundary }) => [
        path("/", () => <p>home</p>, { name: "home" }),
        path("/live", () => <p>live</p>, { name: "live" }),
        path("/failing", Failing, { name: "failing" }, () => [
          loading(<p>loading</p>),
          errorBoundary(<p>declared-error</p>),
        ]),
        cache({ ttl: 300 }, () => [
          path("/stored", () => <p>stored</p>, { name: "stored" }),
          path("/stored-no-store", () => <p>stored-no-store</p>, {
            name: "storedNoStore",
          }),
          path("/stored-max-age-zero", () => <p>stored-max-age-zero</p>, {
            name: "storedMaxAgeZero",
          }),
          path("/stored-must-revalidate", () => <p>stored-must-revalidate</p>, {
            name: "storedMustRevalidate",
          }),
          path("/stored-max-age-short", () => <p>stored-max-age-short</p>, {
            name: "storedMaxAgeShort",
          }),
          path(
            "/stored-loader",
            () => <p>stored-loader</p>,
            { name: "storedLoader" },
            () => [loader(Stamp)],
          ),
        ]),
        // A live layout above a cache() boundary: the record supplies the
        // routes, the layout renders live unless the client keeps it.
        layout(
          () => <main>live-layout</main>,
          () => [
            cache({ ttl: 300 }, () => [
              path("/under/a", () => <p>under-a</p>, { name: "underA" }),
              path("/under/b", () => <p>under-b</p>, { name: "underB" }),
            ]),
          ],
        ),
        path("/baked", Baked, { name: "baked" }),
        path("/baked-loader", BakedWithLoader, { name: "bakedLoader" }, () => [
          loader(Stamp),
        ]),
      ]),
    );

  const serve = (
    url: string,
    opts: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...opts });

  /** The ids a page at `at` holds once a navigation to it committed. */
  const held = async (at: string): Promise<string[]> =>
    matchedOf(await serve(at, { partial: { from: "/elsewhere" } }));

  /**
   * A prefetch of `url` from the page at `from`, which holds what a
   * navigation to it committed (the root layout, at least), as a client does.
   */
  const prefetch = async (url: string, from = "/", headers?: HeadersInit) =>
    serve(url, {
      partial: { from, segments: await held(from), prefetch: true },
      headers,
    });

  /** Store the route's cache() record: a navigation from `/` renders it. */
  const warm = async (url: string) => {
    await serve(url, { partial: { from: "/", segments: await held("/") } });
    await settle();
  };

  return { serve, held, prefetch, warm, bounce };
}

const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

const cacheControl = (result: ServeShellRequestResult) =>
  result.response.headers.get("cache-control");

async function matchedOf(result: ServeShellRequestResult): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(result.flight!);
  return metadata.matched;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("a prefetch answered from a route cache() record", () => {
  it("carries the prefetch Cache-Control on a HIT, none on the MISS that rendered it", async () => {
    const { prefetch } = app();
    const miss = await prefetch("/stored");
    expect(miss.flight).toContain("stored");
    expect(cacheControl(miss)).toBeNull();
    await settle();

    const hit = await prefetch("/stored");
    expect(hit.response.status).toBe(200);
    expect(hit.flight).toContain("stored");
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("carries none when a loader runs in the answer", async () => {
    const { prefetch, warm } = app();
    await warm("/stored-loader");
    const hit = await prefetch("/stored-loader");
    expect(hit.flight).toContain("loader-ran");
    expect(cacheControl(hit)).toBeNull();
  });

  it("carries none when the root layout above the record is sent live", async () => {
    const { serve, warm } = app();
    await warm("/stored");
    // A client that holds nothing: the root layout renders live.
    const hit = await serve("/stored", {
      partial: { from: "/", prefetch: true },
    });
    expect(hit.flight).toContain("stored");
    expect(cacheControl(hit)).toBeNull();
  });

  it("carries none when a live layout above the record is sent", async () => {
    const { prefetch, warm } = app();
    await warm("/under/b");
    // From /, the client does not hold the layout: it renders live.
    const hit = await prefetch("/under/b");
    expect(hit.flight).toContain("live-layout");
    expect(cacheControl(hit)).toBeNull();
  });

  it("carries it when the client keeps the live layout and the record sends the rest", async () => {
    const { prefetch, warm } = app();
    await warm("/under/b");
    const hit = await prefetch("/under/b", "/under/a");
    expect(hit.flight).toContain("under-b");
    expect(hit.flight).not.toContain("live-layout");
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("carries it on an intent prefetch", async () => {
    const { prefetch, warm } = app();
    await warm("/stored");
    const hit = await prefetch("/stored", "/", {
      "X-Rango-Prefetch": "intent",
    });
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("carries none on a navigation", async () => {
    const { serve, held, warm } = app();
    await warm("/stored");
    const hit = await serve("/stored", {
      partial: { from: "/", segments: await held("/") },
    });
    expect(hit.flight).toContain("stored");
    expect(cacheControl(hit)).toBeNull();
  });

  it("carries none with prefetchCacheTTL: false", async () => {
    const { prefetch, warm } = app({ prefetchCacheTTL: false });
    await warm("/stored");
    expect(cacheControl(await prefetch("/stored"))).toBeNull();
  });

  it("carries the configured TTL", async () => {
    const { prefetch, warm } = app({ prefetchCacheTTL: 60 });
    await warm("/stored");
    expect(cacheControl(await prefetch("/stored"))).toBe("private, max-age=60");
  });

  it("keeps a route's no-store", async () => {
    const { prefetch, warm } = app();
    await warm("/stored-no-store");
    const hit = await prefetch("/stored-no-store");
    expect(hit.flight).toContain("stored-no-store");
    expect(cacheControl(hit)).toBe("no-store");
  });

  it("carries none when a middleware answers with a redirect after the render", async () => {
    const { serve, held, warm, bounce } = app();
    await warm("/stored");
    const segments = await held("/");
    bounce.on = true;
    const redirected = await serve("/stored", {
      partial: { from: "/", segments, prefetch: true },
    });
    expect(redirected.response.status).toBe(200);
    expect(redirected.flight).toContain("redirect");
    expect(cacheControl(redirected)).toBeNull();
  });
});

describe("a prefetch answered from a Prerender entry", () => {
  it("carries the prefetch Cache-Control when the route has no loader", async () => {
    const { prefetch } = app();
    const hit = await prefetch("/baked");
    expect(hit.flight).toContain("baked");
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("carries none when a loader runs", async () => {
    const { prefetch } = app();
    const hit = await prefetch("/baked-loader");
    expect(hit.flight).toContain("loader-ran");
    expect(cacheControl(hit)).toBeNull();
  });

  it("keeps NOT_REUSED when the answer is scoped to its source page", async () => {
    const { prefetch } = app();
    // Equal params, another search: the entry keeps the route's segment for
    // this source only.
    const scoped = await prefetch("/baked?sort=x", "/baked");
    expect(scoped.response.headers.get("x-rsc-prefetch-scope")).not.toBeNull();
    expect(cacheControl(scoped)).toBe("private, no-cache");
  });
});

describe("a prefetch answered from an on-demand Prerender overlay entry", () => {
  const Hot = Prerender<{ slug: string }>(
    async () => [],
    async (ctx) => <h1>{`hot:${ctx.params.slug}`}</h1>,
    { onDemand: true },
  );

  function overlayApp(ttl: number) {
    const router = createRouter({
      prerender: { store: createMemoryPrerenderStore(), ttl },
    }).routes(
      urls(({ path }) => [
        path("/", () => <p>home</p>, { name: "home" }),
        path("/hot/:slug", Hot, { name: "hot" }),
      ]),
    );
    const prefetch = async (url: string) => {
      const home = await serveShellRequest(router, "/", {
        partial: { from: "/elsewhere" },
      });
      return serveShellRequest(router, url, {
        partial: {
          from: "/",
          segments: await matchedOf(home),
          prefetch: true,
        },
      });
    };
    return { router, prefetch };
  }

  it("carries the prefetch Cache-Control when the entry is fresh", async () => {
    const { router, prefetch } = overlayApp(3600);
    await router.prerender({ env: {} })("/hot/a");
    const hit = await prefetch("/hot/a");
    expect(hit.flight).toContain("hot:a");
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("carries none when the entry is stale: it serves while a refresh is due", async () => {
    // ttl 0: stale as soon as written, so the entry still serves but is not
    // what the page will hold once its refresh lands.
    const { router, prefetch } = overlayApp(0);
    await router.prerender({ env: {} })("/hot/a");
    const hit = await prefetch("/hot/a");
    expect(hit.flight).toContain("hot:a");
    expect(cacheControl(hit)).toBeNull();
  });
});

describe("a stored prefetch whose route sets a zero max-age", () => {
  it("keeps max-age=0", async () => {
    const { prefetch, warm } = app();
    await warm("/stored-max-age-zero");
    const hit = await prefetch("/stored-max-age-zero");
    expect(hit.flight).toContain("stored-max-age-zero");
    expect(cacheControl(hit)).toBe("max-age=0");
  });

  it("keeps max-age=0 with must-revalidate", async () => {
    const { prefetch, warm } = app();
    await warm("/stored-must-revalidate");
    const hit = await prefetch("/stored-must-revalidate");
    expect(hit.flight).toContain("stored-must-revalidate");
    expect(cacheControl(hit)).toBe("private, max-age=0, must-revalidate");
  });

  it("still replaces a route's positive max-age", async () => {
    const { prefetch, warm } = app();
    await warm("/stored-max-age-short");
    const hit = await prefetch("/stored-max-age-short");
    expect(hit.flight).toContain("stored-max-age-short");
    expect(cacheControl(hit)).toBe(STORED);
  });
});

describe("a live prefetch", () => {
  it("carries none", async () => {
    const { prefetch } = app();
    expect(cacheControl(await prefetch("/live"))).toBeNull();
  });

  it("carries none when its render fails after the 200", async () => {
    const { prefetch } = app();
    const failed = await prefetch("/failing");
    expect(failed.response.status).toBe(200);
    expect(failed.flight).toContain("declared-error");
    expect(cacheControl(failed)).toBeNull();
  });
});

describe("a prefetch answered by the document cache", () => {
  const earlyOptIn: Middleware = async (ctx, next) => {
    ctx.header("Cache-Control", "s-maxage=60");
    await next();
  };

  function docApp() {
    const cacheStore = new MemorySegmentCacheStore();
    const router = createRouter({})
      .use(createDocumentCacheMiddleware())
      .use(earlyOptIn)
      .routes(
        urls(({ path, loader }) => [
          path("/", () => <p>home</p>, { name: "home" }),
          path(
            "/doc",
            () => <p>doc</p>,
            { name: "doc" },
            () => [loader(Stamp)],
          ),
        ]),
      );
    const serve = (url: string, partial: ServeShellRequestOptions["partial"]) =>
      serveShellRequest(router, url, { cacheStore, partial });
    return { serve };
  }

  it("carries the prefetch Cache-Control on a HIT, the route's own on the MISS", async () => {
    const { serve } = docApp();
    const miss = await serve("/doc", { from: "/", prefetch: true });
    expect(miss.response.headers.get("x-document-cache-status")).toBe("MISS");
    expect(cacheControl(miss)).toBe("s-maxage=60");
    await settle();

    const hit = await serve("/doc", { from: "/", prefetch: true });
    expect(hit.response.headers.get("x-document-cache-status")).toBe("HIT");
    expect(hit.flight).toContain("loader-ran");
    expect(cacheControl(hit)).toBe(STORED);
  });

  it("keeps the stored Cache-Control on a navigation HIT", async () => {
    const { serve } = docApp();
    await serve("/doc", { from: "/" });
    await settle();
    const hit = await serve("/doc", { from: "/" });
    expect(hit.response.headers.get("x-document-cache-status")).toBe("HIT");
    expect(cacheControl(hit)).toBe("s-maxage=60");
  });
});
