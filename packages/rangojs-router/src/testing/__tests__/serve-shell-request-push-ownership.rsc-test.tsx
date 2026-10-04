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
 * failed with before the fix. The PENDING #1036 group is open: its `red`
 * tests are vitest's `it.fails`, which keeps the suite green while a test
 * fails and turns it red the moment the test passes. The #1002 group pins
 * behavior that is by design.
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
  type ShellRequestHandles,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { navigationShellKey } from "../../rsc/shell-capture-constants.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import {
  DeferredOwnedLoader,
  deferredOwnedRuns,
  OnceNotedBakeLoader,
  OuterDepLoader,
  shellHarness,
  shownHandles,
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

/**
 * A promise-free `ssr: false` loader without cache(): its body runs at
 * capture, and again on a HIT for the deferred push (#1035).
 */
const PlainDeferred = createLoader(async (ctx) => {
  ctx.use(Notes)(`plain-settled@g${source.generation}`);
  ctx.use(Notes)(Promise.resolve(`plain-deferred@g${source.generation}`));
  return { plain: `plain@g${source.generation}` };
});

/** A promise-free `ssr: false` loader that pushes a value holding a promise. */
const NestedNoted = createLoader(async (ctx) => {
  ctx.use(Notes)({
    label: `nested@g${source.generation}`,
    later: Promise.resolve("nested-later"),
  } as unknown as string);
  return { nested: `nested@g${source.generation}` };
});

/** A live-lane loader (no `ssr: false`) that pushes before its first await. */
const LiveNoted = createLoader(async (ctx) => {
  ctx.use(Notes)(`live-note@g${source.generation}`);
  return { live: `live@g${source.generation}` };
});

/** A live-lane loader that pushes after an await. */
const SlowLiveNoted = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  ctx.use(Notes)(`slow-live-note@g${source.generation}`);
  return { slow: `slow@g${source.generation}` };
});

