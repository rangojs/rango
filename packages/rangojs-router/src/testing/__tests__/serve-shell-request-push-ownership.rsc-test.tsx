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
 * The pin groups (#1001, #1003 and the paths that fall out of the same
 * change) are plain tests; the design doc records the assertion each one
 * failed with before the fix. The two PENDING groups are open: their `red`
 * tests are vitest's `it.fails`, which keeps the suite green while a test
 * fails and turns it red the moment the test passes.
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
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { navigationShellKey } from "../../rsc/shell-capture-constants.js";
import {
  DeferredOwnedLoader,
  deferredOwnedRuns,
  OnceNotedBakeLoader,
  OuterDepLoader,
  shellHarness,
  source,
} from "./fixtures/shell-request-data.js";

const red = it.fails;

/** Body runs, across requests of one test. */
const runs = { sch: 0, owned: 0, ownedDep: 0, order: 0 };

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
 * A promise-carrying `ssr: false` loader with its own cache(): a route
 * cache() record or a shell record a capture writes keeps its push as owned.
 */
const OwnedBake = createLoader(async (ctx) => {
  runs.owned += 1;
  ctx.use(Notes)(`owned-note@g${source.generation}`);
  return {
    owned: `owned@g${source.generation}`,
    later: Promise.resolve("owned-later"),
  };
});

/** Awaited by other loaders only: no route registers it on either lane. */
const DepNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`dep-note@g${source.generation}`);
  return { dep: `dep@g${source.generation}` };
});

/** A promise-free `ssr: false` loader whose value derives from DepNoted's. */
const BakeAwaitsDep = createLoader(async (ctx) => ({
  baked: `baked-${(await ctx.use(DepNoted)).dep}`,
}));

/**
 * A promise-carrying `ssr: false` loader whose value derives from DepNoted's:
 * it runs on a HIT, and DepNoted runs inside it.
 */
const HoleyAwaitsDep = createLoader(async (ctx) => ({
  holey: `holey-${(await ctx.use(DepNoted)).dep}`,
  later: Promise.resolve("holey-later"),
}));

/** A promise-free `ssr: false` loader that neither pushes nor awaits. */
const PlainBake = createLoader(async () => ({
  plain: `plain@g${source.generation}`,
}));

/**
 * An `ssr: false` loader with its own cache() that awaits DepNoted and then
 * pushes: its entry records the dependency's push and its own.
 */
const OwnedAwaitsDep = createLoader(async (ctx) => {
  runs.ownedDep += 1;
  const { dep } = await ctx.use(DepNoted);
  ctx.use(Notes)(`owned-dep-note@g${source.generation}`);
  return { ownedDep: `owned-${dep}` };
});

/** A dependency that pushes at the capture only. */
const DepOnce = createLoader(async (ctx) => {
  if (source.generation === 1) ctx.use(Notes)("dep-once-note@g1");
  return { depOnce: `dep-once@g${source.generation}` };
});

/** An `ssr: false` loader with its own cache() that awaits DepOnce. */
const OwnedAwaitsDepOnce = createLoader(async (ctx) => {
  const { depOnce } = await ctx.use(DepOnce);
  ctx.use(Notes)(`owned-once-note@g${source.generation}`);
  return { ownedOnce: `owned-${depOnce}` };
});

/**
 * An `ssr: false` loader with its own cache() that pushes, awaits DepNoted
 * (which pushes), and pushes again.
 */
const OrderBake = createLoader(async (ctx) => {
  runs.order += 1;
  ctx.use(Notes)(`order-a@g${source.generation}`);
  const { dep } = await ctx.use(DepNoted);
  ctx.use(Notes)(`order-b@g${source.generation}`);
  return { order: `order-${dep}` };
});

/** A promise-carrying `ssr: false` loader that pushes after the capture only. */
const LateNoted = createLoader(async (ctx) => {
  if (source.generation > 1) {
    ctx.use(Notes)(`late-note@g${source.generation}`);
  }
  return {
    late: `late@g${source.generation}`,
    later: Promise.resolve("late-later"),
  };
});

/** A promise-free `ssr: false` loader a navigation never revalidates. */
const HeldNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`held-note@g${source.generation}`);
  return { held: `held@g${source.generation}` };
});

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

