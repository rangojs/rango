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
import { runInRequestContext, shellCacheKey } from "../index.js";
import {
  cookies,
  createHandle,
  createLoader,
  createRouter,
  getRequestContext,
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
  type CachedEntryData,
  type SegmentCacheStore,
  type VercelRuntimeCache,
} from "../../cache/index.js";
import { SHELL_MIN_RECAPTURE_INTERVAL_MS } from "../../cache/cache-policy.js";
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

/** Runs of each handler and of the live loader on /counted, across tests. */
const runs = { layout: 0, page: 0, loader: 0 };

const CountedLoader = createLoader(async () => {
  runs.loader += 1;
  return { count: `loader-run-${runs.loader}` };
});

function CountedLayout(): React.ReactNode {
  runs.layout += 1;
  return <header>{`layout-run-${runs.layout}`}</header>;
}

/** A handle whose pushes carry a promise, not only plain values. */
const Notes = createHandle<{ note: Promise<string> }>();

function CountedPage(ctx: HandlerContext): React.ReactNode {
  runs.page += 1;
  const run = runs.page;
  ctx.use(Meta)({ title: `page-run-${run}` });
  ctx.use(Notes)({ note: Promise.resolve(`note-run-${run}`) });
  return <p>{`page-run-${run}`}</p>;
}

function tierOf(ctx: { request: Request }): string {
  return ctx.request.headers.get("x-tier") ?? "none";
}

function TierPage(ctx: HandlerContext): React.ReactNode {
  return <p>{`tier-${tierOf(ctx)}-page`}</p>;
}

/** Runs of the tiered routes' key() functions, across tests. */
const keyRuns = { header: 0, cookie: 0 };

/** Body runs of the /bake-lane loaders, across tests. */
const bakeRuns = { plain: 0, holey: 0, dep: 0 };

/** A handle the bake-lane loaders push to. */
const BakeNotes = createHandle<string>();

/** Awaited by PlainBakeLoader through ctx.use; pushes a note of its own. */
const BakeDepLoader = createLoader(async (ctx) => {
  bakeRuns.dep += 1;
  ctx.use(BakeNotes)(`dep-note-${bakeRuns.dep}`);
  return { dep: bakeRuns.dep };
});

/** A promise-free bake-lane loader: served from the shell on a HIT. */
const PlainBakeLoader = createLoader(async (ctx) => {
  bakeRuns.plain += 1;
  const run = bakeRuns.plain;
  const { dep } = await ctx.use(BakeDepLoader);
  ctx.use(BakeNotes)(`plain-note-${run}`);
  return { plain: `plain-run-${run}`, dep: `dep-run-${dep}` };
});

/** A bake-lane loader returning a promise: it mints a hole on every HIT. */
const HoleyBakeLoader = createLoader(async () => {
  bakeRuns.holey += 1;
  const run = bakeRuns.holey;
  return {
    holey: `holey-run-${run}`,
    live: Promise.resolve(`live-run-${run}`),
  };
});

/** Body runs of the /bake-under-loading loaders, across tests. */
const underLoadingRuns = { baked: 0, live: 0 };

/** An ssr: false loader on an entry whose loading() masks its live sibling. */
const UnderLoadingBakeLoader = createLoader(async () => {
  underLoadingRuns.baked += 1;
  return { baked: `x-run-${underLoadingRuns.baked}` };
});

const UnderLoadingLiveLoader = createLoader(async () => {
  underLoadingRuns.live += 1;
  return { live: `live-under-loading-${underLoadingRuns.live}` };
});

/** Body runs of OwnedLoader, across tests. */
const ownedRuns = { body: 0 };

/** A handle only OwnedLoader pushes to. */
const OwnedNotes = createHandle<string>();

/**
 * A promise-carrying bake-lane loader with its own cache(): its pushes reach
 * a capture from its loader-cache replay, or from a route cache() record
 * that recorded them.
 */
