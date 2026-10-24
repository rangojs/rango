/**
 * Several intercepts target one `Prerender()` route. A live navigation
 * renders the one the match selects (findInterceptForRoute: the innermost
 * whose `when()` passes, from the route's parent up). The build cannot
 * evaluate `when()`, so it bakes every intercept that can target the route
 * into the intercept variant (`/i`); a HIT must still serve only the
 * selected one, and leave the others out of the payload, `matched` and the
 * handle data, as the live render does.
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
  createRouter,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import type { InterceptSelectorContext } from "../../server/context.js";
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Intercept handler runs by name: every live render, the bake once. */
const runs: Record<string, number> = {};

function interceptHandler(name: string) {
  return (ctx: HandlerContext) => {
    runs[name] = (runs[name] ?? 0) + 1;
    ctx.use(Crumbs)(name);
    return <dialog>{`${name} body`}</dialog>;
  };
}

function itemPage(push: (crumb: string) => void): React.ReactNode {
  push("item-page");
  return <article>item page body</article>;
}

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  (ctx) => itemPage(ctx.use(Crumbs)),
);

const liveItem = (ctx: HandlerContext<{ id: string }>): React.ReactNode =>
  itemPage(ctx.use(Crumbs));

const from =
  (pathname: string) =>
  (ctx: InterceptSelectorContext): boolean =>
    ctx.from.url.pathname === pathname;

/**
 * - `levels`: `@outer` on the root layout, `@modal` on the layout that holds
 *   the route; the inner one is selected.
 * - `when`: `@modal` from /list and `@drawer` from /other, on one layout.
 * - `same slot`: two `@modal` intercepts on one layout, from /list and from
 *   /other; they share the slot's segment id.
 * - `route's own layout`: `@own` declared in the route's own layout, which
 *   the runtime never selects, next to `@modal` on the root layout.
 */
type Shape = "levels" | "when" | "same slot" | "route's own layout";

/** The route an intercept opens over: a Prerender() or a live one. */
type Target = "prerender" | "live";

