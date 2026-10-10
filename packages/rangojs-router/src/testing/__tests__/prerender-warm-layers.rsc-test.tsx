/**
 * router.prerender() warming, layer by layer, through the public testing
 * primitives (docs/design/prerender-every-route.md): what prerender-warm
 * .rsc-test.tsx does for the shell and the route record, here for the other
 * runtime caches a request fills (a loader's own cache(), "use cache", the
 * document cache, a response route's cache), and for the parts of the
 * contract a visitor can observe: the key a warm writes under (search params
 * and the cache.searchParams filter), `onlyIfStale`, the origin, a call made
 * from inside a request, and each refusal.
 *
 * Every case is "a visitor's request filled the cache, the data moved, the
 * warm ran, the next visitor's request is served the newer value without
 * rendering": the read missed although the entry was fresh, and the write
 * replaced it under the visitor's key.
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
import {
  cookies,
  createLoader,
  createRouter,
  redirect,
  updateTag,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import {
  CFCacheStore,
  MemorySegmentCacheStore,
  createDocumentCacheMiddleware,
  type SegmentCacheStore,
} from "../../cache/index.js";
import type { PrerenderResult } from "../../prerender/index.js";
import { getStock, runs as useCacheRuns } from "./fixtures/use-cache-data.js";

/** The origin serveShellRequest resolves paths against. */
const ORIGIN = "http://localhost";

class SharedMemoryStore extends MemorySegmentCacheStore {
  readonly scope = "global" as const;
}

/** What the fixtures render: a test moves it to tell a stored value from a newer one. */
let source = "v1";
const runs = {
  loader: 0,
  cached: 0,
  doc: 0,
  api: 0,
  plain: 0,
  trigger: 0,
  nested: 0,
  tagged: 0,
  taggedRecord: 0,
};

const StampLoader = createLoader(async () => {
  runs.loader += 1;
  return { stamp: `loader-${source}-run${runs.loader}` };
});

function LoaderPage(): React.ReactNode {
  return <p>loader-page</p>;
}

function CachedPage(ctx: HandlerContext): React.ReactNode {
  runs.cached += 1;
  return (
    <p>{`cached-${source}-run${runs.cached}-q=${ctx.searchParams.get("q") ?? ""}`}</p>
  );
}

async function UseCachePage(): Promise<React.ReactNode> {
  return <p>{`stock:${await getStock("sku-1")}`}</p>;
}

