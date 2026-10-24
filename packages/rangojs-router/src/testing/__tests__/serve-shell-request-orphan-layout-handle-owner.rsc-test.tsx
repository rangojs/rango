/**
 * Which segment owns a handle push made by an orphan layout's handler (a
 * layout with no routes: a sibling of its layout's routes, or one a path()
 * declares), through serveShellRequest's document and partial navigation.
 *
 * resolveOrphanLayout (router/segment-resolution/revalidation.ts) runs the
 * orphan's handler, so it pins `_currentSegmentId` to the orphan's id first,
 * as resolveEntryHandler does for a chain entry and the parallel and
 * intercept funnels do for their slots. Without the pin a handler's
 * `ctx.use(Handle)` read whatever segment was pinned last:
 *   - a parent the request ran (a document, a navigation that re-ran the
 *     layout, a route's handler): the push landed in the PARENT's bucket, and
 *     a cache() record kept it there;
 *   - nothing (the client holds the layout and the orphan's revalidate()
 *     re-renders it): the push threw "used outside of handler context".
 *
 * The pin lasts only while the orphan's handler runs. A route under
 * loading() streams its handler: resolveSegment runs the route's orphan
 * layouts before the handler finishes, so a pin left on the orphan filed
 * every push the handler made after an await under the orphan, ahead of the
 * route's earlier pushes (a Meta title reverted to the first one).
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
  createRouter,
  Meta,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { withoutPushedBy } from "../../handles/pushed-by.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

const errors: string[] = [];
/** The orphan handler's runs: a cache() HIT runs none. */
let orphanRuns = 0;

function makeRouter(cached: boolean) {
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, cache, revalidate }) => {
      const tree = () => [
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("layout");
            return <main>shell</main>;
          },
          () => [
            layout(
              (ctx: HandlerContext) => {
                orphanRuns++;
                ctx.use(Crumbs)("orphan");
                return <aside>orphan</aside>;
              },
              () => [revalidate(() => true)],
            ),
            path("/a", () => <p>a</p>, { name: "a" }),
            path("/b", () => <p>b</p>, { name: "b" }),
            path(
              "/c",
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("page");
                return <p>c</p>;
              },
              { name: "c" },
              () => [
                layout((ctx: HandlerContext) => {
                  ctx.use(Crumbs)("page-orphan");
                  return <nav>page orphan</nav>;
                }),
              ],
            ),
          ],
        ),
      ];
      return cached ? [cache({ ttl: 600 }, tree)] : tree();
    }),
  );
}