function NotedPage(ctx: HandlerContext): React.ReactNode {
  ctx.use(Notes)("handler-note");
  return <p>noted</p>;
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
        "/deferred-plain",
        () => <p>deferred plain</p>,
        { name: "deferredPlain", ppr: true },
        () => [loader(PlainDeferred, { ssr: false })],
      ),
      path(
        "/nested-noted",
        () => <p>nested noted</p>,
        { name: "nestedNoted", ppr: true },
        () => [loader(NestedNoted, { ssr: false })],
      ),
      path("/live-noted", NotedPage, { name: "liveNoted", ppr: true }, () => [
        loader(LiveNoted),
        loader(SlowLiveNoted),
        loading(<p>loading live</p>),
      ]),
      path("/plain-noted", NotedPage, { name: "plainNoted" }, () => [
        loader(LiveNoted),
        loader(PlainDeferred, { ssr: false }),
      ]),
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
 * The values of `pattern` in the handle state a response leaves the client
 * with: the last state that arrived after hydration, else the state the
 * document hydrated with (a navigation: the last state it streamed). A
 * document HIT carries both (#1035), so its Flight text holds a push twice.
 */
async function final(
  result: ServeShellRequestResult,
  pattern: RegExp,
): Promise<string[]> {
  return (await shownHandles(result)).match(pattern) ?? [];
}

/**
 * The handle data a HIT's shell was rendered from: the capture's payload
 * (`prelude`, Flight text under serveShellRequest) decoded as the SSR render
 * read it. Its `handles` channel only: the capture froze the stream, so the
 * late channel may never close.
 */
async function shellHandles(
  result: ServeShellRequestResult,
): Promise<ShellRequestHandles["hydration"] | undefined> {
  if (result.prelude === undefined) return undefined;
  const { metadata } = await deserializeResult<{
    metadata?: { handles?: AsyncIterable<ShellRequestHandles["hydration"]> };
  }>(result.prelude);
  let handles: ShellRequestHandles["hydration"] = {};
  for await (const data of metadata?.handles ?? []) handles = data;
  return handles;
}

/**
 * A document's handle values, in push order, as the browser gets them: what
 * its shell was rendered from (a HIT), what the client hydrates with, and
 * the state the late channel leaves it in after hydration (undefined when
 * nothing arrived late). A value that holds a promise reads as its `label`.
 */
async function handleValues(result: ServeShellRequestResult): Promise<{
  shell: unknown[] | undefined;
  hydration: unknown[];
  afterHydration: unknown[] | undefined;
}> {
  const handles = (await result.readHandles())!;
  const values = (data: ShellRequestHandles["hydration"] | undefined) =>
    data &&
    Object.values(data)
      .flatMap((bySegment) => Object.values(bySegment).flat())
      .map(
        (value) => (value as { label?: unknown } | undefined)?.label ?? value,
      );
  return {
    shell: values(await shellHandles(result)),
    hydration: values(handles.hydration)!,
    afterHydration: values(handles.late.at(-1)),
  };
}

/** What the client received of {@link handleValues}, without the shell. */
function delivered(values: Awaited<ReturnType<typeof handleValues>>): {
  hydration: unknown[];
  afterHydration: unknown[] | undefined;
} {
  return {
    hydration: values.hydration,
    afterHydration: values.afterHydration,
  };
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
    expect(await final(hit, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
  });

  // #1003
  it("a navigation replay keeps the captured push next to the pinned data", async () => {
    const { serve } = setup();
    expect((await serve("/eb")).shellStatus).toBe("MISS");
    source.generation = 3;

    const nav = await serve("/eb", { partial: { from: "/about" } });

    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g1"']);
    expect(await final(nav, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
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
    expect(await final(prefetch, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
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
    expect(await final(nav, /eb-after@g\d/g)).toEqual(["eb-after@g2"]);
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
    expect(await final(hit, /eb-after@g\d/g)).toEqual(["eb-after@g2"]);
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(distinct(nav.flight, /"eb":"eb@g\d"/g)).toEqual(['"eb":"eb@g3"']);
    expect(await final(nav, /eb-after@g\d/g)).toEqual(["eb-after@g3"]);
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
        push: await final(hit, /dep-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /baked-dep@g\d/g),
        push: await final(nav, /dep-note@g\d/g),
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
    expect(await final(nav, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
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
    expect(await final(nav, /eb-after@g\d/g)).toEqual(["eb-after@g3"]);
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
    for (const result of [hit, nav]) {
      expect(distinct(result.flight, /"eb":"eb@g\d"/g)).toEqual([
        '"eb":"eb@g1"',
      ]);
      expect(await final(result, /eb-after@g\d/g)).toEqual(["eb-after@g1"]);
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
        push: await final(hit, /late-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /"late":"late@g\d"/g),
        push: await final(nav, /late-note@g\d/g),
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
    expect(await final(hit, /late-note@g\d/g)).toEqual(["late-note@g2"]);
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
    expect(await final(nav, /held-note@g\d/g)).toEqual(["held-note@g1"]);
  });
});

describe("one run per loader: without a pin the record's copy is a placeholder", () => {
  it("a run that makes no push leaves none: the captured push does not outlive its data", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();
    const miss = await serve("/once-capped");
    expect(miss.shellStatus).toBe("MISS");
    expect(await final(miss, /once-note@g\d/g)).toEqual(["once-note@g1"]);
    source.generation = 2;

    const hit = await serve("/once-capped");
    const nav = await serve("/once-capped", { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect({
      hit: {
        data: distinct(hit.flight, /"once":"once@g\d"/g),
        push: await final(hit, /once-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /"once":"once@g\d"/g),
        push: await final(nav, /once-note@g\d/g),
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
    for (const result of [hit, nav]) {
      expect({
        data: distinct(result.flight, /"ownedDep":"owned-dep@g\d"/g),
        push: await final(result, /(?:owned-dep|dep)-note@g\d/g),
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
    const order = (result: ServeShellRequestResult) =>
      final(result, /(?:order-[ab]|dep-note)@g\d/g);
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
    for (const result of [run, runNav]) {
      expect(await order(result)).toEqual(pushOrder(2));
    }
    for (const result of [entryHit, entryNav]) {
      expect(await order(result)).toEqual(pushOrder(2));
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
    for (const result of [hit, nav]) {
      expect({
        data: distinct(result.flight, /"owned":"owned@g\d"/g),
        push: await final(result, /owned-note@g\d/g),
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
      for (const result of [hit, nav]) {
        // The loader ran and its "use cache" read hit the g1 entry: its
        // data and the push that entry recorded are g1, once.
        expect({
          data: distinct(result.flight, /"outer":"dep@g\d"/g),
          push: await final(result, /dep-note@g\d/g),
        }).toEqual({ data: ['"outer":"dep@g1"'], push: ["dep-note@g1"] });
      }
    });
  }
});

// PENDING, not regressions; filed as #1036 (open). The shell record names the loader
// that pushed a value, not the registered loader that ran it. So a
// dependency no route registers follows an approximation: its copies stand
// while every `ssr: false` loader is pinned, and are placeholders otherwise
// (loader-cache.ts loaderPins). Each `red` test is a case where that is not
// the loader's own source (docs/design/handle-push-ownership.md, "What is
// not built").
describe("PENDING #1036: a dependency the record does not attribute to the loader that ran it", () => {
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
        push: await final(hit, /dep-note@g\d/g),
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
        push: await final(hit, /(?:owned-once|dep-once)-note@g\d/g),
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
      const notes = async (result: ServeShellRequestResult) => ({
        settled: distinct(result.flight, /settled-note-\d+/g),
        deferred: distinct(result.flight, /deferred-note-\d+/g),
        settledInFinalState: (await final(result, /settled-note-\d+/g)).length,
      });
      const captureOnly = {
        settled: [`settled-note-${captured}`],
        deferred: [`deferred-note-${captured}`],
        settledInFinalState: 1,
      };
      expect(hit.shellStatus).toBe("HIT");
      expect(await notes(hit)).toEqual(captureOnly);
      expect(nav.replayStatus).toEqual({
        outcome: "HIT",
        freshness: "fresh",
      });
      expect(deferredOwnedRuns.body).toBe(captured);
      expect(await notes(nav)).toEqual(captureOnly);
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
    expect(await final(miss, /owned-note@g\d/g)).toEqual(["owned-note@g2"]);
  });
});

// Issue #1035. A document served from a shell hydrates with the handle data
// the shell's HTML was rendered from, which is the record's. Whatever this
// request's loaders push, replace or drop reaches the client after
// hydration, on the late channel. Before, a HIT's hydration data was the
// store at the handler barrier plus whatever a loader had pushed by the
// stream's first read, and the capture rendered pushes its record left out.
describe("a shell HIT hydrates from its record (#1035)", () => {
  /** Capture `path` at generation 1, then serve its HIT at generation 2. */
  async function hitAfterCapture(path: string) {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { serve } = setup();
    expect((await serve(path)).shellStatus).toBe("MISS");
    source.generation = 2;
    const hit = await serve(path);
    expect(hit.shellStatus).toBe("HIT");
    return { serve, hit, values: await handleValues(hit) };
  }

  describe("the capture renders the shell from the handle data its record keeps", () => {
    for (const variant of ["misses", "is warm"] as const) {
      it(`a deferred push is not in the shell (the loader's cache() entry ${variant} at capture)`, async () => {
        const { serve, withLoaderMiss } = setup();
        const miss =
          variant === "misses"
            ? await withLoaderMiss(() => serve("/deferred-owned"))
            : await serve("/deferred-owned");
        expect(miss.shellStatus).toBe("MISS");
        const captured = deferredOwnedRuns.body;

        const { shell } = await handleValues(await serve("/deferred-owned"));

        expect(shell).toEqual([`settled-note-${captured}`]);
      });
    }

    it("a deferred push by a loader that runs at capture is not in the shell", async () => {
      const { values } = await hitAfterCapture("/deferred-plain");

      expect(values.shell).toEqual(["plain-settled@g1"]);
    });

    it("a push that holds a promise is not in the shell", async () => {
      const { values } = await hitAfterCapture("/nested-noted");

      expect(values.shell).toEqual([]);
    });
  });

  describe("the HIT hydrates with the record's data and delivers the rest after hydration", () => {
    for (const variant of ["misses", "is warm"] as const) {
      it(`a deferred push arrives after hydration (the loader's cache() entry ${variant} at capture)`, async () => {
        const { serve, withLoaderMiss } = setup();
        if (variant === "misses") {
          await withLoaderMiss(() => serve("/deferred-owned"));
        } else {
          await serve("/deferred-owned");
        }
        const captured = deferredOwnedRuns.body;

        const hit = await serve("/deferred-owned");

        expect(hit.shellStatus).toBe("HIT");
        expect(delivered(await handleValues(hit))).toEqual({
          hydration: [`settled-note-${captured}`],
          afterHydration: [
            `settled-note-${captured}`,
            `deferred-note-${captured}`,
          ],
        });
        // The loader's cache() entry delivered it: no body ran on the HIT.
        expect(deferredOwnedRuns.body).toBe(captured);
      });
    }

    it("a deferred push by a loader without cache() arrives after hydration, from the HIT's run", async () => {
      const { values } = await hitAfterCapture("/deferred-plain");

      expect(delivered(values)).toEqual({
        hydration: ["plain-settled@g1"],
        afterHydration: ["plain-settled@g1", "plain-deferred@g2"],
      });
    });

    it("a push that holds a promise arrives after hydration", async () => {
      const { values } = await hitAfterCapture("/nested-noted");

      expect(delivered(values)).toEqual({
        hydration: [],
        afterHydration: ["nested@g2"],
      });
    });

    it("an entry without loader pins hydrates with the capture's push, and the run's push takes its place after hydration", async () => {
      const { values } = await hitAfterCapture("/eb-capped");

      expect(delivered(values)).toEqual({
        hydration: ["eb-after@g1"],
        afterHydration: ["eb-after@g2"],
      });
    });

    it("an entry without loader pins whose run makes no push hydrates with the capture's push and drops it after hydration", async () => {
      const { values } = await hitAfterCapture("/once-capped");

      expect(delivered(values)).toEqual({
        hydration: ["once-note@g1"],
        afterHydration: [],
      });
    });

    it("a live-lane loader's push arrives after hydration, whether it was made before or after an await", async () => {
      const { values } = await hitAfterCapture("/live-noted");

      expect(delivered(values)).toEqual({
        hydration: ["handler-note"],
        afterHydration: ["handler-note", "live-note@g2", "slow-live-note@g2"],
      });
    });

    for (const path of [
      "/deferred-owned",
      "/deferred-plain",
      "/nested-noted",
      "/eb",
      "/eb-capped",
      "/once-capped",
      "/live-noted",
    ]) {
      it(`${path}: the client hydrates with exactly what the shell was rendered from`, async () => {
        const { values } = await hitAfterCapture(path);

        expect(values.hydration).toEqual(values.shell);
      });
    }
  });

  describe("what does not change", () => {
    it("a HIT whose loader pushes settled values only delivers nothing after hydration", async () => {
      const { values } = await hitAfterCapture("/eb");

      expect(values).toEqual({
        shell: ["eb-after@g1"],
        hydration: ["eb-after@g1"],
        afterHydration: undefined,
      });
    });

    it("a document MISS carries every push in its hydration data, a deferred one resolved", async () => {
      const { serve } = setup();

      const deferred = await serve("/deferred-plain");
      const live = await serve("/live-noted");

      expect(deferred.shellStatus).toBe("MISS");
      expect(await handleValues(deferred)).toEqual({
        shell: undefined,
        hydration: ["plain-settled@g1", "plain-deferred@g1"],
        afterHydration: undefined,
      });
      // A live-lane push made after an await is late on a MISS too.
      expect(await handleValues(live)).toEqual({
        shell: undefined,
        hydration: ["live-note@g1", "handler-note"],
        afterHydration: ["live-note@g1", "handler-note", "slow-live-note@g1"],
      });
    });

    it("a navigation replay streams one handle state: nothing is late without a hydration", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { serve } = setup();
      for (const path of ["/deferred-plain", "/eb-capped", "/live-noted"]) {
        expect((await serve(path)).shellStatus).toBe("MISS");
      }
      source.generation = 2;
      const nav = (path: string) =>
        serve(path, { partial: { from: "/about" } }).then(handleValues);

      expect(await nav("/deferred-plain")).toEqual({
        shell: undefined,
        hydration: ["plain-settled@g1", "plain-deferred@g2"],
        afterHydration: undefined,
      });
      expect(await nav("/eb-capped")).toEqual({
        shell: undefined,
        hydration: ["eb-after@g2"],
        afterHydration: undefined,
      });
      expect(await nav("/live-noted")).toEqual({
        shell: undefined,
        hydration: ["handler-note", "live-note@g2", "slow-live-note@g2"],
        afterHydration: undefined,
      });
    });

    it("a document without ppr carries every push in its hydration data", async () => {
      const { serve } = setup();
      await serve("/plain-noted");
      source.generation = 2;

      const second = await serve("/plain-noted");

      expect(second.shellStatus).toBe(null);
      expect(await handleValues(second)).toEqual({
        shell: undefined,
        hydration: [
          "live-note@g2",
          "plain-settled@g2",
          "plain-deferred@g2",
          "handler-note",
        ],
        afterHydration: undefined,
      });
    });
  });
});

// By design (issue #1002, closed): a loader that reads another loader with
// ctx.use() may run it live. When that read starts a cache()-bound loader
// before the binding has started, the binding still serves its entry, so the
// loader's data comes from the entry and its handle push from the live run. A
// handler's ctx.use() is where a loader read is baked. The way around the mix
// is to declare the cached loader first or read it from the handler. The
// control tests show the arrangements that stay together.
describe("#1002 by design: a loader read that starts a cache()-bound loader first runs it live", () => {
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

  /** The cached loader as the request shows it; bodyRuns counts the second request. */
  async function seen(result: ServeShellRequestResult, reader: RegExp) {
    return {
      bodyRuns: runs.sch - 1,
      data: distinct(result.flight, /"sch":"sch@g\d"/g),
      push: await final(result, /sch-note@g\d/g),
      reader: distinct(result.flight, reader),
    };
  }

  /** The g1 entry hit: the body did not run again, every reader saw g1. */
  async function expectEntryOnly(
    result: ServeShellRequestResult,
    reader: RegExp,
  ): Promise<void> {
    expect(await seen(result, reader)).toEqual({
      bodyRuns: 0,
      data: ['"sch":"sch@g1"'],
      push: ["sch-note@g1"],
      reader: [reader.source.replace("\\d", "1")],
    });
  }

  /** The reader started the loader live (body ran once, push @g2); the binding served the g1 entry for the data. */
  async function expectLiveRunBesideEntry(
    result: ServeShellRequestResult,
    reader: RegExp,
  ): Promise<void> {
    expect(await seen(result, reader)).toEqual({
      bodyRuns: 1,
      data: ['"sch":"sch@g1"'],
      push: ["sch-note@g2"],
      reader: [reader.source.replace("\\d", "2")],
    });
  }

  it("the entry a reader-started run writes holds no handle pushes: the body ran once, the data is the entry's, the push comes from the live run only", async () => {
    const { serve, cacheStore } = setup();
    const setItem = vi.spyOn(cacheStore, "setItem");

    await serve("/sch-plain");

    const write = setItem.mock.calls.find(
      ([key]) => key.startsWith("loader:") && key.endsWith("/sch-plain"),
    );
    expect(runs.sch).toBe(1);
    expect(write).toBeDefined();
    expect(write?.[2]?.handles).toBeUndefined();
  });

  it("a sibling loader declared before the binding (a route without ppr): the body runs live, the data is the entry's g1, the push is the live run's g2", async () => {
    const { second } = await twice("/sch-plain");
    await expectLiveRunBesideEntry(second, /reader-sch@g\d/g);
  });

  it("a handler on the binding's own route (control: the binding starts first, no body run, the entry serves data and push)", async () => {
    const { second } = await twice("/sch-handler");
    await expectEntryOnly(second, /page-sch@g\d/g);
  });

  it("a parent layout's loader reading a child route's cached loader: the body runs live, the data is the entry's g1, the push is the live run's g2", async () => {
    const { second } = await twice("/sch-layout-loader");
    await expectLiveRunBesideEntry(second, /reader-sch@g\d/g);
  });

  it("a parent layout's handler reading a child route's cached loader: the body runs live, the data is the entry's g1, the push is the live run's g2", async () => {
    const { second } = await twice("/sch-layout-handler");
    await expectLiveRunBesideEntry(second, /layout-sch@g\d/g);
  });

  it("a sibling loader declared before the binding on an intercept: the body runs live, the data is the entry's g1, the push is the live run's g2", async () => {
    const { second } = await twice("/sch-item", {
      partial: { from: "/sch-list" },
    });
    await expectLiveRunBesideEntry(second, /reader-sch@g\d/g);
  });

  /** A HIT and a navigation replay at g3 over a hole whose entry refilled at g2. */
  async function pprHitAndReplay(path: string) {
    const { serve, withLoaderMiss } = setup();
    expect((await serve(path)).shellStatus).toBe("MISS");
    source.generation = 2;
    // The hole's entry refills at g2.
    expect((await withLoaderMiss(() => serve(path))).shellStatus).toBe("HIT");
    const filled = runs.sch;
    source.generation = 3;

    const hit = await serve(path);
    const nav = await serve(path, { partial: { from: "/about" } });

    expect(hit.shellStatus).toBe("HIT");
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    return {
      bodyRuns: runs.sch - filled,
      hit: {
        data: distinct(hit.flight, /"sch":"sch@g\d"/g),
        push: await final(hit, /sch-note@g\d/g),
      },
      nav: {
        data: distinct(nav.flight, /"sch":"sch@g\d"/g),
        push: await final(nav, /sch-note@g\d/g),
      },
    };
  }

  it("a ppr route: an ssr: false reader declared before the cached hole runs it live on a HIT and a replay (2 body runs): the data is the entry's g2, the push is the live run's g3", async () => {
    expect(await pprHitAndReplay("/sch")).toEqual({
      bodyRuns: 2,
      hit: { data: ['"sch":"sch@g2"'], push: ["sch-note@g3"] },
      nav: { data: ['"sch":"sch@g2"'], push: ["sch-note@g3"] },
    });
  });

  it("a ppr route: an ssr: false reader declared after the cached hole (control: the binding starts first, no body run, the entry's g2 serves data and push)", async () => {
    expect(await pprHitAndReplay("/sch-rev")).toEqual({
      bodyRuns: 0,
      hit: { data: ['"sch":"sch@g2"'], push: ["sch-note@g2"] },
      nav: { data: ['"sch":"sch@g2"'], push: ["sch-note@g2"] },
    });
  });
});
