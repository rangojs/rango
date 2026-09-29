/**
 * serveShellRequest through the public Flight entry: one request at a time
 * through the router's production request handler, so a MISS runs the real
 * capture and a later request with the same store is a real HIT (or a real
 * partial replay). Only the HTML step is stubbed: a HIT's `prelude` is the
 * capture's Flight text and `flight` is the tail's.
 *
 * `source.generation` moves on after a capture: a value the shell captured
 * reads @g1, a value read live after that reads @g2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { Suspense } from "react";

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
} from "../flight.entry.js";
import { runInRequestContext } from "../index.js";
import {
  createLoader,
  createRouter,
  Meta,
  updateTag,
  urls,
  type HandlerContext,
  type RangoOptions,
} from "../../index.rsc.js";
import {
  CFCacheStore,
  MemorySegmentCacheStore,
  VercelCacheStore,
  type SegmentCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import { getProduct, getStamp, source } from "./fixtures/shell-request-data.js";

const StockLoader = createLoader(async () => ({
  stock: `stock@g${source.generation}`,
}));

const StampLoader = createLoader(async () => ({ stamp: await getStamp() }));

function ChromeLayout(): React.ReactNode {
  return <header>{`chrome@g${source.generation}`}</header>;
}

async function ProductPage(
  ctx: HandlerContext<{ id: string }>,
): Promise<React.ReactNode> {
  return <h1>{await getProduct(ctx.params.id)}</h1>;
}

function ArticlePage(ctx: HandlerContext<{ id: string }>): React.ReactNode {
  ctx.use(Meta)({ title: `article-${ctx.params.id}@g${source.generation}` });
  return <article>article</article>;
}

async function StampLayout(): Promise<React.ReactNode> {
  return <header>{await getStamp()}</header>;
}

let shellThrows = false;

async function Flaky(): Promise<React.ReactNode> {
  if (shellThrows) throw new Error("shell render failed");
  return <span>flaky</span>;
}

/**
 * A layout (shell) over a ppr product page with a live loader under
 * loading(), a ppr page pushing a handle, and a plain page; a layout reading
 * the same "use cache" key as a loader under loading(); a ppr page whose shell
 * can throw.
 */
function makeRouter(options: RangoOptions = {}) {
  return createRouter(options).routes(
    urls(({ path, layout, loader, loading }) => [
      layout(ChromeLayout, () => [
        path(
          "/product/:id",
          ProductPage,
          { name: "product", ppr: { ttl: 300, tags: ["catalog"] } },
          () => [loader(StockLoader), loading(<p>checking stock</p>)],
        ),
        path("/article/:id", ArticlePage, { name: "article", ppr: true }),
        path("/about", () => <p>about</p>, { name: "about" }),
      ]),
      layout(StampLayout, () => [
        path(
          "/stamp",
          () => <p>stamp</p>,
          { name: "stamp", ppr: true },
          () => [loader(StampLoader), loading(<p>stamping</p>)],
        ),
      ]),
      path(
        "/flaky",
        () => (
          <main>
            <Suspense fallback={<p>pending</p>}>
              <Flaky />
            </Suspense>
          </main>
        ),
        { name: "flaky", ppr: true },
      ),
    ]),
  );
}

