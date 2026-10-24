/**
 * A navigation that changes the route params with the layout held, served
 * from a `Prerender()` bake, next to the same navigation rendered live and
 * served from a cache() HIT.
 *
 * Layouts stay held on navigation, even when the params change: a live walk
 * skips a held layout above the route unless its revalidate() asks for it
 * (router/revalidation.ts "nav:non-route-skip"), and a cache() HIT decides
 * the same for its segments (match-middleware/cache-lookup.ts
 * cachedSegmentSends). A bake HIT sent every held segment when the params
 * changed (storedEntrySends), and replayed the handle values of every stored
 * segment, so a list -> detail navigation re-sent the held layout and its
 * crumbs from the bake, under an intercept and without one. A cache() HIT
 * kept the layout but replayed its record's handle values, the held
 * layout's included (rango-t195).
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createRouter,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Layout handler runs: a live render's, and the bake's over a Prerender(). */
const layoutRuns = { count: 0 };

function itemPage(push: (crumb: string) => void, id: string): React.ReactNode {
  push(`item-${id}`);
  return <article>item {id} body</article>;
}

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }, { id: "2" }],
  (ctx) => itemPage(ctx.use(Crumbs), ctx.params.id),
);

const liveItem = (ctx: HandlerContext<{ id: string }>): React.ReactNode =>
  itemPage(ctx.use(Crumbs), ctx.params.id);

/** Where the detail page comes from. */
type Target = "live" | "cache" | "prerender";

const TARGETS: readonly Target[] = ["live", "cache", "prerender"];

/** The targets whose second request is a HIT. */
const HIT_TARGETS: readonly Target[] = ["cache", "prerender"];

interface Shape {
  /** An intercept of the detail route, declared beside it. */
  intercept: boolean;
  /** The layout's revalidate() asks for a re-render on every navigation. */
  layoutRevalidates?: boolean;
  /** The layout's own parallel on the intercept's slot (@modal). */
  slotDefault?: boolean;
  /** The client holds none of the source page's segments. */
  holdNothing?: boolean;
}