const OwnedLoader = createLoader(async (ctx) => {
  ownedRuns.body += 1;
  ctx.use(OwnedNotes)(`owned-note-${ownedRuns.body}`);
  return {
    owned: `owned-run-${ownedRuns.body}`,
    live: Promise.resolve("owned-live"),
  };
});

/**
 * /raced's next render holds on `hold` (once), after signalling `entered`:
 * the request has read the store and not yet scheduled its capture.
 */
const race: { hold?: Promise<void>; entered?: () => void } = {};

async function RacedPage(): Promise<React.ReactNode> {
  const hold = race.hold;
  race.hold = undefined;
  if (hold) {
    race.entered?.();
    await hold;
  }
  return <p>raced</p>;
}

/** Runs of the /echo page handler, across tests. */
let echoRuns = 0;

/** Every URL a handler and a loader can read, as text. */
function EchoPage(ctx: HandlerContext): React.ReactNode {
  echoRuns += 1;
  const request = new URL(ctx.request.url).search;
  const original = getRequestContext().originalUrl.search;
  return (
    <p>{`url=${ctx.url.search}|request=${request}|original=${original}`}</p>
  );
}

const EchoLoader = createLoader(async (ctx) => ({
  loaderUrls: `${ctx.url.search}|${new URL(ctx.request.url).search}`,
}));

async function Flaky(): Promise<React.ReactNode> {
  if (shellThrows) throw new Error("shell render failed");
  return <span>flaky</span>;
}

/**
 * A layout (shell) over a ppr product page with a live loader under
 * loading(), a ppr page pushing a handle, and a plain page; a layout reading
 * the same "use cache" key as a loader under loading(); a ppr page whose shell
 * can throw; a layout and page counting their runs over a counting loader
 * under loading(); a ppr page whose cache() key() partitions it by tier.
 */
