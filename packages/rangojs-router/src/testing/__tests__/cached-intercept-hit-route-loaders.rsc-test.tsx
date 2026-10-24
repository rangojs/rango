/**
 * An intercept open over a route under cache(), and a HIT of its record:
 * the loaders the HIT runs live are the intercept's, as on the MISS. The
 * same holds for the intercept variant a Prerender() route bakes.
 *
 * The MISS's walk skips the intercepted route's entry
 * (segment-resolution/revalidation.ts), so the route's loaders never run on
 * it. The HIT's loaders-only walk (match-middleware/cache-lookup.ts
 * serveStoredSegments) used to walk the route's entry too:
 *   - a route loader nothing reads ran on every HIT, its segment in `matched`
 *     or `diff`;
 *   - a loader both the route and the intercept declare ran once, under the
 *     route's owner, so its pushes were filed under a segment the response
 *     never matched, and the HIT lost its crumb.
 *
 * The walk skips the route's entry itself, under the match's
 * interceptResult, after latching a ppr route's header guard from the whole
 * chain, as the MISS's walk does.
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

import { collectHandle } from "../collect-handle.js";
import {
  resetShellTestState,
  serveShellRequest,
  type ServeShellRequestOptions,
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  getRequestContext,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const runs = { shared: 0, routeOnly: 0, routeSlot: 0, modal: 0 };

/** Declared by the route and by its intercept. */
const SharedData = createLoader(async (ctx) => {
  runs.shared += 1;
  ctx.use(Crumbs)("shared-loader");
  return { shared: true };
});

/** Declared by the route only, and read by nothing. */
const RouteOnlyData = createLoader(async (ctx) => {
  runs.routeOnly += 1;
  ctx.use(Crumbs)("route-only-loader");
  return { routeOnly: true };
});

/** Declared by a parallel slot of the route. */
const RouteSlotData = createLoader(async (ctx) => {
  runs.routeSlot += 1;
  ctx.use(Crumbs)("route-slot-loader");
  return { routeSlot: true };
});

const modal = (ctx: HandlerContext): React.ReactNode => {
  runs.modal += 1;
  ctx.use(Crumbs)("modal");
  return <dialog>modal</dialog>;
};

const itemPage = (ctx: HandlerContext<{ id: string }>): React.ReactNode => {
  ctx.use(Crumbs)("item-page");
  return <article>item page</article>;
};

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  (ctx) => {
    ctx.use(Crumbs)("item-page");
    return <article>item page</article>;
  },
);

/**
 * Where the intercept's record comes from: a cache() around the layout, or
 * the build's intercept variant of a Prerender() route.
 */
type Target = "cache" | "prerender";

function makeRouter(target: Target) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept, loader, parallel }) => {
      const routeUse = () => [
        loader(SharedData),
        loader(RouteOnlyData),
        parallel({ "@aside": () => <aside>aside</aside> }, () => [
          loader(RouteSlotData),
        ]),
      ];
      const tree = () =>
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("layout");
            return <main>shell</main>;
          },
          () => [
            path(
              "/list",
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("list");
                return <ul>list</ul>;
              },
              { name: "list" },
            ),
            target === "prerender"
              ? path("/item/:id", PrerenderedItem, { name: "item" }, routeUse)
              : path("/item/:id", itemPage, { name: "item" }, routeUse),
            intercept("@modal", ".item", modal, () => [loader(SharedData)]),
          ],
        );
      return target === "cache"
        ? [cache({ ttl: 600 }, () => [tree()])]
        : [tree()];
    }),
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

type HandleData = Record<string, Record<string, unknown[]>>;

interface Answer {
  matched: string[];
  diff: string[];
}

async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const handles = await result.readHandles();
  return (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  const { matched, diff } = (await deserializeResult<any>(result.flight!))
    .metadata;
  return { matched, diff };
}