/** The pins are over the cap: the entry keeps its doc record only. */
const NO_PINS = { maxSnapshotBytes: 1 };

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, loader, loading, cache, intercept, revalidate }) => [
      path("/about", () => <p>about</p>, { name: "about" }),
      path(
        "/eb",
        () => <p>eb</p>,
        { name: "eb", ppr: true },
        () => [loader(EbBake, { ssr: false })],
      ),
      path(
        "/eb-capped",
        () => <p>eb capped</p>,
        { name: "ebCapped", ppr: NO_PINS },
        () => [loader(EbBake, { ssr: false })],
      ),
      path(
        "/dep-capped",
        () => <p>dep capped</p>,
        { name: "depCapped", ppr: NO_PINS },
        () => [loader(BakeAwaitsDep, { ssr: false })],
      ),
      path(
        "/two-bake",
        () => <p>two bake</p>,
        { name: "twoBake", ppr: true },
        () => [
          loader(HoleyAwaitsDep, { ssr: false }),
          loader(PlainBake, { ssr: false }),
        ],
      ),
      // The app-wide shape: the `ssr: false` loader sits on the layout, so
      // its pin is stored under the layout's shortCode.
      layout(
        () => <header>eb layout</header>,
        () => [
          loader(EbBake, { ssr: false }),
          path("/eb-layout", () => <p>eb layout page</p>, {
            name: "ebLayout",
            ppr: true,
          }),
        ],
      ),
      path(
        "/once-capped",
        () => <p>once capped</p>,
        { name: "onceCapped", ppr: NO_PINS },
        () => [loader(OnceNotedBakeLoader, { ssr: false })],
      ),
      path(
        "/late",
        () => <p>late</p>,
        { name: "late", ppr: true },
        () => [loader(LateNoted, { ssr: false })],
      ),
      path(
        "/held",
        () => <p>held</p>,
        { name: "held", ppr: true },
        () => [
          loader(HeldNoted, { ssr: false }, () => [revalidate(() => false)]),
        ],
      ),
      path(
        "/owned-capped",
        () => <p>owned capped</p>,
        { name: "ownedCapped", ppr: NO_PINS },
        () => [loader(OwnedBake, { ssr: false }, () => [cache({ ttl: 300 })])],
      ),
      path(
        "/owned-dep-capped",
        () => <p>owned dep capped</p>,
        { name: "ownedDepCapped", ppr: NO_PINS },
        () => [
          loader(OwnedAwaitsDep, { ssr: false }, () => [cache({ ttl: 300 })]),
        ],
      ),
      path(
        "/owned-dep-once-capped",
        () => <p>owned dep once capped</p>,
        { name: "ownedDepOnceCapped", ppr: NO_PINS },
        () => [
          loader(OwnedAwaitsDepOnce, { ssr: false }, () => [
            cache({ ttl: 300 }),
          ]),
        ],
      ),
      path(
        "/order-capped",
        () => <p>order capped</p>,
        { name: "orderCapped", ppr: NO_PINS },
        () => [loader(OrderBake, { ssr: false }, () => [cache({ ttl: 300 })])],
      ),
      path(
        "/outer-dep-capped",
        () => <p>outer dep capped</p>,
        { name: "outerDepCapped", ppr: NO_PINS },
        () => [loader(OuterDepLoader, { ssr: false })],
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
          loader(DeferredOwnedLoader, { ssr: false }, () => [
            cache({ ttl: 300 }),
          ]),
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

const setup = () => shellHarness(makeRouter());

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

/** The segment ids a response matched, as the client then holds them. */
function matchedSegments(result: ServeShellRequestResult): string[] {
  const row = result.flight?.split("\n").find((line) => line.startsWith("0:"));
  return (JSON.parse(row!.slice(2)).metadata as { matched: string[] }).matched;
}

beforeEach(async () => {
  source.generation = 1;
  deferredOwnedRuns.body = 0;
  runs.sch = 0;
  runs.owned = 0;
  runs.ownedDep = 0;
  runs.order = 0;
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
  it("a navigation replay keeps the captured push next to the pinned data", async () => {
    const { serve } = setup();
    expect((await serve("/eb")).shellStatus).toBe("MISS");
    source.generation = 3;

    const nav = await serve("/eb", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
  });

  // #1003, the prefetch that fills the client's prefetch cache.
  it("a prefetch replay keeps the captured push next to the pinned data", async () => {
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
  });

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

  it("an entry whose pins maxSnapshotBytes dropped: a document HIT and a navigation replay keep the fresh run's data and push", async () => {
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
    source.generation = 3;
    const nav = await serve("/eb-capped", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(distinct(hit.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g2"']);
    expect(final(hit.flight, /eb-after@g\d/g)).toEqual(["eb-after@g2"]);
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g3"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g3"]);
  });

  it("without pins a dependency's push follows the fresh run of the loader that awaits it", async () => {
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
  });

  it("a navigation whose explicit route cache() misses replays the shell record: the captured push stays next to the pinned data", async () => {
    const { serve, cacheStore } = setup();
    expect((await serve("/eb-cached")).shellStatus).toBe("MISS");
    await cacheStore.delete("doc:localhost/eb-cached");
    await cacheStore.delete("partial:localhost/eb-cached");
    source.generation = 3;

    const nav = await serve("/eb-cached", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
    expect(final(nav.flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
  });

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

  // The app-wide shape: the pin is stored under the layout's shortCode, and
  // both the value and the pushes find it by loader.
  it("an ssr: false loader on a layout: a HIT and a navigation replay keep the captured push next to the pinned data", async () => {
    const { serve } = setup();
    expect((await serve("/eb-layout")).shellStatus).toBe("MISS");
    source.generation = 3;

    const hit = await serve("/eb-layout");
    const nav = await serve("/eb-layout", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    for (const flight of [hit.flight, nav.flight]) {
      expect(distinct(flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
      expect(final(flight, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
    }
  });

  // The pin says the record lists every settled push of the capture's run.
  // It lists none here, so the replay's run adds none next to the pinned data.
  it("a pinned loader whose capture pushed nothing: a push its run makes on a replay does not show next to the pinned data", async () => {
    const { serve } = setup();
    expect((await serve("/late")).shellStatus).toBe("MISS");
    source.generation = 2;

    const hit = await serve("/late");
    const nav = await serve("/late", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect({
      hit: {
        data: distinct(hit.flight, /"late":"late@g\d"/g),
        push: final(hit.flight, /late-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /"late":"late@g\d"/g),
        push: final(nav.flight, /late-note@g\d/g),
      },
    }).toEqual({
      hit: { data: ['"late":"late@g1"'], push: [] },
      nav: { data: ['"late":"late@g1"'], push: [] },
    });
  });

  // A pin stored before captures recorded loader pushes (v0.17) carries no
  // `runs` bit and its record may hold none of them: the run supplies them.
  it("a pin without the runs bit keeps the push its run makes", async () => {
    const { serve } = setup();
    const miss = await serve("/late");
    expect(miss.shellStatus).toBe("MISS");
    const pin = (await miss.readEntry())?.snapshot?.find(
      (record) => record.family === "loader",
    );
    expect(pin?.value).toMatchObject({ holes: 1, runs: 0 });
    delete (pin!.value as { runs?: number }).runs;
    source.generation = 2;

    const hit = await serve("/late");

    expect(hit.shellStatus).toBe("HIT");
    expect(distinct(hit.flight, /"late":"late@g\d"/g)).toEqual([
      '"late":"late@g1"',
    ]);
    expect(final(hit.flight, /late-note@g\d/g)).toEqual(["late-note@g2"]);
  });

  // The navigation resolves no value for the loader: the client keeps the one
  // it has. The record's copy of its push stands, which matches that value
  // when it came from this shell (a HIT or a replay of it), as here. The
  // restore runs before the revalidation decision, and dropping the copy
  // would take the push off a page that still shows the loader's data.
  it("a pinned loader a navigation does not revalidate: no value is sent, and the captured push stands", async () => {
    const { serve } = setup();
    expect((await serve("/held")).shellStatus).toBe("MISS");
    const hit = await serve("/held");
    expect(hit.shellStatus).toBe("HIT");
    expect(distinct(hit.flight, /"held":"held@g\d"/g)).toEqual([
      '"held":"held@g1"',
    ]);
    source.generation = 2;

    const nav = await serve("/held", {
      partial: { from: "/held", segments: matchedSegments(hit) },
    });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"held":"held@g\d"/g)).toEqual([]);
    expect(final(nav.flight, /held-note@g\d/g)).toEqual(["held-note@g1"]);
  });
});

describe("one run per loader: without a pin the record's copy is a placeholder", () => {
  it("a run that makes no push leaves none: the captured push does not outlive its data", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();
    const miss = await serve("/once-capped");
    expect(miss.shellStatus).toBe("MISS");
    expect(final(miss.flight, /once-note@g\d/g)).toEqual(["once-note@g1"]);
    source.generation = 2;

    const hit = await serve("/once-capped");
    const nav = await serve("/once-capped", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect({
      hit: {
        data: distinct(hit.flight, /"once":"once@g\d"/g),
        push: final(hit.flight, /once-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /"once":"once@g\d"/g),
        push: final(nav.flight, /once-note@g\d/g),
      },
    }).toEqual({
      hit: { data: ['"once":"once@g2"'], push: [] },
      nav: { data: ['"once":"once@g2"'], push: [] },
    });
  });

  it("a loader's cache() entry takes the place of the record's copies, the dependency's included, each once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, withLoaderMiss } = setup();
    expect((await serve("/owned-dep-capped")).shellStatus).toBe("MISS");
    source.generation = 2;
    // The loader's entry refills at g2; the shell record keeps its g1 copies.
    await withLoaderMiss(() =>
      serve("/owned-dep-capped", { partial: { from: "/about" } }),
    );
    const filled = runs.ownedDep;
    source.generation = 3;

    const hit = await serve("/owned-dep-capped");
    const nav = await serve("/owned-dep-capped", {
      partial: { from: "/about" },
    });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    // The entry hit: no run.
    expect(runs.ownedDep).toBe(filled);
    for (const flight of [hit.flight, nav.flight]) {
      expect({
        data: distinct(flight, /"ownedDep":"owned-dep@g\d"/g),
        push: final(flight, /(?:owned-dep|dep)-note@g\d/g),
      }).toEqual({
        data: ['"ownedDep":"owned-dep@g2"'],
        push: ["dep-note@g2", "owned-dep-note@g2"],
      });
    }
  });

  // The order contract: the push order of the run that produced the value.
  // The loader's entry replays it (its HIT), and a run over the record's
  // placeholders keeps it (its MISS): the same shell gives one order.
  it("a loader that pushes around its dependency's push: its entry's HIT and its run give the push order", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, withLoaderMiss } = setup();
    expect((await serve("/order-capped")).shellStatus).toBe("MISS");
    const order = (flight: string | undefined) =>
      final(flight, /(?:order-[ab]|dep-note)@g\d/g);
    const pushOrder = (g: number) => [
      `order-a@g${g}`,
      `dep-note@g${g}`,
      `order-b@g${g}`,
    ];

    source.generation = 2;
    const ran = runs.order;
    const run = await withLoaderMiss(() => serve("/order-capped"));
    const runNav = await withLoaderMiss(() =>
      serve("/order-capped", { partial: { from: "/about" } }),
    );
    expect(runs.order).toBe(ran + 2);
    const entryHit = await serve("/order-capped");
    const entryNav = await serve("/order-capped", {
      partial: { from: "/about" },
    });
    expect(runs.order).toBe(ran + 2);

    for (const result of [run, entryHit]) {
      expect(result.shellStatus).toBe("HIT");
    }
    for (const flight of [run.flight, runNav.flight]) {
      expect(order(flight)).toEqual(pushOrder(2));
    }
    for (const flight of [entryHit.flight, entryNav.flight]) {
      expect(order(flight)).toEqual(pushOrder(2));
    }
  });

  // A claimed entry is the loader's source on this request, whatever it
  // holds: one written without handles (a MISS a reader started first, #1002,
  // or a handle encode that timed out) shows no push for the loader. Before,
  // the record's copy stayed. An entry that is whole belongs to change 2.
  it("a loader's cache() entry stored without its pushes shows none: the record's copy does not stand in", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve, cacheStore, withLoaderMiss } = setup();
    expect((await serve("/owned-capped")).shellStatus).toBe("MISS");
    source.generation = 2;
    const setItem = cacheStore.setItem.bind(cacheStore);
    const pushless = vi
      .spyOn(cacheStore, "setItem")
      .mockImplementation((key, value, options) =>
        setItem(
          key,
          value,
          key.startsWith("loader:")
            ? { ...options, handles: undefined }
            : options,
        ),
      );
    await withLoaderMiss(() =>
      serve("/owned-capped", { partial: { from: "/about" } }),
    );
    pushless.mockRestore();
    const filled = runs.owned;
    source.generation = 3;

    const hit = await serve("/owned-capped");
    const nav = await serve("/owned-capped", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(runs.owned).toBe(filled);
    for (const flight of [hit.flight, nav.flight]) {
      expect({
        data: distinct(flight, /"owned":"owned@g\d"/g),
        push: final(flight, /owned-note@g\d/g),
      }).toEqual({ data: ['"owned":"owned@g2"'], push: [] });
    }
  });

  for (const captured of [
    'hits its "use cache" entry',
    "runs the dependency",
  ]) {
    it(`a "use cache" entry's copy of a dependency's push shows once (the capture ${captured})`, async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve, withItemMiss } = setup();
      // A capture that misses the "use cache" entry runs the dependency in
      // its body, so the record keeps the push under the dependency; one
      // that hits records the replayed push under the bake-lane loader.
      const miss =
        captured === "runs the dependency"
          ? await withItemMiss("use-cache:", () => serve("/outer-dep-capped"))
          : await serve("/outer-dep-capped");
      expect(miss.shellStatus).toBe("MISS");
      source.generation = 2;

      const hit = await serve("/outer-dep-capped");
      const nav = await serve("/outer-dep-capped", {
        partial: { from: "/about" },
      });

      expect(hit.shellStatus).toBe("HIT");
      expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
      for (const flight of [hit.flight, nav.flight]) {
        // The loader ran and its "use cache" read hit the g1 entry: its
        // data and the push that entry recorded are g1, once.
        expect({
          data: distinct(flight, /"outer":"dep@g\d"/g),
          push: final(flight, /dep-note@g\d/g),
        }).toEqual({ data: ['"outer":"dep@g1"'], push: ["dep-note@g1"] });
      }
    });
  }
});

// PENDING, not regressions and not filed. The shell record names the loader
// that pushed a value, not the registered loader that ran it. So a
// dependency no route registers follows an approximation: its copies stand
// while every `ssr: false` loader is pinned, and are placeholders otherwise
// (loader-cache.ts loaderPins). Each `red` test is a case where that is not
// the loader's own source (docs/design/handle-push-ownership.md, "What is
// not built").
describe("PENDING (unfiled): a dependency the record does not attribute to the loader that ran it", () => {
  red(
    "a dependency of a pinned loader, while another ssr: false loader lost its pin: the captured push stays next to the pinned data",
    async () => {
      const { serve } = setup();
      const miss = await serve("/two-bake");
      expect(miss.shellStatus).toBe("MISS");
      // The entry loses the pin of the loader that does not await it.
      const snapshot = (await miss.readEntry())!.snapshot!;
      const plainPin = snapshot.findIndex(
        (record) =>
          record.family === "loader" &&
          (record.value as { holes: number }).holes === 0,
      );
      expect(plainPin).toBeGreaterThan(-1);
      snapshot.splice(plainPin, 1);
      source.generation = 2;

      const hit = await serve("/two-bake");

      expect(hit.shellStatus).toBe("HIT");
      expect({
        data: distinct(hit.flight, /holey-dep@g\d/g),
        push: final(hit.flight, /dep-note@g\d/g),
      }).toEqual({ data: ["holey-dep@g1"], push: ["dep-note@g1"] });
    },
  );

  red(
    "a dependency whose push the awaiting loader's cache() entry did not record: the record's copy does not outlive the entry's run",
    async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve, withLoaderMiss } = setup();
      expect((await serve("/owned-dep-once-capped")).shellStatus).toBe("MISS");
      source.generation = 2;
      // The entry refills at g2, from a run in which the dependency pushed
      // nothing.
      await withLoaderMiss(() =>
        serve("/owned-dep-once-capped", { partial: { from: "/about" } }),
      );
      source.generation = 3;

      const hit = await serve("/owned-dep-once-capped");

      expect(hit.shellStatus).toBe("HIT");
      expect({
        data: distinct(hit.flight, /"ownedOnce":"owned-dep-once@g\d"/g),
        push: final(hit.flight, /(?:owned-once|dep-once)-note@g\d/g),
      }).toEqual({
        data: ['"ownedOnce":"owned-dep-once@g2"'],
        push: ["owned-once-note@g2"],
      });
    },
  );
});

describe("one run per loader: a deferred push reaches every replay of its pin (#1001)", () => {
  for (const variant of ["misses", "is warm"] as const) {
    it(`a navigation replay delivers the deferred push of the loader's cache() entry (the entry ${variant} at capture)`, async () => {
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
      const captured = deferredOwnedRuns.body;

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
      expect(deferredOwnedRuns.body).toBe(captured);
      expect(notes(nav.flight)).toEqual(captureOnly);
    });
  }
});

describe("one run per loader: a route cache() record's copy of a loader push never outranks the loader's own source", () => {
  it("a document MISS that hits the route cache() record and the loader's cache() entry shows the entry's push next to its data", async () => {
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
  });
});

// PENDING, not regressions: issue #1002 is open. These state the target of
// change 2 in docs/design/handle-push-ownership.md (ctx.use(Loader) resolves
// through the route's cache() bindings); the groups above do not depend on
// it. Each `red` test fails today with the assertion the design doc records.
// Promote one to a plain `it` in the change that makes it pass. The two
// plain `it` controls here pass today and must keep passing.
describe("PENDING #1002 (change 2, the binding table): a reader gets the cache() binding's value", () => {
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