function DocPage(ctx: HandlerContext): React.ReactNode {
  runs.doc += 1;
  ctx.headers.set("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  return <p>{`doc-${source}-run${runs.doc}`}</p>;
}

function PrivateDocPage(ctx: HandlerContext): React.ReactNode {
  ctx.headers.set("Cache-Control", "private, s-maxage=60");
  return <p>private-doc</p>;
}

function PlainPage(): React.ReactNode {
  runs.plain += 1;
  return <p>{`plain-run${runs.plain}`}</p>;
}

function ShelledPage(): React.ReactNode {
  return <h1>{`shelled-${source}`}</h1>;
}

function DynamicShellPage(ctx: HandlerContext): React.ReactNode {
  ctx.dynamic();
  return <h1>dynamic</h1>;
}

/** Reads the visitor's cookie inside a cache() boundary: the guard throws. */
function CachedCookiePage(): React.ReactNode {
  return <p>{`session-${cookies().get("session")?.value ?? "none"}`}</p>;
}

/** A page no visitor requests before the nested warm below targets it. */
function NestedTargetPage(): React.ReactNode {
  runs.nested += 1;
  return <p>{`nested-run${runs.nested}`}</p>;
}

function TaggedPage(): React.ReactNode {
  runs.tagged += 1;
  return <h1>{`tagged-${source}-run${runs.tagged}`}</h1>;
}

/** The same tag with no shell: the route's cache() record is all it stores. */
function TaggedRecordPage(): React.ReactNode {
  runs.taggedRecord += 1;
  return <h1>{`record-${source}-run${runs.taggedRecord}`}</h1>;
}

let triggerResult: PrerenderResult | undefined;

/** A store per request from the bindings, as an app on Workers builds it. */
type StoreFactory = (env: any, ctx?: any) => { store: SegmentCacheStore };

function makeRouter(
  store: MemorySegmentCacheStore | StoreFactory = new SharedMemoryStore(),
  searchParams?: { exclude: string[] },
) {
  const router = createRouter({
    cache:
      typeof store === "function"
        ? store
        : { store, ...(searchParams ? { searchParams } : {}) },
    cacheProfiles: { default: { ttl: 300 } },
  })
    .use("/doc/*", createDocumentCacheMiddleware())
    .use("/guarded/*", async () => {
      throw redirect("/login");
    })
    .routes(
      urls(({ path, loader, cache }) => [
        path("/with-loader", LoaderPage, { name: "withLoader" }, () => [
          loader(StampLoader, () => [cache({ ttl: 300 })]),
        ]),
        cache({ ttl: 300 }, () => [
          path("/cached", CachedPage, { name: "cached" }),
          path("/cached-cookie", CachedCookiePage, { name: "cachedCookie" }),
          path("/nested-target", NestedTargetPage, { name: "nestedTarget" }),
          path.json(
            "/api/data",
            () => {
              runs.api += 1;
              return { value: `api-${source}-run${runs.api}` };
            },
            { name: "apiData" },
          ),
        ]),
        path("/use-cache", UseCachePage, { name: "useCache" }),
        path("/doc/page", DocPage, { name: "docPage" }),
        path("/doc/private", PrivateDocPage, { name: "docPrivate" }),
        path("/plain", PlainPage, { name: "plain" }),
        path("/guarded/page", PlainPage, { name: "guarded" }),
        path("/shelled", ShelledPage, { name: "shelled", ppr: true }),
        path("/dynamic-shell", DynamicShellPage, {
          name: "dynamicShell",
          ppr: true,
        }),
        cache({ ttl: 300, tags: ["catalog"] }, () => [
          path("/tagged", TaggedPage, { name: "tagged", ppr: true }),
          path("/tagged-record", TaggedRecordPage, { name: "taggedRecord" }),
        ]),
        // The content-refresh pattern: invalidate the tag, then warm the URL.
        path(
          "/refresh",
          async (ctx: HandlerContext) => {
            await updateTag("catalog");
            triggerResult = await router.prerender({ env: ctx.env })(
              ctx.searchParams.get("target") ?? "/tagged",
            );
            return <p>{`refreshed-${triggerResult.status}`}</p>;
          },
          { name: "refresh" },
        ),
        // A route handler that warms another route: a path target and a
        // binding with no origin, so the warm takes this request's.
        path(
          "/trigger",
          async (ctx: HandlerContext) => {
            runs.trigger += 1;
            triggerResult = await router.prerender({ env: ctx.env })(
              ctx.searchParams.get("target") ?? "/nested-target",
            );
            return <p>{`triggered-${triggerResult.status}`}</p>;
          },
          { name: "trigger" },
        ),
      ]),
    );
  return router;
}

beforeEach(async () => {
  await resetShellTestState();
  source = "v1";
  for (const key of Object.keys(runs) as (keyof typeof runs)[]) runs[key] = 0;
  for (const key of Object.keys(useCacheRuns)) delete useCacheRuns[key];
  triggerResult = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a warm replaces each runtime cache a request fills", () => {
  it("a loader's own cache(): the loader runs again and its entry is replaced", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/with-loader");
    expect((await serveShellRequest(router, "/with-loader")).flight).toContain(
      "loader-v1-run1",
    );
    expect(runs.loader).toBe(1);

    source = "v2";
    const result = await router.prerender({ env: {} })(`${ORIGIN}/with-loader`);

    expect(result).toMatchObject({
      ok: true,
      path: "warm",
      status: "warmed",
      caches: { writes: { record: 0, item: 1, response: 0, shell: 0 } },
    });
    expect(runs.loader).toBe(2);
    expect((await serveShellRequest(router, "/with-loader")).flight).toContain(
      "loader-v2-run2",
    );
    // The visitor's request read the warm's entry: the loader did not run.
    expect(runs.loader).toBe(2);
  });

  it('"use cache": the function runs again and its item is replaced', async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/use-cache");
    expect((await serveShellRequest(router, "/use-cache")).flight).toContain(
      "stock:sku-1 #1",
    );
    expect(useCacheRuns.getStock).toBe(1);

    const result = await router.prerender({ env: {} })(`${ORIGIN}/use-cache`);

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      caches: { writes: { item: 1 } },
    });
    expect(useCacheRuns.getStock).toBe(2);
    expect((await serveShellRequest(router, "/use-cache")).flight).toContain(
      "stock:sku-1 #2",
    );
    expect(useCacheRuns.getStock).toBe(2);
  });

  it("the document cache: the stored response is replaced and reported", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/doc/page");
    expect((await serveShellRequest(router, "/doc/page")).body).toContain(
      "doc-v1-run1",
    );
    expect(runs.doc).toBe(1);

    source = "v2";
    const result = await router.prerender({ env: {} })(`${ORIGIN}/doc/page`);

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      caches: {
        writes: { record: 0, item: 0, response: 1, shell: 0 },
        document: "stored",
      },
    });
    const served = await serveShellRequest(router, "/doc/page");
    expect(served.body).toContain("doc-v2-run2");
    // A document-cache HIT: the page did not render for the visitor.
    expect(runs.doc).toBe(2);
  });

  it("the document cache keeps its refusals: a private response is not stored", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(`${ORIGIN}/doc/private`);

    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "skipped-uncached",
      responseStatus: 200,
      caches: {
        writes: { record: 0, item: 0, response: 0, shell: 0 },
        document: "not-cacheable",
      },
    });
  });

  it("a response route's cache: the handler runs again and its entry is replaced", async () => {
    const router = makeRouter();
    const first = await serveShellRequest(router, "/api/data");
    expect(first.body).toContain("api-v1-run1");
    expect((await serveShellRequest(router, "/api/data")).body).toContain(
      "api-v1-run1",
    );

    source = "v2";
    const result = await router.prerender({ env: {} })(`${ORIGIN}/api/data`);

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      caches: { writes: { response: 1 } },
    });
    expect(runs.api).toBe(2);
    expect((await serveShellRequest(router, "/api/data")).body).toContain(
      "api-v2-run2",
    );
    expect(runs.api).toBe(2);
  });
});