beforeEach(async () => {
  source.generation = 1;
  shellThrows = false;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A router and a store, and `serve` bound to both. */
function setup(
  options: {
    router?: ReturnType<typeof makeRouter>;
    cacheStore?: SegmentCacheStore;
  } = {},
) {
  const router = options.router ?? makeRouter();
  const cacheStore = options.cacheStore ?? new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  return { router, cacheStore, serve };
}

describe("serveShellRequest: document MISS, capture, HIT", () => {
  it("a MISS renders axis 1 and stores the capture; the next request is a HIT from it", async () => {
    const { serve } = setup();

    const miss = await serve("/product/1");
    expect(miss.response.status).toBe(200);
    expect(miss.shellStatus).toBe("MISS");
    expect(miss.prelude).toBeUndefined();
    expect(miss.flight).toContain("chrome@g1");
    expect(miss.flight).toContain("stock@g1");
    expect(miss.key).toBe("localhost/product/1:shell");
    const entry = await miss.readEntry();
    expect(entry).toMatchObject({
      reactVersion: React.version,
      docKey: expect.any(String),
    });

    const hit = await serve("/product/1");
    expect(hit.shellStatus).toBe("HIT");
    // The HIT served the stored prelude, then the tail.
    expect(hit.prelude).toBe(
      Buffer.from(entry!.prelude!, "base64").toString("utf8"),
    );
  });

  it("the shell stays as captured while a loader under loading() reads fresh", async () => {
    const { serve } = setup();
    await serve("/product/2");
    source.generation = 2;

    const hit = await serve("/product/2");

    expect(hit.shellStatus).toBe("HIT");
    // The prelude froze the shell; the loader under loading() is a hole.
    expect(hit.prelude).toContain("chrome@g1");
    expect(hit.prelude).toContain("product-2@g1");
    expect(hit.prelude).not.toContain("stock@");
    // The tail matches the prelude and fills the hole live.
    expect(hit.flight).toContain("chrome@g1");
    expect(hit.flight).toContain("product-2@g1");
    expect(hit.flight).not.toContain("chrome@g2");
    expect(hit.flight).not.toContain("product-2@g2");
    expect(hit.flight).toContain("stock@g2");
  });

  it('a "use cache" key read in the shell and in a hole: the shell keeps the captured value, the hole reads the store', async () => {
    const { serve, cacheStore } = setup();
    await serve("/stamp");
    // The item changes: the store no longer holds the captured value.
    source.generation = 2;
    vi.spyOn(cacheStore, "getItem").mockResolvedValue(null);

    const hit = await serve("/stamp");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain("stamp@g1");
    expect(hit.prelude).not.toContain("stamp@g2");
    expect(hit.flight).toContain("stamp@g1");
    expect(hit.flight).toMatch(/"stamp":"stamp@g2"/);
  });

  it("a handle the handler pushed rides the shell and the HIT tail", async () => {
    const { serve } = setup();
    await serve("/article/1");
    source.generation = 2;

    const hit = await serve("/article/1");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.prelude).toContain('"title":"article-1@g1"');
    expect(hit.flight).toContain('"title":"article-1@g1"');
    expect(hit.flight).not.toContain("article-1@g2");
  });

  it("a route without ppr has no shell status", async () => {
    const res = await setup().serve("/about");
    expect(res.shellStatus).toBeNull();
    expect(res.flight).toContain("about");
    expect(await res.readEntry()).toBeNull();
  });
});

describe("serveShellRequest: tags", () => {
  const memory = () => new MemorySegmentCacheStore();
  const vercel = () => new VercelCacheStore({ cache: vercelCache().cache });
  it.each([
    [
      "the route's ppr tag (shell only)",
      "31",
      "catalog",
      "product-31@g1",
      memory,
    ],
    [
      "a tag its content recorded (item and shell)",
      "32",
      "product:32",
      "product-32@g2",
      memory,
    ],
    [
      "the ppr tag on VercelCacheStore: the recapture replaces the memoized shell",
      "33",
      "catalog",
      "product-33@g1",
      vercel,
    ],
  ])(
    "updateTag of %s evicts the shell; the next request recaptures",
    async (_label, id, tag, recaptured, store) => {
      const { serve, cacheStore } = setup({ cacheStore: store() });
      const path = `/product/${id}`;
      await serve(path);
      const memoized = await serve(path);
      expect(memoized.prelude).toContain("chrome@g1");
      source.generation = 2;

      // serveShellRequest starts past the invalidation's millisecond, so the
      // recapture is not refused.
      await runInRequestContext(() => updateTag(tag), { cacheStore });
      const recapture = await serve(path);
      const hit = await serve(path);

      expect(recapture.shellStatus).toBe("MISS");
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain("chrome@g2");
      expect(hit.prelude).toContain(recaptured);
    },
  );
});

describe("serveShellRequest: partial navigation", () => {
  it("replays the captured segments and runs the loader live", async () => {
    const { serve } = setup();
    const cold = await serve("/product/4", { partial: { from: "/about" } });
    expect(cold.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });

    await serve("/product/4");
    source.generation = 2;
    const nav = await serve("/product/4", { partial: { from: "/about" } });

    expect(nav.shellStatus).toBeNull();
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(nav.flight).toContain("chrome@g1");
    expect(nav.flight).toContain("stock@g2");
  });
});