function makeRouter(target: Target, shape: Shape) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept, parallel, revalidate }) => {
      const tree = () =>
        layout(
          (ctx: HandlerContext) => {
            layoutRuns.count += 1;
            ctx.use(Crumbs)("layout");
            return <main>layout body</main>;
          },
          () => [
            ...(shape.layoutRevalidates ? [revalidate(() => true)] : []),
            ...(shape.slotDefault
              ? [
                  parallel({
                    "@modal": (ctx: HandlerContext) => {
                      ctx.use(Crumbs)("modal-default");
                      return <aside>modal default body</aside>;
                    },
                  }),
                ]
              : []),
            path(
              "/list",
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("list");
                return <ul>list body</ul>;
              },
              { name: "list" },
            ),
            target === "prerender"
              ? path("/item/:id", PrerenderedItem, { name: "item" })
              : path("/item/:id", liveItem, { name: "item" }),
            ...(shape.intercept
              ? [
                  intercept("@modal", ".item", (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("modal");
                    return <dialog>modal body</dialog>;
                  }),
                ]
              : []),
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
  segments: ResolvedSegment[];
  matched: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  const { segments, matched } = (
    await deserializeResult<{ metadata: Answer }>(result.flight!)
  ).metadata;
  return { segments, matched };
}

async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const handles = await result.readHandles();
  return (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
}

/** The Crumbs values the response carries, by segment id. */
async function sentCrumbs(
  result: ServeShellRequestResult,
): Promise<Record<string, string[]>> {
  return ((await handlesOf(result))[Crumbs.$$id] ?? {}) as Record<
    string,
    string[]
  >;
}

/**
 * The Crumbs value useHandle shows once the response lands on a client that
 * shows `before`: a segment the response carries replaces the client's.
 */
async function shownCrumbs(
  result: ServeShellRequestResult,
  before: HandleData,
): Promise<string[]> {
  const bySegment: Record<string, string[]> = {
    ...(before[Crumbs.$$id] as Record<string, string[]>),
    ...(await sentCrumbs(result)),
  };
  const { matched } = await answerOf(result);
  return collectHandle(
    Crumbs,
    matched.map((id) => bySegment[id] ?? []),
  );
}

/** The client-held navigation from `from` to `to`. */
interface Navigation {
  name: string;
  from: string;
  to: string;
  intercept: boolean;
  /** What the client shows once the navigation lands. */
  shown: string[];
}

const NAVIGATIONS: readonly Navigation[] = [
  {
    name: "list -> detail under the intercept",
    from: "/list",
    to: "/item/1",
    intercept: true,
    shown: ["layout", "list", "modal"],
  },
  {
    name: "list -> detail",
    from: "/list",
    to: "/item/1",
    intercept: false,
    shown: ["layout", "item-1"],
  },
  {
    name: "detail -> detail",
    from: "/item/1",
    to: "/item/2",
    intercept: false,
    shown: ["layout", "item-2"],
  },
];

/**
 * Navigate with the layout held. The source page is a live render, as the
 * client got it, except for detail -> detail over a Prerender(): its source
 * is the bake. Under cache() and over a Prerender() the second request is the
 * one compared: the first writes the record or bakes the artifact.
 */
async function navigate(
  target: Target,
  navigation: Navigation,
  options: Omit<Shape, "intercept"> = {},
): Promise<{
  result: ServeShellRequestResult;
  /** What a live render of the same tree sends. */
  live: () => Promise<ServeShellRequestResult>;
  layoutRuns: number;
  layoutId: string;
  before: HandleData;
}> {
  const router: Router = makeRouter(target, {
    ...options,
    intercept: navigation.intercept,
  });
  const source = await serveShellRequest(router, navigation.from, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  const sourceAnswer = await answerOf(source);
  // The layout the crumb "layout" is filed under, not the router's root.
  const [layoutId] = Object.entries(await sentCrumbs(source)).find(
    ([, crumbs]) => crumbs.includes("layout"),
  )!;
  const cacheStore = new MemorySegmentCacheStore();
  const partial = {
    from: navigation.from,
    segments: options.holdNothing ? [] : sourceAnswer.matched,
  };
  const serve = () =>
    serveShellRequest(router, navigation.to, { cacheStore, partial });
  const first = target !== "live" ? await serve() : undefined;
  layoutRuns.count = 0;
  const result = await serve();
  return {
    result,
    // The MISS that wrote the record renders the cache() tree live; a bake's
    // first request is served from the bake.
    live: async () =>
      target === "cache"
        ? first!
        : (await navigate("live", navigation, options)).result,
    layoutRuns: layoutRuns.count,
    layoutId,
    before: await handlesOf(source),
  };
}

/**
 * The HIT matches what the live render matches, sends the segments it sends
 * and the handle buckets it sends.
 */
async function expectSameResponse(
  hit: ServeShellRequestResult,
  live: ServeShellRequestResult,
): Promise<void> {
  const hitAnswer = await answerOf(hit);
  const liveAnswer = await answerOf(live);
  expect(hitAnswer.matched).toEqual(liveAnswer.matched);
  const sent = (answer: Answer) =>
    answer.segments
      .filter((s) => s.type !== "loader" && s.component !== null)
      .map((s) => `${s.namespace}:${s.id}`);
  expect(sent(hitAnswer)).toEqual(sent(liveAnswer));
  expect(Object.keys(await sentCrumbs(hit)).sort()).toEqual(
    Object.keys(await sentCrumbs(live)).sort(),
  );
}

/** The layout segment the response carries, null when it is kept. */
async function sentLayout(
  result: ServeShellRequestResult,
  layoutId: string,
): Promise<ResolvedSegment["component"] | undefined> {
  const { segments } = await answerOf(result);
  return segments.find((s) => s.id === layoutId)?.component ?? null;
}

describe("a navigation that changes the params keeps the held layout, from a Prerender() bake as live", () => {
  beforeEach(async () => {
    layoutRuns.count = 0;
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const navigation of NAVIGATIONS) {
    describe(navigation.name, () => {
      for (const target of TARGETS) {
        it(`${target}: sends no held layout and runs none`, async () => {
          const {
            result,
            layoutRuns: runs,
            layoutId,
          } = await navigate(target, navigation);
          expect(runs).toBe(0);
          expect(await sentLayout(result, layoutId)).toBeNull();
          expect(result.flight).not.toContain("layout body");
        });

        it(`${target}: re-sends no handle value of the held layout`, async () => {
          const { result, layoutId } = await navigate(target, navigation);
          expect(await sentCrumbs(result)).not.toHaveProperty(layoutId);
        });

        it(`${target}: shows the layout's crumb once, with the page's`, async () => {
          const { result, before } = await navigate(target, navigation);
          expect(await shownCrumbs(result, before)).toEqual(navigation.shown);
        });
      }

      for (const target of HIT_TARGETS) {
        it(`${target}: the HIT's response holds what the live render's does`, async () => {
          const hit = await navigate(target, navigation);
          await expectSameResponse(hit.result, await hit.live());
        });
      }
    });
  }
});

/**
 * The client holds none of the page's segments: a HIT sends each one with
 * its handle values, as a live render does.
 */
describe("a navigation that holds nothing gets every segment's handle values, from a HIT as live", () => {
  beforeEach(async () => {
    layoutRuns.count = 0;
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const navigation of NAVIGATIONS) {
    describe(navigation.name, () => {
      for (const target of TARGETS) {
        it(`${target}: sends the layout and its crumb`, async () => {
          const { result, layoutId } = await navigate(target, navigation, {
            holdNothing: true,
          });
          expect(await sentLayout(result, layoutId)).not.toBeNull();
          expect((await sentCrumbs(result))[layoutId]).toEqual(["layout"]);
        });
      }

      for (const target of HIT_TARGETS) {
        it(`${target}: the HIT's response holds what the live render's does`, async () => {
          const hit = await navigate(target, navigation, { holdNothing: true });
          await expectSameResponse(hit.result, await hit.live());
        });
      }
    });
  }
});

describe("a held layout whose revalidate() asks for it is sent, from a Prerender() bake as live", () => {
  beforeEach(async () => {
    layoutRuns.count = 0;
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const navigation of NAVIGATIONS) {
    describe(navigation.name, () => {
      for (const target of TARGETS) {
        it(`${target}: sends the layout and its crumb`, async () => {
          const { result, layoutId } = await navigate(target, navigation, {
            layoutRevalidates: true,
          });
          expect(await sentLayout(result, layoutId)).not.toBeNull();
          expect(result.flight).toContain("layout body");
          expect((await sentCrumbs(result))[layoutId]).toEqual(["layout"]);
        });
      }

      for (const target of HIT_TARGETS) {
        it(`${target}: the HIT's response holds what the live render's does`, async () => {
          const hit = await navigate(target, navigation, {
            layoutRevalidates: true,
          });
          await expectSameResponse(hit.result, await hit.live());
        });
      }
    });
  }
});

/**
 * The layout's own parallel on the intercept's slot: the stored intercept
 * variant holds the parallel and the intercept's slot under one id
 * (`${layout}.@modal`). The held parallel stays held, and the intercept's
 * slot is sent, as a live render sends it. Handle values are compared by
 * bucket only: the variant's shared bucket holds the parallel's pushes, not
 * the intercept's (prerender-match.ts variantHandlesRecord), on base too.
 */
describe("an intercept that shares its slot with the layout's parallel is sent from a HIT as live", () => {
  const navigation = NAVIGATIONS[0]!;
  beforeEach(async () => {
    layoutRuns.count = 0;
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The intercept's slot segment the response sends. */
  async function sentIntercept(
    result: ServeShellRequestResult,
  ): Promise<ResolvedSegment | undefined> {
    const { segments } = await answerOf(result);
    return segments.find(
      (s) => s.namespace?.startsWith("intercept:") && s.component !== null,
    );
  }

  for (const target of TARGETS) {
    it(`${target}: sends the intercept's slot`, async () => {
      const { result } = await navigate(target, navigation, {
        slotDefault: true,
      });
      expect(await sentIntercept(result)).toBeDefined();
      expect(result.flight).toContain("modal body");
      expect(result.flight).not.toContain("modal default body");
    });
  }

  for (const target of HIT_TARGETS) {
    it(`${target}: the HIT's response holds what the live render's does`, async () => {
      const hit = await navigate(target, navigation, { slotDefault: true });
      await expectSameResponse(hit.result, await hit.live());
    });
  }
});
