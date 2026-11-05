/**
 * A partial response served from storage (a cache() record, a PPR navigation
 * replay, a Prerender() bake) clears the handle values of a segment it sends
 * whose stored run pushed none, as the live response does.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a segment's old values give
 * way only when the response delivers values for it or lists it in
 * `resolvedIds`. A live response lists each segment whose handler re-ran. A
 * stored one listed none of the stored segments it sent, so where the stored
 * run pushed nothing for one, the page kept the values the segment pushed for
 * the page it left: a breadcrumb that the live navigation clears came back on
 * the HIT.
 *
 * Each navigation below goes from /item/1 to /item/2. Every segment under the
 * root pushes a crumb for item 1 only: the route, a layout above it with
 * revalidate(() => true), and a layout its path() declares (it re-runs with
 * the route when the params change). The root layout is held, and keeps its
 * crumb on every path. An intercept's slot, which a cache() HIT always sends,
 * clears the same way when an open modal moves from item 1 to item 2.
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
  type ServeShellRequestResult,
} from "../flight.entry.js";
import type { PprReplayStatus } from "../index.js";
import {
  createHandle,
  createRouter,
  Prerender,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

type ItemContext = HandlerContext<{ id: string }>;

/** Runs of the item route's handler, live or in a background render. */
let itemRuns = 0;

/** Pushes `crumb` on item 1's page only. */
function crumbOnFirst(ctx: ItemContext, crumb: string): void {
  if (ctx.params.id === "1") ctx.use(Crumbs)(crumb);
}

function Root(ctx: HandlerContext): React.ReactNode {
  ctx.use(Crumbs)("root");
  return <main>root</main>;
}

function Chain(ctx: ItemContext): React.ReactNode {
  crumbOnFirst(ctx, "chain-1");
  return <section>chain</section>;
}

/** The item route's handler body, live or baked by Prerender(). */
function itemPage(id: string, push: (crumb: string) => void): React.ReactNode {
  itemRuns++;
  if (id === "1") push("item-1");
  return <article>{`item-${id}`}</article>;
}

function Orphan(ctx: ItemContext): React.ReactNode {
  crumbOnFirst(ctx, "orphan-1");
  return <aside>orphan</aside>;
}

type Source = "live" | "cache" | "ppr" | "prerender";

/**
 * The item page rendered live on every request, under a cache(), as a ppr
 * route, or baked by Prerender(). Each tree has the same segment ids.
 */
function itemRouter(source: Source) {
  return createRouter({}).routes(
    urls(({ path, layout, cache, revalidate }) => {
      // DSL items bind to the entry whose callback calls them: each is
      // created inside its parent's callback.
      const item = () =>
        source === "prerender"
          ? path(
              "/item/:id",
              Prerender(
                async () => [{ id: "1" }, { id: "2" }],
                (ctx) => itemPage(ctx.params.id, ctx.use(Crumbs)),
              ),
              { name: "item" },
              () => [layout(Orphan)],
            )
          : path(
              "/item/:id",
              (ctx: ItemContext) => itemPage(ctx.params.id, ctx.use(Crumbs)),
              { name: "item", ...(source === "ppr" ? { ppr: true } : {}) },
              () => [layout(Orphan)],
            );
      const tree = () =>
        layout(Root, () => [
          layout(Chain, () => [revalidate(() => true), item()]),
        ]);
      return source === "cache"
        ? [cache({ ttl: 600 }, () => [tree()])]
        : [tree()];
    }),
  );
}

/** Runs of the modal's slot handler. */
let modalRuns = 0;

/** A list whose items open in a modal, under a cache(). */
const modalRouter = createRouter({}).routes(
  urls(({ path, layout, cache, intercept }) => [
    cache({ ttl: 600 }, () => [
      layout(Root, () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/item/:id", () => <article>item</article>, { name: "item" }),
        intercept("@modal", ".item", (ctx: ItemContext) => {
          modalRuns++;
          crumbOnFirst(ctx, "modal-1");
          return <dialog>modal</dialog>;
        }),
      ]),
    ]),
  ]),
);

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  handles?: AsyncIterable<HandleData>;
}

/** A response's metadata and the last handle state it streamed. */
async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData }> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

interface Page {
  handles: HandleData;
  matched: string[];
}

/**
 * The page after a partial response, its handles merged as the browser
 * merges them: its crumbs, and the response's resolvedIds sorted.
 */
async function crumbsAfter(
  page: Page,
  result: ServeShellRequestResult,
): Promise<{ crumbs: string[]; resolvedIds: string[]; page: Page }> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    page.handles,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return {
    crumbs: collectHandleData(Crumbs, merged, order),
    resolvedIds: [...(answer.resolvedIds ?? [])].sort(),
    page: { handles: merged, matched: answer.matched },
  };
}