/**
 * The Crumbs value useHandle shows once the response lands on a client that
 * shows `before`: a segment the response carries replaces the client's.
 */
async function crumbs(
  result: ServeShellRequestResult,
  before: HandleData,
): Promise<string[]> {
  const after = await handlesOf(result);
  const bySegment: Record<string, string[]> = {
    ...(before[Crumbs.$$id] as Record<string, string[]>),
    ...(after[Crumbs.$$id] as Record<string, string[]>),
  };
  const { matched } = await answerOf(result);
  return collectHandle(
    Crumbs,
    matched.map((id) => bySegment[id] ?? []),
  );
}

/**
 * How the client opens the intercept over /list. Holding nothing, the MISS
 * writes its own render; holding the layout, a re-render writes it
 * (proactive caching).
 */
type Shape = "nothing held" | "layout held";

const SHAPES: readonly Shape[] = ["nothing held", "layout held"];

async function visitOf(
  router: Router,
  shape: Shape,
): Promise<{
  partial: ServeShellRequestOptions["partial"];
  before: HandleData;
}> {
  if (shape === "nothing held") {
    return { partial: { from: "/list", segments: [] }, before: {} };
  }
  const list = await serveShellRequest(router, "/list", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  return {
    partial: { from: "/list", segments: (await answerOf(list)).matched },
    before: await handlesOf(list),
  };
}

/**
 * Two requests that open the intercept: under cache(), the MISS that writes
 * its record and a HIT of it; over a Prerender(), two HITs of the bake.
 */
async function openTwice(
  target: Target,
  shape: Shape,
): Promise<{
  first: ServeShellRequestResult;
  second: ServeShellRequestResult;
  runs: { first: typeof runs; second: typeof runs };
  before: HandleData;
}> {
  const router = makeRouter(target);
  const cacheStore = new MemorySegmentCacheStore();
  const { partial, before } = await visitOf(router, shape);
  const open = async () => {
    runs.shared = 0;
    runs.routeOnly = 0;
    runs.routeSlot = 0;
    runs.modal = 0;
    const result = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial,
    });
    return { result, runs: { ...runs } };
  };
  const first = await open();
  const second = await open();
  return {
    first: first.result,
    second: second.result,
    runs: { first: first.runs, second: second.runs },
    before,
  };
}

/** The route's own loader segments, its slot's included. */
function routeLoaderIds(ids: string[]): string[] {
  return ids.filter(
    (id) =>
      !id.includes(".@modal") &&
      (id.endsWith(`.${SharedData.$$id}`) ||
        id.endsWith(`.${RouteOnlyData.$$id}`) ||
        id.endsWith(`.${RouteSlotData.$$id}`)),
  );
}

/** The crumbs the MISS shows, sorted. */
function expectedCrumbs(shape: Shape): string[] {
  return shape === "nothing held"
    ? ["layout", "modal", "shared-loader"]
    : ["layout", "list", "modal", "shared-loader"];
}

describe("cache() route with an intercept open: a HIT runs the intercept's loaders, not the route's", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    describe(shape, () => {
      it("serves the HIT from the record the MISS wrote", async () => {
        const { runs: counted } = await openTwice("cache", shape);
        expect(counted.first.modal).toBeGreaterThan(0);
        expect(counted.second.modal).toBe(0);
      });

      it("shows the MISS's crumbs on the HIT, the shared loader's included", async () => {
        const { first, second, before } = await openTwice("cache", shape);
        // Sorted: inside the slot, a HIT files its live loader's push after
        // the record's handler push, and the MISS before it.
        expect((await crumbs(first, before)).sort()).toEqual(
          expectedCrumbs(shape),
        );
        expect((await crumbs(second, before)).sort()).toEqual(
          expectedCrumbs(shape),
        );
      });

      it("runs no route loader on the HIT, and the shared loader once, as on the MISS", async () => {
        const { runs: counted } = await openTwice("cache", shape);
        expect(counted.first.routeOnly).toBe(0);
        expect(counted.second.routeOnly).toBe(0);
        expect(counted.first.routeSlot).toBe(0);
        expect(counted.second.routeSlot).toBe(0);
        expect(counted.first.shared).toBe(1);
        expect(counted.second.shared).toBe(1);
      });

      it("lists no route loader segment in the HIT's matched or diff", async () => {
        const { first, second } = await openTwice("cache", shape);
        const miss = await answerOf(first);
        const hit = await answerOf(second);
        expect(routeLoaderIds(miss.matched)).toEqual([]);
        expect(routeLoaderIds(hit.matched)).toEqual([]);
        expect(routeLoaderIds(hit.diff)).toEqual([]);
        expect(hit.matched).toEqual(miss.matched);
      });
    });
  }
});