describe("serveShellRequest: the router's configuration", () => {
  it("cacheStore replaces the router's store and keeps its searchParams", async () => {
    const routerStore = new MemorySegmentCacheStore();
    const { serve } = setup({
      router: makeRouter({
        cache: { store: routerStore, searchParams: { exclude: ["utm_*"] } },
      }),
    });

    const miss = await serve("/product/5?utm_source=a");
    const hit = await serve("/product/5?utm_source=b");

    expect(miss.key).toBe("localhost/product/5:shell");
    expect(hit.shellStatus).toBe("HIT");
    expect(await routerStore.getShell(miss.key)).toBeNull();
  });

  it("serves through the router's own store when cacheStore is omitted", async () => {
    const router = makeRouter({
      cache: { store: new MemorySegmentCacheStore() },
    });

    await serveShellRequest(router, "/product/6");
    const hit = await serveShellRequest(router, "/product/6");

    expect(hit.shellStatus).toBe("HIT");
    expect(await hit.readEntry()).not.toBeNull();
  });

  it("global middleware runs before the shell is served", async () => {
    const { serve } = setup({
      router: makeRouter().use(async (ctx, next) => {
        if (!ctx.request.headers.get("cookie")?.includes("session=")) {
          return new Response("sign in", { status: 401 });
        }
        ctx.header("x-middleware", "ran");
        await next();
      }),
    });
    const headers = { cookie: "session=1" };
    await serve("/product/7", { headers });

    const hit = await serve("/product/7", { headers });
    const anonymous = await serve("/product/7");
    const anonymousNav = await serve("/product/7", { partial: true });

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.response.headers.get("x-middleware")).toBe("ran");
    for (const blocked of [anonymous, anonymousNav]) {
      expect(blocked.response.status).toBe(401);
      expect(blocked.shellStatus).toBeNull();
      expect(blocked.flight).toBeUndefined();
    }
  });

  it("a request with the router's nonce stays on axis 1", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup({ router: makeRouter({ nonce: () => true }) });

    await serve("/product/9");
    const again = await serve("/product/9");

    expect(again.shellStatus).toBeNull();
    expect(again.flight).toContain("chrome@g1");
    expect(await again.readEntry()).toBeNull();
  });
});

