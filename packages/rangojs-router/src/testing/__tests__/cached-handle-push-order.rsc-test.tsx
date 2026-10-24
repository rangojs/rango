/**
 * A cache() HIT shows a segment's handle values in the order its MISS shows
 * them, where the segment's handler and its loaders both push.
 *
 * The MISS starts an entry's loaders, then runs its handler: a loader that
 * pushes before its first await is ahead of the handler's push, one that
 * pushes later is behind it. A record holds the handler's pushes only (the
 * loaders run live on every request), and the HIT restored them before it
 * started any loader, so each live loader push came after them: an intercept's
 * crumbs, a route's or a layout's flipped between the MISS and every HIT.
 *
 * The HIT keeps the record's values behind the pushes the segment's loaders
 * make until its walk reaches the place where the MISS ran the handler
 * (HandleStore.holdRecordedValues).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { HandleData } from "../../server/handle-store.js";
import { deserializeResult } from "../../cache/segment-codec.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Declared by the item route and by its intercept. */
const SharedData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("shared-loader");
  return { shared: true };
});

/** The page route's own loader. */
const PageData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("page-loader");
  return { page: true };
});

/** The loader of a layout the aside route declares. */
const AsideData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("aside-loader");
  return { aside: true };
});

/** Pushes after an await: behind the handler's push on the MISS. */
const LateData = createLoader(async (ctx) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  ctx.use(Crumbs)("late-loader");
  return { late: true };
});

/** A slot's loader: it pushes into the slot's layout, after its handler. */
const SlotData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("slot-loader");
  return { slot: true };
});

const router = createRouter({}).routes(
  urls(({ path, cache, layout, intercept, loader, parallel }) => [
    cache({ ttl: 600 }, () => [
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
          path(
            "/item/:id",
            (ctx: HandlerContext<{ id: string }>) => {
              ctx.use(Crumbs)("item-page");
              return <article>item</article>;
            },
            { name: "item" },
            () => [loader(SharedData)],
          ),
          intercept(
            "@modal",
            ".item",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("modal");
              return <dialog>modal</dialog>;
            },
            () => [loader(SharedData)],
          ),
          path(
            "/page",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("page-handler");
              return <article>page</article>;
            },
            { name: "page" },
            () => [loader(PageData)],
          ),
          path(
            "/aside",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("aside-route");
              return <article>aside</article>;
            },
            { name: "aside" },
            () => [
              layout(
                (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("aside-layout");
                  return <aside>aside</aside>;
                },
                () => [loader(AsideData)],
              ),
            ],
          ),
          path(
            "/late",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("late-handler");
              return <article>late</article>;
            },
            { name: "late" },
            () => [loader(LateData)],
          ),
          layout(
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("slot-layout");
              return <section>slots</section>;
            },
            () => [
              parallel(
                {
                  "@side": (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("slot-handler");
                    return <nav>side</nav>;
                  },
                },
                () => [loader(SlotData)],
              ),
              path(
                "/slot",
                (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("slot-page");
                  return <article>slot</article>;
                },
                { name: "slot" },
              ),
            ],
          ),
        ],
      ),
    ]),
  ]),
);

/** Each segment's Crumbs values the response delivers, in push order. */
async function crumbsBySegment(
  result: ServeShellRequestResult,
): Promise<Record<string, unknown[]>> {
  const handles = await result.readHandles();
  const data = (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
  return data[Crumbs.$$id] ?? {};
}

/**
 * How the client asks: a document; a navigation from /list holding nothing,
 * whose MISS writes its own render; and one holding the layout, whose record
 * a background re-render writes with no loader run (proactive caching).
 */
type Shape = "document" | "navigation" | "navigation, layout held";

async function partialOf(
  shape: Shape,
): Promise<ServeShellRequestOptions["partial"]> {
  if (shape === "document") return undefined;
  if (shape === "navigation") return { from: "/list", segments: [] };
  const list = await serveShellRequest(router, "/list", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  const { matched } = (await deserializeResult<any>(list.flight!)).metadata;
  return { from: "/list", segments: matched };
}

/** The MISS that writes the record, then a HIT of it. */
async function missThenHit(
  url: string,
  shape: Shape,
): Promise<{
  miss: Record<string, unknown[]>;
  hit: Record<string, unknown[]>;
}> {
  const cacheStore = new MemorySegmentCacheStore();
  const partial = await partialOf(shape);
  const miss = await serveShellRequest(router, url, { cacheStore, partial });
  const hit = await serveShellRequest(router, url, { cacheStore, partial });
  return {
    miss: await crumbsBySegment(miss),
    hit: await crumbsBySegment(hit),
  };
}

/** The values of the one segment that holds `crumb`. */
function segmentWith(
  bySegment: Record<string, unknown[]>,
  crumb: string,
): unknown[] | undefined {
  return Object.values(bySegment).find((values) => values.includes(crumb));
}

const ALL_SHAPES: readonly Shape[] = [
  "document",
  "navigation",
  "navigation, layout held",
];

/** An intercept opens on a navigation only. */
const NAVIGATIONS: readonly Shape[] = ["navigation", "navigation, layout held"];

interface Case {
  name: string;
  url: string;
  shapes: readonly Shape[];
  /** A crumb of the segment the case is about, and its values on the MISS. */
  crumb: string;
  order: string[];
}

const CASES: readonly Case[] = [
  {
    name: "an intercept's slot: a loader the route and the intercept declare, and the intercept's handler",
    url: "/item/1",
    shapes: NAVIGATIONS,
    crumb: "modal",
    order: ["shared-loader", "modal"],
  },
  {
    name: "a route: its handler and its own loader",
    url: "/page",
    shapes: ALL_SHAPES,
    crumb: "page-handler",
    order: ["page-loader", "page-handler"],
  },
  {
    name: "a layout the route declares: its handler and its own loader",
    url: "/aside",
    shapes: ALL_SHAPES,
    crumb: "aside-layout",
    order: ["aside-loader", "aside-layout"],
  },
  {
    name: "a route whose loader pushes after an await",
    url: "/late",
    shapes: ALL_SHAPES,
    crumb: "late-handler",
    order: ["late-handler", "late-loader"],
  },
  {
    name: "a layout with no loader of its own, and its slot's loader",
    url: "/slot",
    shapes: ALL_SHAPES,
    crumb: "slot-layout",
    order: ["slot-layout", "slot-loader"],
  },
];

describe("cache() HIT: a segment's handle values in the MISS's order", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  for (const c of CASES) {
    describe(c.name, () => {
      for (const shape of c.shapes) {
        it(shape, async () => {
          const { miss, hit } = await missThenHit(c.url, shape);
          expect(segmentWith(miss, c.crumb)).toEqual(c.order);
          // A HIT also delivers the record's values for a segment the client
          // holds; every segment the MISS delivers, it delivers the same.
          for (const [segmentId, values] of Object.entries(miss)) {
            expect(hit[segmentId], segmentId).toEqual(values);
          }
        });
      }
    });
  }
});