describe("Prerender() route with an intercept open: the stored intercept runs the intercept's loaders, not the route's", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    describe(shape, () => {
      it("serves the intercept from the bake", async () => {
        const { runs: counted } = await openTwice("prerender", shape);
        expect(counted.second.modal).toBe(0);
      });

      it("shows the shared loader's crumb once, and no route loader's", async () => {
        const { second, before } = await openTwice("prerender", shape);
        const shown = await crumbs(second, before);
        expect(shown.filter((c) => c === "shared-loader")).toEqual([
          "shared-loader",
        ]);
        expect(shown).not.toContain("route-only-loader");
        expect(shown).not.toContain("route-slot-loader");
      });

      it("runs no route loader, and the shared loader once", async () => {
        const { runs: counted } = await openTwice("prerender", shape);
        expect(counted.second.routeOnly).toBe(0);
        expect(counted.second.routeSlot).toBe(0);
        expect(counted.second.shared).toBe(1);
      });

      it("lists no route loader segment in matched or diff", async () => {
        const { second } = await openTwice("prerender", shape);
        const answer = await answerOf(second);
        expect(routeLoaderIds(answer.matched)).toEqual([]);
        expect(routeLoaderIds(answer.diff)).toEqual([]);
      });
    });
  }
});

/** Every onError report of the header-guard router, as `phase`. */
const guardReports: string[] = [];

/** Declared by a layout under the cache() boundary; writes a response header. */
const HeaderWriter = createLoader(async () => {
  getRequestContext()!.header("x-layout-loader", "1");
  return { written: true };
});

/** A ppr route under cache(), its layout's loader writing a header. */
const pprRouter = createRouter({
  onError: ({ phase }) => {
    guardReports.push(phase);
  },
}).routes(
  urls(({ path, cache, layout, intercept, loader }) => [
    layout(
      () => <main>shell</main>,
      () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        cache({ ttl: 600 }, () => [
          layout(
            () => <section>section</section>,
            () => [
              loader(HeaderWriter),
              path("/item/:id", () => <article>item page</article>, {
                name: "item",
                ppr: true,
              }),
              intercept("@modal", ".item", () => <dialog>modal</dialog>),
            ],
          ),
        ]),
      ],
    ),
  ]),
);

describe("ppr route under cache() with an intercept open: a HIT keeps the MISS's header guard", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The loaders-only walk latches the ppr header guard from its entries'
  // leaf, the route; skipping the route must not drop that latch.
  it("refuses a layout loader's header write on the HIT, as on the MISS", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cacheStore = new MemorySegmentCacheStore();
    const answers: { reports: string[]; header: string | null }[] = [];
    for (let i = 0; i < 2; i++) {
      guardReports.length = 0;
      const result = await serveShellRequest(pprRouter, "/item/1", {
        cacheStore,
        partial: { from: "/list", segments: [] },
      });
      answers.push({
        reports: [...guardReports],
        header: result.response.headers.get("x-layout-loader"),
      });
    }
    expect(answers[0]).toEqual({ reports: ["loader"], header: null });
    expect(answers[1]).toEqual(answers[0]);
  });
});
