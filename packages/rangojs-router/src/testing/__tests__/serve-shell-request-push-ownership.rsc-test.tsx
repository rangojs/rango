/**
 * The one-run rule, through serveShellRequest: a loader's data and the handle
 * values it pushed come from the same run on every path a request can take
 * (docs/design/handle-push-ownership.md).
 *
 * `source.generation` moves on between requests: a value from the capture or
 * from a cache entry written at generation N reads @gN, a live run reads the
 * current generation. Each test asserts the loader's data and its push carry
 * the same generation.
 *
 * A `red` test states the target behavior and fails on origin/main
 * (d42b56e7): vitest's `it.fails` keeps the suite green while the test
 * fails, and turns red the moment it passes. The design doc lists each one's
 * failing assertion. A plain `it` passes today and must keep passing.
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

import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { navigationShellKey } from "../../rsc/shell-capture-constants.js";

const red = it.fails;

const source = { generation: 1 };

/** Body runs, across requests of one test. */
const runs = { deferred: 0, sch: 0, owned: 0 };

const Notes = createHandle<string>();

/**
 * A promise-carrying `ssr: false` loader: it runs on every shell HIT and
 * every navigation replay, and pushes a settled value (#1003).
 */
const EbBake = createLoader(async (ctx) => {
  ctx.use(Notes)(`eb-after@g${source.generation}`);
  return {
    eb: `eb@g${source.generation}`,
    later: Promise.resolve("eb-later"),
  };
});

/**
 * A promise-free `ssr: false` loader with its own cache() that pushes a
 * settled and a deferred value (#1001).
 */
const DeferredOwned = createLoader(async (ctx) => {
  runs.deferred += 1;
  const run = runs.deferred;
  ctx.use(Notes)(`settled-note-${run}`);
  ctx.use(Notes)(Promise.resolve(`deferred-note-${run}`));
  return { deferredOwned: `deferred-owned-run-${run}` };
});

/**
 * A promise-carrying `ssr: false` loader with its own cache(), under a route
 * cache(): the route record a capture writes keeps its push as owned.
 */
const OwnedBake = createLoader(async (ctx) => {
  runs.owned += 1;
  ctx.use(Notes)(`owned-note@g${source.generation}`);
  return {
    owned: `owned@g${source.generation}`,
    later: Promise.resolve("owned-later"),
  };
});

/** Awaited by BakeAwaitsDep only: the route registers it on neither lane. */
const DepNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`dep-note@g${source.generation}`);
  return { dep: `dep@g${source.generation}` };
});

/** A promise-free `ssr: false` loader whose value derives from DepNoted's. */
const BakeAwaitsDep = createLoader(async (ctx) => ({
  baked: `baked-${(await ctx.use(DepNoted)).dep}`,
}));

/** A loader with its own cache() that other loaders and handlers read (#1002). */
const SchHole = createLoader(async (ctx) => {
  runs.sch += 1;
  ctx.use(Notes)(`sch-note@g${source.generation}`);
  return { sch: `sch@g${source.generation}` };
});

/** Reads SchHole before its first await; promise-carrying, so it runs on a HIT. */
const SchBakeReader = createLoader(async (ctx) => {
  const { sch } = await ctx.use(SchHole);
  return { reader: `reader-${sch}`, later: Promise.resolve("reader-later") };
});

/** Reads SchHole before its first await. */
const SchReader = createLoader(async (ctx) => {
  const { sch } = await ctx.use(SchHole);
  return { reader: `reader-${sch}` };
});

async function SchReadingLayout(ctx: HandlerContext): Promise<React.ReactNode> {
  const { sch } = await ctx.use(SchHole);
  return <header>{`layout-${sch}`}</header>;
}