describe("a warm writes under the key a visitor's request reads", () => {
  it("search params are part of the key: each one is its own entry", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(
      `${ORIGIN}/cached?q=wine`,
    );

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      target: `${ORIGIN}/cached?q=wine`,
    });
    expect(runs.cached).toBe(1);
    // The visitor of that URL is a record HIT; another search is not.
    const hit = await serveShellRequest(router, "/cached?q=wine");
    expect(hit.flight).toContain("cached-v1-run1-q=wine");
    expect(runs.cached).toBe(1);
    await serveShellRequest(router, "/cached?q=beer");
    expect(runs.cached).toBe(2);
  });

  it("cache.searchParams filters the warm's key as it filters a visitor's", async () => {
    const router = makeRouter(new SharedMemoryStore(), { exclude: ["utm_*"] });

    await router.prerender({ env: {} })(`${ORIGIN}/cached?utm_source=mail`);

    expect(runs.cached).toBe(1);
    // The excluded param never keyed the record: the bare URL reads it.
    await serveShellRequest(router, "/cached");
    await serveShellRequest(router, "/cached?utm_source=ad");
    expect(runs.cached).toBe(1);
  });

  it("the host is part of the key: a warm on another origin is not this visitor's entry", async () => {
    const router = makeRouter();

    const result = await router.prerender({
      env: {},
      origin: "https://other.example",
    })("/cached");

    expect(result).toMatchObject({
      ok: true,
      status: "warmed",
      target: "https://other.example/cached",
    });
    expect(runs.cached).toBe(1);
    await serveShellRequest(router, "/cached");
    expect(runs.cached).toBe(2);
  });
});