/** A `getCache()` double counting shell-entry reads. */
function vercelCache(): { cache: VercelRuntimeCache; reads: () => number } {
  const values = new Map<string, unknown>();
  let reads = 0;
  const cache: VercelRuntimeCache = {
    async get(key) {
      if (key.includes(":h:")) reads++;
      const value = values.get(key);
      return value === undefined ? undefined : structuredClone(value);
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async delete(key) {
      values.delete(key);
    },
    async expireTag() {},
  };
  return { cache, reads: () => reads };
}

/** Stub the Cache API with an empty edge cache counting shell reads. */
function freshEdgeCache(): { shellMatches: () => number } {
  let shellMatches = 0;
  const entries = new Map<string, Response>();
  const edge = {
    async match(request: Request) {
      if (request.url.includes("shell")) shellMatches++;
      return entries.get(request.url)?.clone();
    },
    async put(request: Request, response: Response) {
      entries.set(request.url, response.clone());
    },
    async delete(request: Request) {
      return entries.delete(request.url);
    },
  };
  vi.stubGlobal("caches", { default: edge, open: async () => edge });
  return { shellMatches: () => shellMatches };
}

/** A KV namespace double (string values). */
function kv() {
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

/** The store built per request from the router's cache config, as on Workers. */
function cfRouter(memo: { shellMs?: number } = {}) {
  return makeRouter({
    // The store's own waitUntil writes run on the request's execution
    // context, which serveShellRequest settles.
    cache: (env: { KV: any }, ctx) => ({
      store: new CFCacheStore({ ctx: ctx!, kv: env.KV, memo }),
    }),
  });
}

describe("serveShellRequest: store shell memos", () => {
  it.each([
    ["the default memo serves a repeat HIT from memory", {}, 1],
    ["{ shellMs: 0 } reads the store on every HIT", { shellMs: 0 }, 2],
  ])("VercelCacheStore: %s", async (_label, memo, hitReads) => {
    const { cache, reads } = vercelCache();
    const { serve } = setup({
      cacheStore: new VercelCacheStore({ cache, memo }),
    });
    const path = `/product/vercel-${hitReads}`;

    await serve(path);
    const afterMiss = reads();
    const first = await serve(path);
    const second = await serve(path);

    expect([first.shellStatus, second.shellStatus]).toEqual(["HIT", "HIT"]);
    expect(reads() - afterMiss).toBe(hitReads);
  });

  it.each([
    ["the default memo serves a repeat HIT from memory", {}, 1],
    ["{ shellMs: 0 } reads the edge cache on every HIT", { shellMs: 0 }, 2],
  ])("CFCacheStore: %s", async (_label, memo, hitMatches) => {
    const edge = freshEdgeCache();
    const router = cfRouter(memo);
    const env = { KV: kv() };
    const path = `/product/cf-${hitMatches}`;

    await serveShellRequest(router, path, { env });
    const afterMiss = edge.shellMatches();
    const first = await serveShellRequest(router, path, { env });
    const second = await serveShellRequest(router, path, { env });

    expect([first.shellStatus, second.shellStatus]).toEqual(["HIT", "HIT"]);
    expect(edge.shellMatches() - afterMiss).toBe(hitMatches);
  });
});

describe("resetShellTestState", () => {
  it("clears the capture backoff a refused capture left on a URL", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    shellThrows = true;
    await setup().serve("/flaky");
    shellThrows = false;

    // A new router and store: the refused URL is still backed off.
    const leaked = setup();
    await leaked.serve("/flaky");
    expect((await leaked.serve("/flaky")).shellStatus).toBe("MISS");

    await resetShellTestState();
    const { serve } = setup();
    const miss = await serve("/flaky");
    const hit = await serve("/flaky");
    expect([miss.shellStatus, hit.shellStatus]).toEqual(["MISS", "HIT"]);
  });

  it("clears the CFCacheStore isolate memo another store filled", async () => {
    freshEdgeCache();
    const warm = cfRouter();
    const warmEnv = { KV: kv() };
    await serveShellRequest(warm, "/product/cf-reset", { env: warmEnv });
    await serveShellRequest(warm, "/product/cf-reset", { env: warmEnv });

    // An empty edge cache and KV: the isolate memo still serves the shell.
    freshEdgeCache();
    const leaked = await serveShellRequest(cfRouter(), "/product/cf-reset", {
      env: { KV: kv() },
    });
    expect(leaked.shellStatus).toBe("HIT");

    await resetShellTestState();
    freshEdgeCache();
    const fresh = await serveShellRequest(cfRouter(), "/product/cf-reset", {
      env: { KV: kv() },
    });
    expect(fresh.shellStatus).toBe("MISS");
  });
});