function makeRouter(options: RangoOptions = {}) {
  return createRouter(options).routes(
    urls(({ path, layout, loader, loading, cache }) => [
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
      layout(CountedLayout, () => [
        path("/counted", CountedPage, { name: "counted", ppr: true }, () => [
          loader(CountedLoader),
          loading(<p>counting</p>),
        ]),
      ]),
      cache(
        {
          ttl: 300,
          key: (ctx) => {
            keyRuns.header += 1;
            return `tier:${tierOf(ctx)}`;
          },
        },
        () => [path("/tiered", TierPage, { name: "tiered", ppr: true })],
      ),
      path(
        "/bake-lane",
        () => <p>bake lane</p>,
        {
          name: "bakeLane",
          ppr: true,
        },
        () => [
          loader(PlainBakeLoader, { ssr: false }),
          loader(HoleyBakeLoader, { ssr: false }),
        ],
      ),
      path("/raced", RacedPage, { name: "raced", ppr: true }),
      path(
        "/bake-under-loading",
        () => <p>bake under loading</p>,
        { name: "bakeUnderLoading", ppr: true },
        () => [
          loader(UnderLoadingBakeLoader, { ssr: false }),
          loader(UnderLoadingLiveLoader),
          loading(<p>loading</p>),
        ],
      ),
      cache({ ttl: 300 }, () => [
        path(
          "/owned-replay",
          () => <p>owned replay</p>,
          { name: "ownedReplay", ppr: { ttl: 10, swr: 300 } },
          () => [
            loader(OwnedLoader, { ssr: false }, () => [cache({ ttl: 300 })]),
          ],
        ),
      ]),
      cache({ ttl: 1 }, () => [
        path("/short-cache", () => <p>{`short@g${source.generation}`}</p>, {
          name: "shortCache",
          ppr: { ttl: 300 },
        }),
      ]),
      cache({ ttl: 0, swr: 60 }, () => [
        path("/stale-record", () => <p>{`stale@g${source.generation}`}</p>, {
          name: "staleRecord",
          ppr: true,
        }),
      ]),
      cache({ ttl: 0, swr: 0 }, () => [
        path("/dead-record", () => <p>dead record</p>, {
          name: "deadRecord",
          ppr: true,
        }),
      ]),
      cache({ ttl: 300 }, () => [
        path("/near-expiry", () => <p>near expiry</p>, {
          name: "nearExpiry",
          ppr: true,
        }),
        path(
          "/slow-near-expiry",
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return <p>slow near expiry</p>;
          },
          { name: "slowNearExpiry", ppr: { captureTimeout: 50 } },
        ),
      ]),
      cache({ ttl: 300 }, () => [
        path("/echo", EchoPage, { name: "echo", ppr: true }, () => [
          loader(EchoLoader),
          loading(<p>echoing</p>),
        ]),
      ]),
      cache(
        {
          ttl: 300,
          key: () => {
            keyRuns.cookie += 1;
            return `tier:${cookies().get("tier")?.value ?? "none"}`;
          },
        },
        () => [
          path("/cookie-tiered", () => <p>cookie-tiered</p>, {
            name: "cookieTiered",
            ppr: true,
          }),
        ],
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

describe("serveShellRequest: a HIT runs no handler", () => {
  it("HITs replay the handler output the capture baked; only the loader under loading() runs", async () => {
    const { serve } = setup();
    const miss = await serve("/counted");
    expect(miss.shellStatus).toBe("MISS");
    // The MISS rendered, then the capture ran each handler once more: its
    // run is the output the shell baked.
    const baked = { ...runs };

    const hit = await serve("/counted");
    const again = await serve("/counted");

    expect(hit.shellStatus).toBe("HIT");
    expect(again.shellStatus).toBe("HIT");
    expect({ layout: runs.layout, page: runs.page }).toEqual({
      layout: baked.layout,
      page: baked.page,
    });
    for (const result of [hit, again]) {
      // The prelude and the tail carry the capture's run of each handler,
      // its handle pushes included: the promise in a push is handler output,
      // awaited at capture and baked.
      for (const text of [result.prelude, result.flight]) {
        expect(text).toContain(`layout-run-${baked.layout}`);
        expect(text).toContain(`page-run-${baked.page}`);
        expect(text).toContain(`"title":"page-run-${baked.page}"`);
        expect(text).toContain(`note-run-${baked.page}`);
      }
    }
    // The live loader ran once per HIT.
    expect(runs.loader).toBe(baked.loader + 2);
    expect(hit.flight).toContain(`loader-run-${baked.loader + 1}`);
    expect(again.flight).toContain(`loader-run-${baked.loader + 2}`);
  });
});

describe("serveShellRequest: request-partitioned shells", () => {
  const tier = (name: string) => ({ headers: { "x-tier": name } });

  it("each cache({ key }) partition captures and HITs its own shell, under the key production resolved", async () => {
    const { serve, cacheStore } = setup();

    const goldMiss = await serve("/tiered", tier("gold"));
    expect(goldMiss.shellStatus).toBe("MISS");
    expect(goldMiss.key).toBe(
      shellCacheKey("http://localhost/tiered", undefined, "tier:gold"),
    );
    expect(goldMiss.key).toBe("localhost/tiered:shell|tier%3Agold");
    expect(await goldMiss.readEntry()).not.toBeNull();

    // Another partition never reads gold's shell: its own MISS and capture.
    const silverMiss = await serve("/tiered", tier("silver"));
    expect(silverMiss.shellStatus).toBe("MISS");
    expect(silverMiss.flight).toContain("tier-silver-page");
    expect(silverMiss.flight).not.toContain("tier-gold");
    expect(await silverMiss.readEntry()).not.toBeNull();

    for (const [own, other] of [
      ["gold", "silver"],
      ["silver", "gold"],
    ] as const) {
      const hit = await serve("/tiered", tier(own));
      expect(hit.shellStatus).toBe("HIT");
      expect(hit.prelude).toContain(`tier-${own}-page`);
      expect(hit.flight).toContain(`tier-${own}-page`);
      expect(hit.body).not.toContain(`tier-${other}`);
    }

    // No shell is stored under the unpartitioned key.
    expect(await cacheStore.getShell!("localhost/tiered:shell")).toBeNull();
  });

  it("a partition ending in :navigation never names another partition's navigation entry", async () => {
    const { serve } = setup();
    const crafted = await serve("/tiered", tier("gold:navigation"));
    expect(crafted.shellStatus).toBe("MISS");
    expect(await crafted.readEntry()).not.toBeNull();

    // Gold's client navigation reads gold's entries only.
    const nav = await serve("/tiered", {
      ...tier("gold"),
      partial: { from: "/about" },
    });
    expect(nav.flight).toContain("tier-gold-page");
    expect(nav.flight).not.toContain("tier-gold:navigation-page");
  });

  it("a key() that reads cookies() partitions the shell and reaches a HIT; key() runs once per request", async () => {
    const { serve } = setup();
    const gold = { headers: { cookie: "tier=gold" } };
    const warn = vi.spyOn(console, "warn");

    keyRuns.cookie = 0;
    const miss = await serve("/cookie-tiered", gold);
    expect(miss.shellStatus).toBe("MISS");
    // The shell key, the record lookup and write, and the capture share it.
    expect(keyRuns.cookie).toBe(1);
    expect(miss.key).toBe("localhost/cookie-tiered:shell|tier%3Agold");
    expect(await miss.readEntry()).not.toBeNull();

    const hit = await serve("/cookie-tiered", gold);
    expect(hit.shellStatus).toBe("HIT");
    expect(keyRuns.cookie).toBe(2);
    expect(warn.mock.calls.flat().join("\n")).not.toContain("refused");

    // A client navigation: its shell partition and its record lookup (the
    // route's own cache() record, which serves it) share the one call.
    const nav = await serve("/cookie-tiered", {
      ...gold,
      partial: { from: "/about" },
    });
    expect(nav.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "explicit-cache-hit",
    });
    expect(nav.flight).toContain("cookie-tiered");
    expect(keyRuns.cookie).toBe(3);
  });

  it("a store keyGenerator that returns the default key partitions nothing", async () => {
    const cacheStore = Object.assign(new MemorySegmentCacheStore(), {
      keyGenerator: (_ctx: unknown, defaultKey: string) => defaultKey,
    });
    const { serve } = setup({ cacheStore });

    const miss = await serve("/product/41");
    expect(miss.key).toBe("localhost/product/41:shell");
    expect(await miss.readEntry()).not.toBeNull();
    expect((await serve("/product/41")).shellStatus).toBe("HIT");
  });
});

describe("serveShellRequest: bake-lane loaders on a HIT", () => {
  it("a promise-free bake-lane loader and the loader it awaits do not run on a HIT; a promise-carrying one does", async () => {
    const { serve } = setup();
    expect((await serve("/bake-lane")).shellStatus).toBe("MISS");
    // The capture's runs are the ones the shell baked.
    const baked = { ...bakeRuns };

    const hit = await serve("/bake-lane");

    expect(hit.shellStatus).toBe("HIT");
    expect(bakeRuns.plain).toBe(baked.plain);
    expect(bakeRuns.dep).toBe(baked.dep);
    expect(bakeRuns.holey).toBe(baked.holey + 1);
    // Served from the shell: the capture's values and pushes, the awaited
    // loader's push included, each once.
    expect(hit.flight).toContain(`plain-run-${baked.plain}`);
    expect(hit.flight).toContain(`dep-run-${baked.dep}`);
    for (const note of [`plain-note-${baked.plain}`, `dep-note-${baked.dep}`]) {
      expect(hit.flight?.split(note).length).toBe(2);
    }
    // The promise-carrying loader ran and filled its hole.
    expect(hit.flight).toContain(`live-run-${baked.holey + 1}`);
  });

  it("a client navigation that replays the shell does not run the promise-free bake-lane loader either", async () => {
    const { serve } = setup();
    await serve("/bake-lane");
    const baked = { ...bakeRuns };

    const nav = await serve("/bake-lane", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(bakeRuns.plain).toBe(baked.plain);
    expect(bakeRuns.dep).toBe(baked.dep);
    expect(bakeRuns.holey).toBe(baked.holey + 1);
    expect(nav.flight).toContain(`plain-run-${baked.plain}`);
  });

  it("an ssr: false loader on an entry with loading() is pinned on a client navigation, as on a document HIT", async () => {
    const { serve } = setup();
    await serve("/bake-under-loading");
    const baked = underLoadingRuns.baked;

    const hit = await serve("/bake-under-loading");
    expect(hit.shellStatus).toBe("HIT");
    expect(underLoadingRuns.baked).toBe(baked);

    const nav = await serve("/bake-under-loading", {
      partial: { from: "/about" },
    });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(underLoadingRuns.baked).toBe(baked);
    expect(nav.flight).toContain(`x-run-${baked}`);
    // loading() still masks its live sibling: it runs.
    expect(nav.flight).toContain(`live-under-loading-${underLoadingRuns.live}`);
  });
});

describe("serveShellRequest: a MISS that races another request's capture", () => {
  it("does not capture again when another request's capture stored the shell while the MISS rendered", async () => {
    const { cacheStore, serve } = setup();
    const putShell = vi.spyOn(cacheStore, "putShell");
    let release!: () => void;
    race.hold = new Promise<void>((resolve) => (release = resolve));
    const entered = new Promise<void>((resolve) => (race.entered = resolve));

    // The first request reads the store (MISS) and holds in its render; a
    // second request misses, captures and stores the shell meanwhile.
    const first = serve("/raced");
    await entered;
    const second = await serve("/raced");
    release();
    const firstResult = await first;

    expect([firstResult.shellStatus, second.shellStatus]).toEqual([
      "MISS",
      "MISS",
    ]);
    // The second request's capture only: the first MISS skips its own.
    expect(putShell).toHaveBeenCalledTimes(1);
    expect((await serve("/raced")).shellStatus).toBe("HIT");
  });
});

describe("serveShellRequest: owned pushes a route cache() record restores into a capture", () => {
  it("keep their loader as owner, so that loader's run on a HIT replaces them instead of adding a copy", async () => {
    const { serve, cacheStore } = setup();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    const recordKey = "doc:localhost/owned-replay";

    expect((await serve("/owned-replay")).shellStatus).toBe("MISS");
    // A recapture that misses the route record writes it, the loader's
    // pushes owned by the loader.
    await cacheStore.delete(recordKey);
    offset += 11_000;
    expect((await serve("/owned-replay")).shellStatus).toBe("HIT");
    const record = await cacheStore.get(recordKey);
    if (!record || typeof record !== "object") throw new Error("no record");
    expect(record.data.handleOwners).toBeTruthy();
    // The next recapture restores those pushes from that record.
    offset += 11_000;
    expect((await serve("/owned-replay")).shellStatus).toBe("HIT");

    const hit = await serve("/owned-replay");

    expect(hit.shellStatus).toBe("HIT");
    expect(hit.flight?.match(/owned-note-\d+/g) ?? []).toHaveLength(1);
  });
});

describe("serveShellRequest: a shell never outlives its route cache() entry", () => {
  it("once the route's cache() ttl has passed, a document request no longer HITs the older shell", async () => {
    const { serve } = setup();
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);

    expect((await serve("/short-cache")).shellStatus).toBe("MISS");
    expect((await serve("/short-cache")).shellStatus).toBe("HIT");

    // Past cache({ ttl: 1 }), well inside ppr.ttl 300.
    offset = 2_000;
    source.generation = 2;
    const later = await serve("/short-cache");

    expect(later.shellStatus).toBe("MISS");
    expect(later.flight).toContain("short@g2");
  });

  /** The real clock, which the test also moves forward by hand. */
  function movableClock(): { advance: (ms: number) => void } {
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    return { advance: (ms) => (offset += ms) };
  }

  it("memory store (its segment records drop swr): a stale-from-start shell is served, then recaptured from a newly rendered record", async () => {
    const clock = movableClock();
    const { serve, cacheStore } = setup();
    const putShell = vi.spyOn(cacheStore, "putShell");
    expect((await serve("/stale-record")).shellStatus).toBe("MISS");
    // cache({ ttl: 0, swr: 60 }): fresh for 0 s, servable for 60.
    expect(putShell.mock.calls.map(([, , ttl, swr]) => [ttl, swr])).toEqual([
      [0, 60],
    ]);
    source.generation = 2;
    clock.advance(1_100);

    const stale = await serve("/stale-record");

    expect(stale.shellStatus).toBe("HIT");
    expect(stale.prelude).toContain("stale@g1");
    const next = await serve("/stale-record");
    expect(next.shellStatus).toBe("HIT");
    expect(next.prelude).toContain("stale@g2");
  });

  it("CFCacheStore: recaptures of a stale-from-start shell replay the stale record, and converge on its refresh", async () => {
    freshEdgeCache();
    const clock = movableClock();
    const router = cfRouter({ shellMs: 0 });
    const env = { KV: kv() };
    const serveCf = () => serveShellRequest(router, "/stale-record", { env });
    expect((await serveCf()).shellStatus).toBe("MISS");
    source.generation = 2;

    const shown: (string | undefined)[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1_100);
      const hit = await serveCf();
      expect(hit.shellStatus).toBe("HIT");
      shown.push(hit.prelude?.match(/stale@g\d/)?.[0]);
    }

    // The first recapture replays the stale record (g1) and schedules its
    // refresh; a later one replays the refreshed record.
    expect(shown[0]).toBe("stale@g1");
    expect(shown[1]).toBe("stale@g1");
    expect(shown[2]).toBe("stale@g2");
  });

  it("a stale HIT recaptures at most once per SHELL_MIN_RECAPTURE_INTERVAL_MS of the shell's age", async () => {
    freshEdgeCache();
    const clock = movableClock();
    const putShell = vi.spyOn(CFCacheStore.prototype, "putShell");
    const router = cfRouter({ shellMs: 0 });
    const env = { KV: kv() };
    const serveCf = () => serveShellRequest(router, "/stale-record", { env });
    expect((await serveCf()).shellStatus).toBe("MISS");
    expect(putShell).toHaveBeenCalledTimes(1);

    // Well inside the floor: each serve takes a few ms of real time.
    for (let i = 0; i < 3; i++) {
      expect((await serveCf()).shellStatus).toBe("HIT");
    }
    expect(putShell).toHaveBeenCalledTimes(1);

    clock.advance(SHELL_MIN_RECAPTURE_INTERVAL_MS);
    expect((await serveCf()).shellStatus).toBe("HIT");
    expect(putShell).toHaveBeenCalledTimes(2);
  });

  it("VercelCacheStore: a stale HIT inside the floor claims no revalidation lock, so the first HIT past it recaptures", async () => {
    const clock = movableClock();
    const store = new VercelCacheStore({
      cache: vercelCache().cache,
      memo: { shellMs: 0 },
    });
    const putShell = vi.spyOn(store, "putShell");
    const { serve } = setup({ cacheStore: store });
    expect((await serve("/stale-record")).shellStatus).toBe("MISS");
    expect(putShell).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 3; i++) {
      expect((await serve("/stale-record")).shellStatus).toBe("HIT");
    }
    expect(putShell).toHaveBeenCalledTimes(1);

    clock.advance(SHELL_MIN_RECAPTURE_INTERVAL_MS);
    expect((await serve("/stale-record")).shellStatus).toBe("HIT");
    expect(putShell).toHaveBeenCalledTimes(2);
  });

  /**
   * Serve `/near-expiry` through a store whose record reads return the entry
   * at its deadline (`atDeadline` decides which reads, counting from 1).
   */
  function nearExpiryStore(atDeadline: (read: number) => boolean) {
    const cacheStore = new MemorySegmentCacheStore();
    const get = cacheStore.get.bind(cacheStore);
    const reads = { count: 0 };
    vi.spyOn(cacheStore, "get").mockImplementation(async (key) => {
      const result = await get(key);
      if (key !== "doc:localhost/near-expiry") return result;
      if (!result || typeof result !== "object") return result;
      reads.count += 1;
      return atDeadline(reads.count)
        ? { ...result, data: { ...result.data, expiresAt: Date.now() } }
        : result;
    });
    return { ...setup({ cacheStore }), reads };
  }

  it("a capture that outlives the near-expiry record it replayed retries on a fresh match and stores, without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // cache({ ttl: 300 }): the capture's first read of the record sees it at
    // its end (a record written about 300 s ago).
    const { serve, cacheStore, reads } = nearExpiryStore((read) => read === 1);
    const putShell = vi.spyOn(cacheStore, "putShell");

    expect((await serve("/near-expiry")).shellStatus).toBe("MISS");

    expect(reads.count).toBe(2);
    expect(putShell.mock.calls.map(([, , ttl]) => ttl)).toEqual([300]);
    expect((await serve("/near-expiry")).shellStatus).toBe("HIT");
    expect(
      warn.mock.calls.filter(([m]) => String(m).includes("cache() entry")),
    ).toEqual([]);
  });

  it("a retry whose record also runs out is terminal: no shell, a backoff, one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore, reads } = nearExpiryStore(() => true);
    const putShell = vi.spyOn(cacheStore, "putShell");

    expect((await serve("/near-expiry")).shellStatus).toBe("MISS");
    expect(reads.count).toBe(2);
    // Backed off: the foreground reads the record, no capture does.
    expect((await serve("/near-expiry")).shellStatus).toBe("MISS");
    expect(reads.count).toBe(3);

    expect(putShell).not.toHaveBeenCalled();
    const warnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes("ran out before the shell capture"),
      );
    expect(warnings).toEqual([
      expect.stringContaining(
        'Route "nearExpiry": its cache() entry (ttl 300, swr 0) ran out before the shell capture could store a shell (twice in a row;',
      ),
    ]);
  });

  it("a retry that produces no shell after an expired attempt warns with its cause, like the no-shell retry", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cacheStore = new MemorySegmentCacheStore();
    const get = cacheStore.get.bind(cacheStore);
    let reads = 0;
    vi.spyOn(cacheStore, "get").mockImplementation(async (key) => {
      const result = await get(key);
      if (key !== "doc:localhost/slow-near-expiry") return result;
      if (!result || typeof result !== "object") return result;
      reads += 1;
      // Attempt 1 replays the record at its deadline; attempt 2 finds none
      // and renders the handler, past ppr.captureTimeout (50 ms).
      if (reads === 1) {
        return { ...result, data: { ...result.data, expiresAt: Date.now() } };
      }
      return null;
    });
    const { serve } = setup({ cacheStore });

    expect((await serve("/slow-near-expiry")).shellStatus).toBe("MISS");

    expect(reads).toBe(2);
    const noShell = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("produced no usable shell"));
    expect(noShell).toEqual([
      expect.stringContaining("after an in-place retry"),
    ]);
    expect(noShell[0]).toContain("Cause:");
  });

  it("an expired attempt is not retried without the hard-cap budget for a whole second attempt", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore, reads } = nearExpiryStore((read) => {
      // Attempt 1 reads its record 10 s into the capture task.
      if (read === 1) perfOffset += 10_000;
      return read === 1;
    });
    let perfOffset = 0;
    const realPerfNow = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(
      () => realPerfNow() + perfOffset,
    );
    const putShell = vi.spyOn(cacheStore, "putShell");

    expect((await serve("/near-expiry")).shellStatus).toBe("MISS");

    expect(reads.count).toBe(1);
    expect(putShell).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.filter(([m]) =>
        String(m).includes("(no time was left to retry;"),
      ),
    ).toHaveLength(1);
  });

  it("a record this capture read is retried even when its cache() ttl + swr is shorter than the capture; the retry that writes its own refuses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore } = setup();
    const putShell = vi.spyOn(cacheStore, "putShell");
    // cache({ ttl: 0, swr: 0 }): the first capture read gets the record the
    // foreground wrote, at its deadline; later reads miss, as the store does.
    const recordKey = "doc:localhost/dead-record";
    let written: CachedEntryData | undefined;
    const set = cacheStore.set.bind(cacheStore);
    vi.spyOn(cacheStore, "set").mockImplementation(
      async (key, data, ...rest) => {
        if (key === recordKey) written ??= data;
        return set(key, data, ...rest);
      },
    );
    const get = cacheStore.get.bind(cacheStore);
    let readsAfterWrite = 0;
    vi.spyOn(cacheStore, "get").mockImplementation(async (key) => {
      const result = await get(key);
      if (key !== recordKey || !written) return result;
      readsAfterWrite += 1;
      return readsAfterWrite === 1
        ? {
            data: { ...written, expiresAt: Date.now() },
            shouldRevalidate: false,
          }
        : result;
    });

    expect((await serve("/dead-record")).shellStatus).toBe("MISS");

    expect(readsAfterWrite).toBe(2);
    expect(putShell).not.toHaveBeenCalled();
    const warnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes("ran out before the shell capture"),
      );
    expect(warnings).toEqual([
      expect.stringContaining("ms after this capture wrote it)"),
    ]);
  });

  it("a capture that writes a route cache() entry shorter than itself stores no shell, and warns once per route", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore } = setup();
    const putShell = vi.spyOn(cacheStore, "putShell");
    const clock = movableClock();

    expect((await serve("/dead-record")).shellStatus).toBe("MISS");
    // Past the refused capture's backoff: a second capture, no second warning.
    clock.advance(5_000);
    expect((await serve("/dead-record")).shellStatus).toBe("MISS");

    expect(putShell).not.toHaveBeenCalled();
    const warnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) =>
        message.includes("ran out before the shell capture"),
      );
    expect(warnings).toEqual([
      expect.stringContaining(
        'Route "deadRecord": its cache() entry (ttl 0, swr 0) ran out before the shell capture could store a shell (',
      ),
    ]);
  });
});