describe("the origin of a warm", () => {
  it("a path target with no origin, called outside a request, is skipped-no-origin", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })("/cached");

    expect(result).toEqual({
      ok: false,
      path: "warm",
      status: "skipped-no-origin",
      target: "/cached",
      routeName: "cached",
    });
    expect(runs.cached).toBe(0);
  });

  it("the binding's origin serves a path target and a { route } target", async () => {
    const router = makeRouter();
    const prerender = router.prerender({ env: {}, origin: ORIGIN });

    expect(await prerender("/cached")).toMatchObject({
      status: "warmed",
      target: `${ORIGIN}/cached`,
    });
    expect(await prerender({ route: "plain" } as never)).toMatchObject({
      path: "warm",
      target: `${ORIGIN}/plain`,
    });
    // The warmed record is the visitor's.
    await serveShellRequest(router, "/cached");
    expect(runs.cached).toBe(1);
  });

  it("called from a route handler with no origin, the warm uses that request's origin", async () => {
    const router = makeRouter();

    const page = await serveShellRequest(router, "/trigger");

    expect(page.flight).toContain("triggered-warmed");
    expect(triggerResult).toMatchObject({
      ok: true,
      path: "warm",
      status: "warmed",
      target: `${ORIGIN}/nested-target`,
      routeName: "nestedTarget",
    });
    expect(runs.nested).toBe(1);
    // Keys carry the host: the visitor on the trigger's origin reads the record.
    const served = await serveShellRequest(router, "/nested-target");
    expect(served.flight).toContain("nested-run1");
    expect(runs.nested).toBe(1);
  });

  it("a warm called from a handler does not render inside that handler's scopes", async () => {
    // The trigger's handler runs inside its request's AsyncLocalStorage
    // scopes (the route-definition store among them). A request dispatched
    // from there built the target's manifest into the calling route's store
    // and answered 404 for a route no visitor had requested yet; the cookie
    // read below would also have tripped the calling route's cache() scope.
    const router = makeRouter();

    await serveShellRequest(router, "/trigger?target=/nested-target");
    expect(triggerResult).toMatchObject({ status: "warmed" });

    await serveShellRequest(router, "/trigger?target=/plain");
    expect(triggerResult).toMatchObject({
      ok: false,
      path: "warm",
      status: "skipped-uncached",
      responseStatus: 200,
    });
    expect(runs.plain).toBe(1);
  });
});

