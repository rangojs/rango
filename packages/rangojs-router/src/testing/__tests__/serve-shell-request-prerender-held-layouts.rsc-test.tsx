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
 * crumbs from the bake, under an intercept and without one.
 *
 * Handle values are compared with the live render only: a cache() HIT
 * replays its record's handle values, a held segment's included.
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

interface Shape {
  /** An intercept of the detail route, declared beside it. */
  intercept: boolean;
  /** The layout's revalidate() asks for a re-render on every navigation. */
  layoutRevalidates: boolean;
}

function makeRouter(target: Target, shape: Shape) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept, revalidate }) => {
      const tree = () =>
        layout(
          (ctx: HandlerContext) => {
            layoutRuns.count += 1;
            ctx.use(Crumbs)("layout");
            return <main>layout body</main>;
          },
          () => [
            ...(shape.layoutRevalidates ? [revalidate(() => true)] : []),
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
  layoutRevalidates = false,
): Promise<{
  result: ServeShellRequestResult;
  layoutRuns: number;
  layoutId: string;
  before: HandleData;
}> {
  const router: Router = makeRouter(target, {
    intercept: navigation.intercept,
    layoutRevalidates,
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
  const partial = { from: navigation.from, segments: sourceAnswer.matched };
  const serve = () =>
    serveShellRequest(router, navigation.to, { cacheStore, partial });
  if (target !== "live") await serve();
  layoutRuns.count = 0;
  const result = await serve();
  return {
    result,
    layoutRuns: layoutRuns.count,
    layoutId,
    before: await handlesOf(source),
  };
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

        if (target !== "cache") {
          it(`${target}: re-sends no handle value of the held layout`, async () => {
            const { result, layoutId } = await navigate(target, navigation);
            expect(await sentCrumbs(result)).not.toHaveProperty(layoutId);
          });
        }

        it(`${target}: shows the layout's crumb once, with the page's`, async () => {
          const { result, before } = await navigate(target, navigation);
          expect(await shownCrumbs(result, before)).toEqual(navigation.shown);
        });
      }

      it("the bake's response holds what the live render's does", async () => {
        const hit = await navigate("prerender", navigation);
        const live = await navigate("live", navigation);
        const hitAnswer = await answerOf(hit.result);
        const liveAnswer = await answerOf(live.result);
        expect(hitAnswer.matched).toEqual(liveAnswer.matched);
        const sent = (answer: Answer) =>
          answer.segments
            .filter((s) => s.type !== "loader" && s.component !== null)
            .map((s) => s.id);
        expect(sent(hitAnswer)).toEqual(sent(liveAnswer));
        expect(Object.keys(await sentCrumbs(hit.result)).sort()).toEqual(
          Object.keys(await sentCrumbs(live.result)).sort(),
        );
      });
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
          const { result, layoutId } = await navigate(target, navigation, true);
          expect(await sentLayout(result, layoutId)).not.toBeNull();
          expect(result.flight).toContain("layout body");
          expect((await sentCrumbs(result))[layoutId]).toEqual(["layout"]);
        });
      }
    });
  }
});