describe("serveShellRequest: the forced-MISS marker", () => {
  it("is stripped before anything reads the request: the render sees the clean URL and caches under its key", async () => {
    const { serve, cacheStore } = setup();
    const set = vi.spyOn(cacheStore, "set");

    const marked = await serve("/echo?probe=1&_rsc_shell=miss");

    expect(marked.shellStatus).toBeNull();
    expect(marked.flight).toContain(
      "url=?probe=1|request=?probe=1|original=?probe=1",
    );
    expect(marked.flight).toContain('"loaderUrls":"?probe=1|?probe=1"');
    expect(marked.body).not.toContain("_rsc_shell");
    expect(set.mock.calls.map(([key]) => key)).toContain(
      "doc:localhost/echo?probe=1",
    );
    // No shell under any key: the gate passed the request.
    expect(await marked.readEntry()).toBeNull();
  });

  it("a marked request HITs the route's cache() entry for the clean URL, running no handler", async () => {
    const { serve } = setup();
    await serve("/echo?probe=2");
    const before = echoRuns;

    const marked = await serve("/echo?probe=2&_rsc_shell=miss");

    expect(marked.shellStatus).toBeNull();
    expect(echoRuns).toBe(before);
    expect(marked.flight).toContain("url=?probe=2|request=?probe=2");
  });

  it("a corrupt cache() record on a marked request is a miss: the handler renders and no reload script is sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { serve, cacheStore } = setup();
    await serve("/echo?probe=3");
    const key = "doc:localhost/echo?probe=3";
    const stored = await cacheStore.get(key);
    if (!stored || typeof stored !== "object") throw new Error("no record");
    // An undecodable record: its segments are not Flight fragments.
    const corrupt = { ...stored.data, segments: ["corrupt"] } as unknown;
    await cacheStore.set(key, corrupt as typeof stored.data, 300);
    const before = echoRuns;

    const marked = await serve("/echo?probe=3&_rsc_shell=miss");

    expect(marked.response.status).toBe(200);
    expect(marked.shellStatus).toBeNull();
    expect(echoRuns).toBe(before + 1);
    expect(marked.body).not.toContain("location.replace");
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