describe("updateTag(tag), then prerender(url): the content-refresh pattern", () => {
  it("the invalidation drops the stored entries and the warm's own writes are not refused by it", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/tagged");
    const before = await serveShellRequest(router, "/tagged");
    expect(before.shellStatus).toBe("HIT");
    expect(before.prelude).toContain("tagged-v1-run1");

    source = "v2";
    await serveShellRequest(router, "/refresh");

    // The warm started after the invalidation, so the write gate
    // (predatesInvalidation, putShell's generation gate) lets it through.
    expect(triggerResult).toMatchObject({
      ok: true,
      path: "warm",
      status: "warmed",
      caches: {
        writes: { record: 1, item: 0, response: 0, shell: 1 },
        shell: "stored",
      },
    });
    const after = await serveShellRequest(router, "/tagged");
    expect(after.shellStatus).toBe("HIT");
    expect(after.prelude).toContain("tagged-v2-run2");
    // Served from what the warm stored: the handler did not run again.
    expect(runs.tagged).toBe(2);
  });

  it("without the warm, the invalidation alone leaves the next visitor a MISS", async () => {
    const store = new SharedMemoryStore();
    const router = makeRouter(store);
    await serveShellRequest(router, "/tagged");
    expect((await serveShellRequest(router, "/tagged")).shellStatus).toBe(
      "HIT",
    );

    await store.invalidateTags(["catalog"]);

    // The cold window the warm closes: this visitor pays the render.
    expect((await serveShellRequest(router, "/tagged")).shellStatus).toBe(
      "MISS",
    );
    expect(runs.tagged).toBe(2);
  });

  it.each(
    [true, false].flatMap((kvFallThrough) => [
      {
        kvFallThrough,
        what: "a ppr route's shell",
        path: "/tagged",
        page: "tagged",
        run: "tagged" as const,
      },
      {
        kvFallThrough,
        what: "a cache() route's record",
        path: "/tagged-record",
        page: "record",
        run: "taggedRecord" as const,
      },
    ]),
  )(
    "CFCacheStore with KV, kvFallThrough $kvFallThrough, $what: a location that held the old copy renders only when the option is off",
    async ({ kvFallThrough, path, page, run }) => {
      // invalidateTags warns once per isolate that the markers have no expiry.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      // Two edge locations: a Cache API each, one KV. `caches` resolves to the
      // location serving the request. One process is one isolate, so the
      // isolate memos, which would answer for both locations, are off.
      const visitors = edgeCache();
      const webhook = edgeCache();
      let serving = visitors;
      vi.stubGlobal("caches", {
        get default() {
          return serving;
        },
        open: async () => serving,
      });
      const env = { KV: kvNamespace() };
      const router = makeRouter((bindings: typeof env, ctx) => ({
        store: new CFCacheStore({
          ctx: ctx!,
          kv: bindings.KV,
          kvFallThrough,
          memo: { shellMs: 0, markerFreshMs: 0 },
        }),
      }));
      /** The page a request served: a shell HIT's prelude, else its render. */
      const serveAt = async (edge: typeof visitors, url: string) => {
        serving = edge;
        const served = await serveShellRequest(router, url, { env });
        return (served.prelude ?? served.flight)?.match(
          new RegExp(`${page}-v\\d-run\\d`),
        )?.[0];
      };

      // The visitors' location renders the page and keeps its own copies.
      await serveAt(visitors, path);
      expect(await serveAt(visitors, path)).toBe(`${page}-v1-run1`);
      expect(runs[run]).toBe(1);
      expect(visitors.size()).toBeGreaterThan(0);

      // The content changes; a webhook lands in another location.
      source = "v2";
      await serveAt(webhook, `/refresh?target=${path}`);
      expect(triggerResult).toMatchObject({
        ok: true,
        status: "warmed",
        caches: { writes: { record: 1 } },
      });
      expect(runs[run]).toBe(2);

      // Its own copies predate the tag marker; the warm's entries are in KV.
      // Served from KV only with the option on; off, the location renders.
      expect(await serveAt(visitors, path)).toBe(
        kvFallThrough ? `${page}-v2-run2` : `${page}-v2-run3`,
      );
      expect(runs[run]).toBe(kvFallThrough ? 2 : 3);
    },
  );
});