function makeRouter(shape: Shape, target: Target) {
  const item = target === "prerender" ? PrerenderedItem : liveItem;
  return createRouter({}).routes(
    urls(({ path, layout, intercept }) => {
      const source = (pathname: string, name: string) =>
        path(
          pathname,
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)(name);
            return <ul>{`${name} body`}</ul>;
          },
          { name },
        );
      const root = (ctx: HandlerContext) => {
        ctx.use(Crumbs)("layout");
        return <main>shell</main>;
      };
      switch (shape) {
        case "levels":
          return [
            layout(root, () => [
              source("/list", "list"),
              source("/other", "other"),
              intercept("@outer", ".item", interceptHandler("outer")),
              layout(
                (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("inner-layout");
                  return <section>inner</section>;
                },
                () => [
                  path("/item/:id", item, { name: "item" }),
                  intercept("@modal", ".item", interceptHandler("modal")),
                ],
              ),
            ]),
          ];
        case "when":
          return [
            layout(root, () => [
              source("/list", "list"),
              source("/other", "other"),
              path("/item/:id", item, { name: "item" }),
              intercept("@modal", ".item", interceptHandler("modal"), {
                when: from("/list"),
              }),
              intercept("@drawer", ".item", interceptHandler("drawer"), {
                when: from("/other"),
              }),
            ]),
          ];
        case "same slot":
          return [
            layout(root, () => [
              source("/list", "list"),
              source("/other", "other"),
              path("/item/:id", item, { name: "item" }),
              intercept("@modal", ".item", interceptHandler("modal"), {
                when: from("/list"),
              }),
              intercept("@modal", ".item", interceptHandler("sheet"), {
                when: from("/other"),
              }),
            ]),
          ];
        case "route's own layout":
          return [
            layout(root, () => [
              source("/list", "list"),
              source("/other", "other"),
              path("/item/:id", item, { name: "item" }, () => [
                layout(
                  () => <section>own layout</section>,
                  () => [intercept("@own", ".item", interceptHandler("own"))],
                ),
              ]),
              intercept("@modal", ".item", interceptHandler("modal")),
            ]),
          ];
      }
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

/** Every Crumbs value the response carries, whatever segment it is filed under. */
async function sentCrumbs(result: ServeShellRequestResult): Promise<string[]> {
  const bySegment = ((await handlesOf(result))[Crumbs.$$id] ?? {}) as Record<
    string,
    string[]
  >;
  return Object.values(bySegment).flat().sort();
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
    ...((await handlesOf(result))[Crumbs.$$id] as Record<string, string[]>),
  };
  const { matched } = await answerOf(result);
  return collectHandle(
    Crumbs,
    matched.map((id) => bySegment[id] ?? []),
  );
}

/** The intercept slots the response carries: `<segment id> <slot>`. */
function slotsOf(answer: Answer): string[] {
  return answer.segments
    .filter((s) => s.namespace?.startsWith("intercept:") && s.slot)
    .map((s) => `${s.id} ${s.slot}`);
}

/** How the client opens the intercept: nothing held, or the source page's segments held. */
type Held = "nothing held" | "layout held";

async function visitOf(
  router: Router,
  source: string,
  held: Held,
): Promise<{
  partial: ServeShellRequestOptions["partial"];
  before: HandleData;
}> {
  if (held === "nothing held") {
    return { partial: { from: source, segments: [] }, before: {} };
  }
  const page = await serveShellRequest(router, source, {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  return {
    partial: { from: source, segments: (await answerOf(page)).matched },
    before: await handlesOf(page),
  };
}

interface Opened {
  result: ServeShellRequestResult;
  answer: Answer;
  before: HandleData;
  /** Handler runs of the compared request. */
  runs: Record<string, number>;
  /** Handler runs of the bake and the compared request together. */
  allRuns: Record<string, number>;
}

/**
 * Open the intercept from `source`. Over a Prerender() the first request
 * bakes the variant and the second is the one compared.
 */
async function open(
  shape: Shape,
  target: Target,
  source: string,
  held: Held,
): Promise<Opened> {
  const router = makeRouter(shape, target);
  const cacheStore = new MemorySegmentCacheStore();
  const { partial, before } = await visitOf(router, source, held);
  for (const name of Object.keys(runs)) delete runs[name];
  const serve = () =>
    serveShellRequest(router, "/item/1", { cacheStore, partial });
  if (target === "prerender") await serve();
  const bake = { ...runs };
  for (const name of Object.keys(runs)) delete runs[name];
  const result = await serve();
  const allRuns = { ...bake };
  for (const [name, count] of Object.entries(runs)) {
    allRuns[name] = (allRuns[name] ?? 0) + count;
  }
  return {
    result,
    answer: await answerOf(result),
    before,
    runs: { ...runs },
    allRuns,
  };
}

/** Each shape, the source it opens from, and the intercept the match selects. */
const CASES: ReadonlyArray<{
  shape: Shape;
  source: string;
  selected: string;
  others: string[];
}> = [
  { shape: "levels", source: "/list", selected: "modal", others: ["outer"] },
  { shape: "when", source: "/list", selected: "modal", others: ["drawer"] },
  { shape: "when", source: "/other", selected: "drawer", others: ["modal"] },
  { shape: "same slot", source: "/list", selected: "modal", others: ["sheet"] },
  {
    shape: "same slot",
    source: "/other",
    selected: "sheet",
    others: ["modal"],
  },
  {
    shape: "route's own layout",
    source: "/list",
    selected: "modal",
    others: ["own"],
  },
];

const HELD: readonly Held[] = ["nothing held", "layout held"];

describe("several intercepts over a Prerender() route: the HIT serves the one the match selects", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const { shape, source, selected, others } of CASES) {
    for (const held of HELD) {
      describe(`${shape}, from ${source}, ${held}`, () => {
        it("carries the same intercept slots and matched ids as a live render", async () => {
          const hit = await open(shape, "prerender", source, held);
          const live = await open(shape, "live", source, held);
          expect(slotsOf(live.answer)).toHaveLength(1);
          expect(slotsOf(hit.answer)).toEqual(slotsOf(live.answer));
          expect(hit.answer.matched).toEqual(live.answer.matched);
          expect(live.result.flight).toContain(`${selected} body`);
          expect(hit.result.flight).toContain(`${selected} body`);
          for (const other of others) {
            expect(live.result.flight).not.toContain(`${other} body`);
            expect(hit.result.flight).not.toContain(`${other} body`);
          }
        });

        it("sends and shows the crumbs a live render does", async () => {
          const hit = await open(shape, "prerender", source, held);
          const live = await open(shape, "live", source, held);
          for (const other of others) {
            expect(await sentCrumbs(live.result)).not.toContain(other);
            expect(await sentCrumbs(hit.result)).not.toContain(other);
          }
          const shown = await shownCrumbs(live.result, live.before);
          expect(shown).toContain(selected);
          expect(await shownCrumbs(hit.result, hit.before)).toEqual(shown);
        });
      });
    }
  }

  it("serves the selected intercept from the bake when it alone fills its slot", async () => {
    for (const { shape, source, selected } of CASES) {
      if (shape === "same slot") continue;
      const hit = await open(shape, "prerender", source, "nothing held");
      expect(hit.runs[selected] ?? 0, `${shape} from ${source}`).toBe(0);
    }
  });

  it("does not bake an intercept the runtime never selects", async () => {
    const hit = await open(
      "route's own layout",
      "prerender",
      "/list",
      "nothing held",
    );
    expect(hit.allRuns.own ?? 0).toBe(0);
  });

  it("renders live two intercepts that share a slot, which the variant cannot tell apart", async () => {
    for (const source of ["/list", "/other"]) {
      const hit = await open("same slot", "prerender", source, "nothing held");
      const selected = source === "/list" ? "modal" : "sheet";
      expect(hit.runs[selected], source).toBe(1);
    }
  });
});