async function SchReadingPage(ctx: HandlerContext): Promise<React.ReactNode> {
  const { sch } = await ctx.use(SchHole);
  return <p>{`page-${sch}`}</p>;
}

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, loader, loading, cache, intercept }) => [
      path("/about", () => <p>about</p>, { name: "about" }),
      path(
        "/eb",
        () => <p>eb</p>,
        { name: "eb", ppr: true },
        () => [loader(EbBake, { ssr: false })],
      ),
      // The pins are over the cap: the entry keeps its doc record only.
      path(
        "/eb-capped",
        () => <p>eb capped</p>,
        { name: "ebCapped", ppr: { maxSnapshotBytes: 1 } },
        () => [loader(EbBake, { ssr: false })],
      ),
      path(
        "/dep",
        () => <p>dep</p>,
        { name: "dep", ppr: true },
        () => [loader(BakeAwaitsDep, { ssr: false })],
      ),
      path(
        "/dep-capped",
        () => <p>dep capped</p>,
        { name: "depCapped", ppr: { maxSnapshotBytes: 1 } },
        () => [loader(BakeAwaitsDep, { ssr: false })],
      ),
      cache({ ttl: 3000 }, () => [
        path(
          "/eb-cached",
          () => <p>eb cached</p>,
          { name: "ebCached", ppr: true },
          () => [loader(EbBake, { ssr: false })],
        ),
        path(
          "/owned-cached",
          () => <p>owned cached</p>,
          { name: "ownedCached", ppr: { ttl: 10, swr: 20 } },
          () => [
            loader(OwnedBake, { ssr: false }, () => [cache({ ttl: 3000 })]),
          ],
        ),
      ]),
      path(
        "/deferred-owned",
        () => <p>deferred owned</p>,
        { name: "deferredOwned", ppr: true },
        () => [
          loader(DeferredOwned, { ssr: false }, () => [cache({ ttl: 300 })]),
        ],
      ),
      path(
        "/sch",
        () => <p>sch</p>,
        { name: "sch", ppr: true },
        () => [
          loader(SchBakeReader, { ssr: false }),
          loader(SchHole, () => [cache({ ttl: 300 })]),
          loading(<p>loading sch</p>),
        ],
      ),
      path(
        "/sch-rev",
        () => <p>sch rev</p>,
        { name: "schRev", ppr: true },
        () => [
          loader(SchHole, () => [cache({ ttl: 300 })]),
          loader(SchBakeReader, { ssr: false }),
          loading(<p>loading sch</p>),
        ],
      ),
      path(
        "/sch-plain",
        () => <p>sch plain</p>,
        { name: "schPlain" },
        () => [loader(SchReader), loader(SchHole, () => [cache({ ttl: 300 })])],
      ),
      path("/sch-handler", SchReadingPage, { name: "schHandler" }, () => [
        loader(SchHole, () => [cache({ ttl: 300 })]),
      ]),
      layout(
        () => <header>sch layout</header>,
        () => [
          loader(SchReader),
          path(
            "/sch-layout-loader",
            () => <p>sch layout loader</p>,
            { name: "schLayoutLoader" },
            () => [loader(SchHole, () => [cache({ ttl: 300 })])],
          ),
        ],
      ),
      layout(SchReadingLayout, () => [
        path(
          "/sch-layout-handler",
          () => <p>sch layout handler</p>,
          { name: "schLayoutHandler" },
          () => [loader(SchHole, () => [cache({ ttl: 300 })])],
        ),
      ]),
      layout(
        () => <main>sch list shell</main>,
        () => [
          path("/sch-list", () => <ul>list</ul>, { name: "schList" }),
          path("/sch-item", () => <article>item</article>, {
            name: "schItem",
          }),
          intercept(
            "@modal",
            "schItem",
            () => <dialog>modal</dialog>,
            () => [
              loader(SchReader),
              loader(SchHole, () => [cache({ ttl: 300 })]),
            ],
          ),
        ],
      ),
    ]),
  );
}

function setup() {
  const router = makeRouter();
  const cacheStore = new MemorySegmentCacheStore();
  const serve = (
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) => serveShellRequest(router, url, { cacheStore, ...extra });
  /** `loader:` reads miss while `fn` runs: a cached loader refills its entry. */
  const withLoaderMiss = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const getItem = cacheStore.getItem.bind(cacheStore);
    const spy = vi
      .spyOn(cacheStore, "getItem")
      .mockImplementation(async (key) =>
        key.startsWith("loader:") ? null : getItem(key),
      );
    try {
      return await fn();
    } finally {
      spy.mockRestore();
    }
  };
  return { router, cacheStore, serve, withLoaderMiss };
}

/** The distinct values of `pattern` in the payload. */
function distinct(flight: string | undefined, pattern: RegExp): string[] {
  return [...new Set(flight?.match(pattern) ?? [])];
}

/**
 * The values of `pattern` in the last Flight row that carries one. A handle
 * update is the full state, so the last row is what the client ends with.
 */
function final(flight: string | undefined, pattern: RegExp): string[] {
  const rows = (flight ?? "").split("\n").filter((row) => row.match(pattern));
  return rows.at(-1)?.match(pattern) ?? [];
}

