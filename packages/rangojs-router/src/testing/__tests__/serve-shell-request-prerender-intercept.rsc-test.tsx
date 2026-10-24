/**
 * An intercept open over a `Prerender()` route, served from the build's
 * intercept variant (`/i`), next to the same intercept over a live route.
 *
 * A render under an intercept skips the intercepted route's entry
 * (segment-resolution/revalidation.ts resolveAllSegments): the route's
 * handler, its own layouts and slots, and their handle pushes. The variant
 * used to store the main variant's whole page next to the intercept's slot,
 * so every HIT sent the route's page and its pushes, and with nothing held
 * its `matched` listed them, which showed the route's crumbs over the
 * source page.
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
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Intercept handler runs: every live render, the bake only over a Prerender(). */
const modalRuns = { count: 0 };

/** The intercepted route's page, baked by a Prerender() or rendered live. */
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

/** The route an intercept opens over /list: a Prerender() or a live one. */
type Target = "prerender" | "live";

function makeRouter(target: Target) {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, parallel }) => {
      /** The route's own layout and slot. */
      const itemUse = () => [
        layout((ctx: HandlerContext) => {
          ctx.use(Crumbs)("item-layout");
          return <section>item layout body</section>;
        }),
        parallel({
          "@aside": (ctx: HandlerContext) => {
            ctx.use(Crumbs)("item-aside");
            return <aside>item aside body</aside>;
          },
        }),
      ];
      return [
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
              ? path("/item/:id", PrerenderedItem, { name: "item" }, itemUse)
              : path("/item/:id", liveItem, { name: "item" }, itemUse),
            intercept("@modal", ".item", (ctx: HandlerContext) => {
              modalRuns.count += 1;
              ctx.use(Crumbs)("modal");
              return <dialog>modal body</dialog>;
            }),
          ],
        ),
      ];
    }),
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

type HandleData = Record<string, Record<string, unknown[]>>;

interface Answer {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  const { segments, matched, diff } = (
    await deserializeResult<{ metadata: Answer }>(result.flight!)
  ).metadata;
  return { segments, matched, diff };
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
  return Object.values(bySegment).flat();
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

/** How the client opens the intercept over /list. */
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
 * Open the intercept over /list. Over a Prerender() the second request is
 * the one compared: the first bakes the variant.
 */
async function open(
  target: Target,
  shape: Shape,
): Promise<{
  result: ServeShellRequestResult;
  modalRuns: number;
  before: HandleData;
}> {
  const router = makeRouter(target);
  const cacheStore = new MemorySegmentCacheStore();
  const { partial, before } = await visitOf(router, shape);
  const serve = () =>
    serveShellRequest(router, "/item/1", { cacheStore, partial });
  if (target === "prerender") await serve();
  modalRuns.count = 0;
  const result = await serve();
  return { result, modalRuns: modalRuns.count, before };
}

/** Segments of the intercepted route: its handler, its layout and its slot. */
function routeSegments(answer: Answer): string[] {
  return answer.segments
    .filter(
      (s) =>
        s.belongsToRoute === true && !s.namespace?.startsWith("intercept:"),
    )
    .map((s) => s.id);
}

const ROUTE_BODIES = ["item page body", "item layout body", "item aside body"];
const ROUTE_CRUMBS = ["item-page", "item-layout", "item-aside"];

describe("an intercept over a Prerender() route, served from the build's variant", () => {
  beforeEach(async () => {
    modalRuns.count = 0;
    await resetShellTestState();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const shape of SHAPES) {
    describe(shape, () => {
      it("serves the intercept from the bake", async () => {
        const { result, modalRuns: runs } = await open("prerender", shape);
        expect(runs).toBe(0);
        expect(result.flight).toContain("modal body");
      });

      it("sends none of the intercepted route's segments, as a live render does", async () => {
        const hit = await open("prerender", shape);
        const live = await open("live", shape);
        expect(routeSegments(await answerOf(live.result))).toEqual([]);
        expect(routeSegments(await answerOf(hit.result))).toEqual([]);
        for (const body of ROUTE_BODIES) {
          expect(live.result.flight).not.toContain(body);
          expect(hit.result.flight).not.toContain(body);
        }
      });

      it("sends no crumb of the intercepted route, as a live render does", async () => {
        const hit = await open("prerender", shape);
        const live = await open("live", shape);
        for (const crumb of ROUTE_CRUMBS) {
          expect(await sentCrumbs(live.result)).not.toContain(crumb);
          expect(await sentCrumbs(hit.result)).not.toContain(crumb);
        }
      });

      it("matches and shows what a live intercept render does", async () => {
        const hit = await open("prerender", shape);
        const live = await open("live", shape);
        expect((await answerOf(hit.result)).matched).toEqual(
          (await answerOf(live.result)).matched,
        );
        const shown = await shownCrumbs(live.result, live.before);
        expect(shown).toEqual(
          shape === "nothing held"
            ? ["layout", "modal"]
            : ["layout", "list", "modal"],
        );
        expect(await shownCrumbs(hit.result, hit.before)).toEqual(shown);
      });
    });
  }
});