/** The pushes a response delivers, by the segment id that owns them. */
async function bucketsOf(
  result: ServeShellRequestResult,
): Promise<Record<string, string[]>> {
  const handles = await result.readHandles();
  const data = withoutPushedBy(
    (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData,
  );
  return { ...(data[Crumbs.$$id] as Record<string, string[]> | undefined) };
}

async function matchedOf(flight: string | undefined): Promise<string[]> {
  const { metadata } = await deserializeResult<{
    metadata: { matched: string[] };
  }>(flight!);
  return metadata.matched;
}

/**
 * How the client asks: a document; a navigation from /a holding nothing; one
 * holding /a's segments (the layout and the orphan), whose orphan the
 * revalidate() re-renders.
 */
type Shape = "document" | "navigation" | "navigation, layout held";

async function partialOf(
  router: ReturnType<typeof makeRouter>,
  shape: Shape,
): Promise<ServeShellRequestOptions["partial"]> {
  if (shape === "document") return undefined;
  if (shape === "navigation") return { from: "/a", segments: [] };
  const a = await serveShellRequest(router, "/a", {
    cacheStore: new MemorySegmentCacheStore(),
    partial: true,
  });
  return { from: "/a", segments: await matchedOf(a.flight) };
}

const SHAPES: readonly Shape[] = [
  "document",
  "navigation",
  "navigation, layout held",
];

/** Each crumb's own segment; cache() at the root adds a level. */
function ownersOf(cached: boolean): Record<string, string> {
  const layout = cached ? "M0L0C0L0" : "M0L0L0";
  return {
    layout,
    orphan: `${layout}L0`,
    page: `${layout}R2`,
    "page-orphan": `${layout}R2L0`,
  };
}

/**
 * Each push in its own segment's bucket: the layout's only when the request
 * ran it, the orphan's always (new to the client, or its revalidate() asks).
 */
function expectedBuckets(
  cached: boolean,
  url: "/b" | "/c",
  shape: Shape,
): Record<string, string[]> {
  const owners = ownersOf(cached);
  const crumbs = [
    ...(shape === "navigation, layout held" ? [] : ["layout"]),
    "orphan",
    ...(url === "/c" ? ["page", "page-orphan"] : []),
  ];
  return Object.fromEntries(crumbs.map((crumb) => [owners[crumb]!, [crumb]]));
}

/** The values a response delivers outside their own segment's bucket. */
function misfiled(
  buckets: Record<string, string[]>,
  cached: boolean,
): string[] {
  const owners = ownersOf(cached);
  return Object.entries(buckets).flatMap(([id, values]) =>
    values
      .filter((crumb) => owners[crumb] !== id)
      .map((crumb) => `${crumb} in ${id}`),
  );
}

const CASES = [
  { url: "/b", name: "a layout's routeless sibling" },
  { url: "/c", name: "and a layout the route declares" },
] as const;

beforeEach(async () => {
  errors.length = 0;
  await resetShellTestState();
});

describe("an orphan layout's handle push belongs to the orphan", () => {
  for (const { url, name } of CASES) {
    for (const shape of SHAPES) {
      it(`${name}, ${shape}`, async () => {
        const router = makeRouter(false);
        const partial = await partialOf(router, shape);
        errors.length = 0;
        const result = await serveShellRequest(router, url, {
          cacheStore: new MemorySegmentCacheStore(),
          partial,
        });
        expect(errors).toEqual([]);
        expect(await bucketsOf(result)).toEqual(
          expectedBuckets(false, url, shape),
        );
      });
    }
  }
});

describe("cache(): the record files an orphan layout's push under the orphan", () => {
  for (const { url, name } of CASES) {
    for (const shape of SHAPES) {
      it(`${name}, ${shape}: the MISS and its HIT`, async () => {
        const router = makeRouter(true);
        const partial = await partialOf(router, shape);
        const cacheStore = new MemorySegmentCacheStore();
        errors.length = 0;
        const miss = await serveShellRequest(router, url, {
          cacheStore,
          partial,
        });
        const runs = orphanRuns;
        const hit = await serveShellRequest(router, url, {
          cacheStore,
          partial,
        });
        expect(errors).toEqual([]);
        expect(orphanRuns).toBe(runs);
        const expected = expectedBuckets(true, url, shape);
        expect(await bucketsOf(miss)).toEqual(expected);
        // A HIT also replays a held layout's bucket from the record; the
        // client holds the same values.
        const hitBuckets = await bucketsOf(hit);
        expect(misfiled(hitBuckets, true)).toEqual([]);
        expect(hitBuckets).toMatchObject(expected);
      });
    }
  }
});

/**
 * A route under loading() pushes before and after an await, beside a layout
 * its path() declares (a static one: no handler, no push).
 */
const streamedRouter = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, loading }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("layout");
        return <main>shell</main>;
      },
      () => [
        path("/a", () => <p>a</p>, { name: "a" }),
        path(
          "/product",
          async (ctx: HandlerContext) => {
            ctx.use(Meta)({ title: "Product" });
            ctx.use(Crumbs)("page");
            await new Promise((resolve) => setTimeout(resolve, 5));
            ctx.use(Meta)({ title: "Blue Widget" });
            ctx.use(Crumbs)("page-late");
            return <article>product</article>;
          },
          { name: "product" },
          () => [loading(<p>loading</p>), layout(<section>frame</section>)],
        ),
      ],
    ),
  ]),
);

describe("a streamed route's push after an await stays the route's beside a layout its path() declares", () => {
  for (const shape of ["document", "navigation"] as const) {
    it(`${shape}: the last title wins and the crumbs keep push order`, async () => {
      const result = await serveShellRequest(streamedRouter, "/product", {
        cacheStore: new MemorySegmentCacheStore(),
        partial:
          shape === "document" ? undefined : { from: "/a", segments: [] },
      });
      const handles = await result.readHandles();
      const data = (handles?.late.at(-1) ??
        handles?.hydration ??
        {}) as HandleData;
      const order = filterSegmentOrder(await matchedOf(result.flight));
      expect(errors).toEqual([]);
      expect({
        titles: collectHandleData(Meta, data, order).filter(
          (d) => "title" in d,
        ),
        crumbs: collectHandleData(Crumbs, data, order),
      }).toEqual({
        titles: [{ title: "Blue Widget" }],
        crumbs: ["layout", "page", "page-late"],
      });
    });
  }
});