beforeEach(async () => {
  source.generation = 1;
  runs.deferred = 0;
  runs.sch = 0;
  runs.owned = 0;
  await resetShellTestState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one run per loader: a shell record's pushes follow the loader's pin", () => {
  it("a document HIT keeps a promise-carrying ssr: false loader's captured push next to its pinned data", async () => {
    const { serve } = setup();
    expect((await serve("/eb")).shellStatus).toBe("MISS");
    source.generation = 2;

    const hit = await serve("/eb");

    expect(hit.shellStatus).toBe("HIT");
    expect(distinct(hit.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
    expect(final(hit.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
  });

  // #1003
  red(
    "a navigation replay keeps the captured push next to the pinned data",
    async () => {
      const { serve } = setup();
      expect((await serve("/eb")).shellStatus).toBe("MISS");
      source.generation = 3;

      const nav = await serve("/eb", { partial: { from: "/about" } });

      expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
      expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
      expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
    },
  );

  // #1003, the prefetch that fills the client's prefetch cache.
  red(
    "a prefetch replay keeps the captured push next to the pinned data",
    async () => {
      const { serve } = setup();
      expect((await serve("/eb")).shellStatus).toBe("MISS");
      source.generation = 3;

      const prefetch = await serve("/eb", {
        partial: { from: "/about" },
        headers: { "X-Rango-Prefetch": "1" },
      });

      expect(prefetch.replayStatus).toEqual({
        outcome: "HIT",
        freshness: "fresh",
      });
      expect(distinct(prefetch.flight, /"eb":"eb@g\d"/g)).toEqual([
        '"eb":"eb@g1"',
      ]);
      expect(final(prefetch.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
    },
  );

  // The first attempt at #1003 (PR #1018) restored the capture's push on
  // every replay: an entry without loader pins runs the loader fresh.
  it("a navigation replay of a navigation-only entry (no pins) keeps the fresh run's data and push", async () => {
    const { serve, cacheStore } = setup();
    const cold = await serve("/eb", { partial: { from: "/about" } });
    expect(cold.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    const stored = await cacheStore.getShell(navigationShellKey(cold.key));
    expect(stored?.entry.navigationOnly).toBe(true);
    expect(stored?.entry.snapshot.map((record) => record.family)).toEqual([
      "segment",
    ]);
    source.generation = 2;

    const nav = await serve("/eb", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g2"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g2"]);
  });

  red(
    "a document HIT of an entry whose pins maxSnapshotBytes dropped keeps the fresh run's data and push",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup();
      const miss = await serve("/eb-capped");
      expect(miss.shellStatus).toBe("MISS");
      const entry = await miss.readEntry();
      expect(entry?.snapshot?.map((record) => record.family)).toEqual([
        "segment",
      ]);
      source.generation = 2;

      const hit = await serve("/eb-capped");

      expect(hit.shellStatus).toBe("HIT");
      expect(distinct(hit.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g2"']);
      expect(final(hit.flight, /eb-after@g\d/g)).toEqual(["eb-after@g2"]);
    },
  );

  it("a navigation replay of an entry whose pins maxSnapshotBytes dropped keeps the fresh run's data and push", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();
    expect((await serve("/eb-capped")).shellStatus).toBe("MISS");
    source.generation = 3;

    const nav = await serve("/eb-capped", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g3"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g3"]);
  });

  it("a dependency's captured push stays next to the pinned loader that awaited it", async () => {
    const { serve } = setup();
    expect((await serve("/dep")).shellStatus).toBe("MISS");
    source.generation = 2;

    const hit = await serve("/dep");
    const nav = await serve("/dep", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    for (const flight of [hit.flight, nav.flight]) {
      expect(distinct(flight, /baked-dep@g\d/g)).toEqual(["baked-dep@g1"]);
      expect(final(flight, /dep-note@g\d/g)).toEqual(["dep-note@g1"]);
    }
  });

  red(
    "without pins a dependency's push follows the fresh run of the loader that awaits it",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup();
      expect((await serve("/dep-capped")).shellStatus).toBe("MISS");
      source.generation = 2;

      const hit = await serve("/dep-capped");
      const nav = await serve("/dep-capped", { partial: { from: "/about" } });

      expect(hit.shellStatus).toBe("HIT");
      expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
      expect({
        hit: {
          data: distinct(hit.flight, /baked-dep@g\d/g),
          push: final(hit.flight, /dep-note@g\d/g),
        },
        nav: {
          data: distinct(nav.flight, /baked-dep@g\d/g),
          push: final(nav.flight, /dep-note@g\d/g),
        },
      }).toEqual({
        hit: { data: ["baked-dep@g2"], push: ["dep-note@g2"] },
        nav: { data: ["baked-dep@g2"], push: ["dep-note@g2"] },
      });
    },
  );

  red(
    "a navigation whose explicit route cache() misses replays the shell record: the captured push stays next to the pinned data",
    async () => {
      const { serve, cacheStore } = setup();
      expect((await serve("/eb-cached")).shellStatus).toBe("MISS");
      await cacheStore.delete("doc:localhost/eb-cached");
      await cacheStore.delete("partial:localhost/eb-cached");
      source.generation = 3;

      const nav = await serve("/eb-cached", { partial: { from: "/about" } });

      expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
      expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
      expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
    },
  );

  it("a navigation whose explicit route cache() hits runs the loader: its data and push are the run's", async () => {
    const { serve } = setup();
    // A cold navigation renders and writes the route's partial record.
    const cold = await serve("/eb-cached", { partial: { from: "/about" } });
    expect(cold.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    expect((await serve("/eb-cached")).shellStatus).toBe("MISS");
    source.generation = 3;

    const nav = await serve("/eb-cached", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "explicit-cache-hit",
    });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g3"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g3"]);
  });
});

describe("one run per loader: a deferred push reaches every replay of its pin (#1001)", () => {
  for (const variant of ["misses", "is warm"] as const) {
    red(
      `a navigation replay delivers the deferred push of the loader's cache() entry (the entry ${variant} at capture)`,
      async () => {
        const { serve, withLoaderMiss } = setup();
        if (variant === "is warm") {
          // A navigation MISS fills the loader's entry before any capture.
          await serve("/deferred-owned", { partial: { from: "/about" } });
          await resetShellTestState();
        }
        const miss =
          variant === "misses"
            ? await withLoaderMiss(() => serve("/deferred-owned"))
            : await serve("/deferred-owned");
        expect(miss.shellStatus).toBe("MISS");
        const captured = runs.deferred;

        const hit = await serve("/deferred-owned");
        const nav = await serve("/deferred-owned", {
          partial: { from: "/about" },
        });

        // Every copy in the payload is the capture's run, the deferred one
        // included (its value arrives on a row of its own), and the settled
        // one shows once in the final handle state.
        const notes = (flight: string | undefined) => ({
          settled: distinct(flight, /settled-note-\d+/g),
          deferred: distinct(flight, /deferred-note-\d+/g),
          settledInFinalState: final(flight, /settled-note-\d+/g).length,
        });
        const captureOnly = {
          settled: [`settled-note-${captured}`],
          deferred: [`deferred-note-${captured}`],
          settledInFinalState: 1,
        };
        expect(hit.shellStatus).toBe("HIT");
        expect(notes(hit.flight)).toEqual(captureOnly);
        expect(nav.replayStatus).toEqual({
          outcome: "HIT",
          freshness: "fresh",
        });
        expect(runs.deferred).toBe(captured);
        expect(notes(nav.flight)).toEqual(captureOnly);
      },
    );
  }
});

describe("one run per loader: a route cache() record's copy of a loader push never outranks the loader's own source", () => {
  red(
    "a document MISS that hits the route cache() record and the loader's cache() entry shows the entry's push next to its data",
    async () => {
      const { serve, cacheStore, withLoaderMiss } = setup();
      const realNow = Date.now.bind(Date);
      let offset = 0;
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
      const recordKey = "doc:localhost/owned-cached";

      expect((await serve("/owned-cached")).shellStatus).toBe("MISS");
      // A recapture that misses the route record writes it, with the loader's
      // push owned by the loader (its cache() entry replays it at g1).
      await cacheStore.delete(recordKey);
      offset += 11_000;
      expect((await serve("/owned-cached")).shellStatus).toBe("HIT");
      const record = await cacheStore.get(recordKey);
      if (!record || typeof record !== "object" || !("data" in record)) {
        throw new Error("no route record");
      }
      expect(record.data.handleOwners).toBeTruthy();
      // The loader's entry refills at g2 on a navigation, which leaves the
      // route's doc record alone.
      source.generation = 2;
      await withLoaderMiss(() =>
        serve("/owned-cached", { partial: { from: "/about" } }),
      );
      source.generation = 3;
      // Past the shell's ttl + swr: the document request misses the shell and
      // hits the route record.
      offset += 31_000;

      const miss = await serve("/owned-cached");

      expect(miss.shellStatus).toBe("MISS");
      expect(distinct(miss.flight, /"owned":"owned@g\d"/g)).toEqual([
        '"owned":"owned@g2"',
      ]);
      expect(final(miss.flight, /owned-note@g\d/g)).toEqual(["owned-note@g2"]);
    },
  );
});

describe("one value per loader per request: a reader gets the cache() binding's value (#1002)", () => {
  /** g1 fills the loader's entry; the request under test runs at g2. */
  async function twice(
    url: string,
    extra: Omit<ServeShellRequestOptions, "cacheStore"> = {},
  ) {
    const { serve } = setup();
    const first = await serve(url, extra);
    expect(runs.sch).toBe(1);
    source.generation = 2;
    const second = await serve(url, extra);
    return { first, second };
  }

  /** The cached loader as the request shows it, and its body runs so far. */
  function seen(flight: string | undefined, reader: RegExp) {
    return {
      bodyRuns: runs.sch,
      data: distinct(flight, /"sch":"sch@g\d"/g),
      push: final(flight, /sch-note@g\d/g),
      reader: distinct(flight, reader),
    };
  }

  /** The g1 entry hit: the body did not run again, every reader saw g1. */
  function expectEntryOnly(flight: string | undefined, reader: RegExp): void {
    expect(seen(flight, reader)).toEqual({
      bodyRuns: 1,
      data: ['"sch":"sch@g1"'],
      push: ["sch-note@g1"],
      reader: [reader.source.replace("\\d", "1")],
    });
  }

  red(
    "the entry a request writes records the cached loader's pushes when a reader started the loader first",
    async () => {
      const { serve, cacheStore } = setup();
      const setItem = vi.spyOn(cacheStore, "setItem");

      await serve("/sch-plain");

      const write = setItem.mock.calls.find(
        ([key]) => key.startsWith("loader:") && key.endsWith("/sch-plain"),
      );
      expect(write?.[2]?.handles ?? "").toContain("sch-note@g1");
    },
  );

  red(
    "a sibling loader declared before the binding (a route without ppr)",
    async () => {
      const { second } = await twice("/sch-plain");
      expectEntryOnly(second.flight, /reader-sch@g\d/g);
    },
  );

  it("a handler on the binding's own route (control: the binding starts first)", async () => {
    const { second } = await twice("/sch-handler");
    expectEntryOnly(second.flight, /page-sch@g\d/g);
  });

  red(
    "a parent layout's loader reading a child route's cached loader",
    async () => {
      const { second } = await twice("/sch-layout-loader");
      expectEntryOnly(second.flight, /reader-sch@g\d/g);
    },
  );

  red(
    "a parent layout's handler reading a child route's cached loader",
    async () => {
      const { second } = await twice("/sch-layout-handler");
      expectEntryOnly(second.flight, /layout-sch@g\d/g);
    },
  );

  red(
    "a sibling loader declared before the binding on an intercept",
    async () => {
      const { second } = await twice("/sch-item", {
        partial: { from: "/sch-list" },
      });
      expectEntryOnly(second.flight, /reader-sch@g\d/g);
    },
  );

  for (const [path, order] of [
    ["/sch", "before"],
    ["/sch-rev", "after"],
  ] as const) {
    (order === "before" ? red : it)(
      `a ppr route: an ssr: false reader declared ${order} the cached hole, on a HIT and a navigation replay`,
      async () => {
        const { serve, withLoaderMiss } = setup();
        expect((await serve(path)).shellStatus).toBe("MISS");
        source.generation = 2;
        // The hole's entry refills at g2.
        expect((await withLoaderMiss(() => serve(path))).shellStatus).toBe(
          "HIT",
        );
        const filled = runs.sch;
        source.generation = 3;

        const hit = await serve(path);
        const nav = await serve(path, { partial: { from: "/about" } });

        expect(hit.shellStatus).toBe("HIT");
        expect(nav.replayStatus).toEqual({
          outcome: "HIT",
          freshness: "fresh",
        });
        expect({
          bodyRuns: runs.sch - filled,
          hit: {
            data: distinct(hit.flight, /"sch":"sch@g\d"/g),
            push: final(hit.flight, /sch-note@g\d/g),
          },
          nav: {
            data: distinct(nav.flight, /"sch":"sch@g\d"/g),
            push: final(nav.flight, /sch-note@g\d/g),
          },
        }).toEqual({
          bodyRuns: 0,
          hit: { data: ['"sch":"sch@g2"'], push: ["sch-note@g2"] },
          nav: { data: ['"sch":"sch@g2"'], push: ["sch-note@g2"] },
        });
      },
    );
  }
});
