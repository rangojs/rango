/**
 * A link inside an open intercept to another item of the intercepted route:
 * the request carries the intercept's URL as the page left, the ids held and
 * the source page in `interceptSource`. The item opens in the intercept,
 * `when` sees `from` as the source, and the slot's loader re-runs. A link to
 * the source's route closes the intercept: the page's held segments are
 * compared with the source's params, the slot's with the intercept's.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  createLoader,
  createRouter,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import type { InterceptSelectorContext } from "../../server/context.js";

const loaderRuns: string[] = [];
const ItemLoader = createLoader(async (ctx) => {
  loaderRuns.push(ctx.params.id!);
  return { id: ctx.params.id };
});

const listRuns: string[] = [];
const ListLoader = createLoader(async (ctx) => {
  listRuns.push(ctx.params.id!);
  return { list: `list data ${ctx.params.id}` };
});

const froms: string[] = [];

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path(
            "/list/:id",
            () => <ul>list</ul>,
            { name: "list" },
            () => [loader(ListLoader)],
          ),
          path("/item/:id", () => <article>item page</article>, {
            name: "item",
          }),
          intercept(
            "@modal",
            ".item",
            (ctx) => <dialog>modal {ctx.params.id}</dialog>,
            {
              when: (ctx: InterceptSelectorContext) => {
                froms.push(ctx.from.url.pathname);
                return ctx.from.routeName === "list";
              },
            },
            () => [loader(ItemLoader)],
          ),
        ],
      ),
    ]),
  );
}

interface Metadata {
  matched: string[];
  segments: Array<{ id: string; namespace?: string }>;
}

function metadataOf(flight: string | undefined): Metadata {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return JSON.parse(row!.slice(2)).metadata as Metadata;
}

function interceptIds(metadata: Metadata): string[] {
  return metadata.segments
    .filter((segment) => segment.namespace?.startsWith("intercept:"))
    .map((segment) => segment.id);
}

beforeEach(() => {
  resetShellTestState();
  loaderRuns.length = 0;
  listRuns.length = 0;
  froms.length = 0;
});

describe("a link inside an open intercept", () => {
  async function openIntercept(router: ReturnType<typeof makeRouter>) {
    const serve = (url: string, partial: Record<string, unknown>) =>
      serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
        partial,
      });
    const list = metadataOf((await serve("/list/1", { from: "/" })).flight);
    const opened = metadataOf(
      (await serve("/item/2", { from: "/list/1", segments: list.matched }))
        .flight,
    );
    expect(interceptIds(opened).length).toBeGreaterThan(0);
    expect(loaderRuns).toEqual(["2"]);
    expect(listRuns).toEqual(["1"]);
    return { serve, held: opened.matched };
  }

  // The intercept's URL (/item/2) and the page under it (/list/1) have
  // params of the same name: the page's held loader is compared with the
  // source's params, not the intercept's.
  it("a link to the source's route with other params re-runs the page's loader", async () => {
    const { serve, held } = await openIntercept(makeRouter());

    const result = await serve("/list/2", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: held,
    });

    expect(interceptIds(metadataOf(result.flight))).toEqual([]);
    expect(listRuns).toEqual(["1", "2"]);
    expect(result.flight).toContain("list data 2");
  });

  it("a link to the source page itself keeps the page's loader", async () => {
    const { serve, held } = await openIntercept(makeRouter());

    const result = await serve("/list/1", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: held,
    });

    expect(interceptIds(metadataOf(result.flight))).toEqual([]);
    expect(listRuns).toEqual(["1"]);
  });

  // The page under the intercept is /list/1?page=2; the intercept's URL has
  // no query. The page's held loader is compared with the source's search.
  it("a link to the source's route without the source's query re-runs the page's loader", async () => {
    const router = makeRouter();
    const serve = (url: string, partial: Record<string, unknown>) =>
      serveShellRequest(router, url, {
        cacheStore: new MemorySegmentCacheStore(),
        partial,
      });
    const list = metadataOf(
      (await serve("/list/1?page=2", { from: "/" })).flight,
    );
    const opened = metadataOf(
      (
        await serve("/item/1", {
          from: "/list/1?page=2",
          segments: list.matched,
        })
      ).flight,
    );
    expect(interceptIds(opened).length).toBeGreaterThan(0);

    await serve("/list/1", {
      from: "/item/1",
      interceptSource: "/list/1?page=2",
      segments: opened.matched,
    });

    expect(listRuns).toEqual(["1", "1"]);
  });

  it("opens the other item in the intercept, resolved from the source page, and re-runs the slot's loader", async () => {
    const { serve, held } = await openIntercept(makeRouter());
    froms.length = 0;

    const result = await serve("/item/1", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: held,
    });

    const metadata = metadataOf(result.flight);
    const sent = interceptIds(metadata);
    expect(sent.some((id) => id.endsWith(".@modal"))).toBe(true);
    expect(sent.some((id) => id.includes(".@modalD0."))).toBe(true);
    expect(result.flight).toContain("modal");
    expect(result.flight).not.toContain("item page");
    expect(froms).toEqual(["/list/1"]);
    expect(loaderRuns).toEqual(["2", "1"]);
  });

  // The request a prefetch inside the modal sends is the click's request, so
  // the answer it warms is the modal — the browser stores it for that
  // context alone and the click adopts it (browser/prefetch/cache.ts
  // buildInterceptKey). A prefetch that named no source would warm the item's
  // full page instead.
  it("a prefetch of the same link renders the item in the intercept too", async () => {
    const { serve, held } = await openIntercept(makeRouter());
    froms.length = 0;

    const result = await serve("/item/1", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: held,
      prefetch: true,
    });

    const sent = interceptIds(metadataOf(result.flight));
    expect(sent.some((id) => id.endsWith(".@modal"))).toBe(true);
    expect(result.flight).toContain("modal");
    expect(result.flight).not.toContain("item page");
    expect(froms).toEqual(["/list/1"]);
    expect(loaderRuns).toEqual(["2", "1"]);
  });

  it("control: from the intercept's URL with no source, the same route is not intercepted", async () => {
    const { serve, held } = await openIntercept(makeRouter());

    const result = await serve("/item/1", { from: "/item/2", segments: held });

    expect(interceptIds(metadataOf(result.flight))).toEqual([]);
    expect(result.flight).toContain("item page");
  });
});

describe("a link inside an open intercept, over a Prerender() page", () => {
  const listLayoutRuns: string[] = [];
  beforeEach(() => {
    listLayoutRuns.length = 0;
  });

  const PrerenderedList = Prerender(
    async () => [{ id: "1" }, { id: "2" }],
    () => <ul>list</ul>,
  );

  function makePrerenderRouter() {
    return createRouter({}).routes(
      urls(({ path, layout, intercept }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list/:id", PrerenderedList, { name: "list" }, () => [
              layout((ctx: HandlerContext<{ id: string }>) => {
                listLayoutRuns.push(ctx.params.id!);
                return <section>{`list layout ${ctx.params.id}`}</section>;
              }),
            ]),
            path("/item/:id", () => <article>item page</article>, {
              name: "item",
            }),
            intercept("@modal", ".item", (ctx) => (
              <dialog>modal {ctx.params.id}</dialog>
            )),
          ],
        ),
      ]),
    );
  }

  it("a link to the source's route with other params sends the route's own layout from the bake", async () => {
    const router = makePrerenderRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const serve = (url: string, partial: Record<string, unknown>) =>
      serveShellRequest(router, url, { cacheStore, partial });
    // The first request of each page bakes it.
    await serve("/list/2", { from: "/" });
    const list = metadataOf((await serve("/list/1", { from: "/" })).flight);
    const opened = metadataOf(
      (await serve("/item/2", { from: "/list/1", segments: list.matched }))
        .flight,
    );
    expect(interceptIds(opened).length).toBeGreaterThan(0);
    listLayoutRuns.length = 0;

    const result = await serve("/list/2", {
      from: "/item/2",
      interceptSource: "/list/1",
      segments: opened.matched,
    });

    expect(listLayoutRuns).toEqual([]);
    expect(interceptIds(metadataOf(result.flight))).toEqual([]);
    expect(result.flight).toContain("list layout 2");
  });
});