/** One edge location's Cache API. */
function edgeCache() {
  const entries = new Map<string, Response>();
  return {
    async match(request: Request) {
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
    size: () => entries.size,
  };
}

/** The KV namespace every location is bound to (string values). */
function kvNamespace() {
  const values = new Map<string, string>();
  return {
    async get(key: string, options?: { type?: string }) {
      const value = values.get(key);
      if (value === undefined) return null;
      return options?.type === "json" ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
  };
}

describe("onlyIfStale on a warm", () => {
  it("leaves a fresh entry alone and reports already-fresh", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/cached");
    await serveShellRequest(router, "/cached");
    expect(runs.cached).toBe(1);

    const result = await router.prerender({ env: {} })(`${ORIGIN}/cached`, {
      onlyIfStale: true,
    });

    expect(result).toMatchObject({
      ok: true,
      path: "warm",
      status: "already-fresh",
      caches: { writes: { record: 0, item: 0, response: 0, shell: 0 } },
    });
    // The request read the record: the handler did not run.
    expect(runs.cached).toBe(1);
  });

  it("writes a cold entry and reports warmed", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(`${ORIGIN}/cached`, {
      onlyIfStale: true,
    });

    expect(result).toMatchObject({ ok: true, status: "warmed" });
    await serveShellRequest(router, "/cached");
    expect(runs.cached).toBe(1);
  });

  it("finds a stored shell fresh, where a plain warm would replace it", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/shelled");
    expect((await serveShellRequest(router, "/shelled")).shellStatus).toBe(
      "HIT",
    );
    source = "v2";

    const fill = await router.prerender({ env: {} })(`${ORIGIN}/shelled`, {
      onlyIfStale: true,
    });
    expect(fill).toMatchObject({
      status: "already-fresh",
      caches: { shell: "fresh" },
    });
    expect((await serveShellRequest(router, "/shelled")).prelude).toContain(
      "shelled-v1",
    );

    const replace = await router.prerender({ env: {} })(`${ORIGIN}/shelled`);
    expect(replace).toMatchObject({
      status: "warmed",
      caches: { shell: "stored" },
    });
    expect((await serveShellRequest(router, "/shelled")).prelude).toContain(
      "shelled-v2",
    );
  });
});

describe("what a warm refuses or reports", () => {
  it("a route with no cache writes nothing: skipped-uncached", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(`${ORIGIN}/plain`);

    expect(result).toEqual({
      ok: false,
      path: "warm",
      status: "skipped-uncached",
      target: `${ORIGIN}/plain`,
      routeName: "plain",
      responseStatus: 200,
      caches: { writes: { record: 0, item: 0, response: 0, shell: 0 } },
    });
    expect(runs.plain).toBe(1);
  });

  it("middleware that redirects an anonymous request: render-failed with the status", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(
      `${ORIGIN}/guarded/page`,
    );

    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "render-failed",
      routeName: "guarded",
    });
    expect(
      (result as { responseStatus?: number }).responseStatus,
    ).toBeGreaterThanOrEqual(300);
    expect((result as { responseStatus?: number }).responseStatus).toBeLessThan(
      400,
    );
    expect(runs.plain).toBe(0);
  });

  it("a cookie read inside a cache() boundary: skipped-personalized, and no record", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new SharedMemoryStore();
    const set = vi.spyOn(store, "set");
    const router = makeRouter(store);

    const result = await router.prerender({ env: {} })(
      `${ORIGIN}/cached-cookie`,
    );

    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "skipped-personalized",
      routeName: "cachedCookie",
    });
    expect(set).not.toHaveBeenCalled();
  });

  it("a ppr route that calls ctx.dynamic() has no shell: shell-not-stored", async () => {
    const router = makeRouter();

    const result = await router.prerender({ env: {} })(
      `${ORIGIN}/dynamic-shell`,
    );

    expect(result).toMatchObject({
      ok: false,
      path: "warm",
      status: "shell-not-stored",
      caches: { shell: "not-eligible" },
    });
    expect(
      (await serveShellRequest(router, "/dynamic-shell")).shellStatus,
    ).not.toBe("HIT");
  });

  it("a request cannot mark itself a warm: a visitor's request with the same URL reads the cache", async () => {
    const router = makeRouter();
    await serveShellRequest(router, "/cached");
    expect(runs.cached).toBe(1);

    // Whatever a client sends, the read is a normal read: the mark is the
    // Request object the runner created.
    await serveShellRequest(router, "/cached", {
      headers: { "x-rango-prerender-warm": "replace", accept: "text/html" },
    });
    expect(runs.cached).toBe(1);
  });
});