/** The document of /item/1: its handles and mounted ids. */
async function itemOneDocument(
  router: ReturnType<typeof itemRouter>,
): Promise<Page> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, "/item/1", {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  expect(
    collectHandleData(Crumbs, handles, filterSegmentOrder(answer.matched)),
  ).toEqual(["root", "chain-1", "orphan-1", "item-1"]);
  return { handles, matched: answer.matched };
}

/**
 * The navigation /item/1 -> /item/2, served twice with one store: the first
 * renders live and stores its render (the cache() record, the navigation-only
 * capture), the second serves what it stored.
 */
async function liveThenStored(source: Source) {
  const router = itemRouter(source);
  const page = await itemOneDocument(router);
  const cacheStore = new MemorySegmentCacheStore();
  const partial = { from: "/item/1", segments: page.matched };
  itemRuns = 0;
  const live = await serveShellRequest(router, "/item/2", {
    cacheStore,
    partial,
  });
  expect(itemRuns).toBeGreaterThan(0);
  itemRuns = 0;
  const stored = await serveShellRequest(router, "/item/2", {
    cacheStore,
    partial,
  });
  expect(itemRuns).toBe(0);
  return {
    page,
    live,
    stored,
  };
}

const REPLAY_HIT: PprReplayStatus = { outcome: "HIT", freshness: "fresh" };

beforeEach(async () => {
  itemRuns = 0;
  modalRuns = 0;
  await resetShellTestState();
});

describe("a stored partial clears the values of a sent segment whose stored run pushed none", () => {
  it("cache(): the HIT lists the segments the MISS lists", async () => {
    const { page, live, stored } = await liveThenStored("cache");
    const miss = await crumbsAfter(page, live);
    const hit = await crumbsAfter(page, stored);
    expect(miss.crumbs).toEqual(["root"]);
    expect(hit.crumbs).toEqual(miss.crumbs);
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
  });

  it("a PPR navigation replay: the HIT lists the segments the live render lists", async () => {
    const { page, live, stored } = await liveThenStored("ppr");
    expect(live.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    expect(stored.replayStatus).toEqual(REPLAY_HIT);
    const miss = await crumbsAfter(page, live);
    const hit = await crumbsAfter(page, stored);
    expect(miss.crumbs).toEqual(["root"]);
    expect(hit.crumbs).toEqual(miss.crumbs);
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
  });

  it("Prerender(): the bake's HIT clears them as a live render does", async () => {
    const router = itemRouter("prerender");
    const page = await itemOneDocument(router);
    const navigate = () =>
      serveShellRequest(router, "/item/2", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/item/1", segments: page.matched },
      });
    // The first request bakes /item/2 and serves the bake; the second serves
    // it and runs no handler.
    itemRuns = 0;
    const first = await navigate();
    expect(itemRuns).toBeGreaterThan(0);
    itemRuns = 0;
    const second = await navigate();
    expect(itemRuns).toBe(0);
    const baked = await crumbsAfter(page, first);
    expect(baked.crumbs).toEqual(["root"]);
    expect(await crumbsAfter(page, second)).toEqual(baked);

    // The same tree rendered live lists the same segments.
    const liveRouter = itemRouter("live");
    const livePage = await itemOneDocument(liveRouter);
    expect(livePage.matched).toEqual(page.matched);
    const live = await crumbsAfter(
      livePage,
      await serveShellRequest(liveRouter, "/item/2", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: { from: "/item/1", segments: livePage.matched },
      }),
    );
    expect(live.crumbs).toEqual(["root"]);
    expect(baked.resolvedIds).toEqual(live.resolvedIds);
  });

  it("cache(): an open modal's slot, moved to another item", async () => {
    const list = await readAnswer(
      await serveShellRequest(modalRouter, "/list", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    );
    const opened = await crumbsAfter(
      { handles: list.handles, matched: list.answer.matched },
      await serveShellRequest(modalRouter, "/item/1", {
        cacheStore: new MemorySegmentCacheStore(),
        partial: {
          from: "/list",
          interceptSource: "/list",
          segments: list.answer.matched,
        },
      }),
    );
    expect(opened.crumbs).toEqual(["root", "modal-1"]);
    const cacheStore = new MemorySegmentCacheStore();
    const partial = {
      from: "/item/1",
      interceptSource: "/list",
      segments: opened.page.matched,
    };
    // The first navigation writes the intercept's record; the second serves
    // it and runs no slot handler.
    await serveShellRequest(modalRouter, "/item/2", { cacheStore, partial });
    modalRuns = 0;
    const hit = await serveShellRequest(modalRouter, "/item/2", {
      cacheStore,
      partial,
    });
    expect(modalRuns).toBe(0);
    expect((await crumbsAfter(opened.page, hit)).crumbs).toEqual(["root"]);
  });
});
