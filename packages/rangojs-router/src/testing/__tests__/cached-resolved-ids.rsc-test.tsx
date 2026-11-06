/**
 * A stored response reports the segments whose handler ran for it in
 * `resolvedIds`, so a HIT reports the ids of the render that wrote what it
 * serves.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a segment's values give way
 * to the response's only when it delivers values of that run or lists it in
 * `resolvedIds`. A live walk marks every handler it ran (`_handlerRan`,
 * router/segment-resolution/revalidation.ts) and match-result.ts turns those
 * into `resolvedIds`. A stored record did not carry the marker
 * (segment-codec.ts serializeSegments), so a HIT listed no handler at all: a
 * segment whose handler the record re-sends and that pushed nothing kept the
 * page's previous values, so a breadcrumb that cleared on the MISS came back.
 *
 * The marker is stored with the record (segment-codec.ts) and cleared for a
 * segment the HIT keeps (cache-lookup.ts keepClientSegment): a kept segment's
 * handler did not run for this response, and the browser keeps its values.
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
import {
  createHandle,
  createRouter,
  Prerender,
  revalidate,
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>(
  (segments) => segments.flat() as string[],
);

/** Whether the chain layout pushes its crumb on this render. */
let chainPushes = true;

/** A handler that pushes one crumb. */
function pushes<TParams = {}>(
  crumb: string,
): (ctx: HandlerContext<TParams>) => React.ReactNode {
  return (ctx: HandlerContext<TParams>) => {
    ctx.use(Crumbs)(crumb);
    return <p>{crumb}</p>;
  };
}

/** The chain layout every tree shares: it re-runs on every navigation. */
function chainLayout(ctx: HandlerContext): React.ReactNode {
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <section>chain</section>;
}

/** A held layout above the chain: no rules, so every HIT keeps it. */
function rootLayout(ctx: HandlerContext): React.ReactNode {
  ctx.use(Crumbs)("root");
  return <main>shell</main>;
}

type Router = Parameters<typeof serveShellRequest>[0];

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

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<{ crumbs: string[]; resolvedIds: string[] | undefined }> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    current,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return {
    crumbs: collectHandleData(Crumbs, merged, order),
    resolvedIds: answer.resolvedIds,
  };
}

/** The document at `url`, as the client received it. */
async function documentOf(
  router: Router,
  url: string,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  chainPushes = true;
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  return {
    handles,
    matched: answer.matched,
    crumbs: collectHandleData(
      Crumbs,
      handles,
      filterSegmentOrder(answer.matched),
    ),
  };
}

beforeEach(async () => {
  chainPushes = true;
  await resetShellTestState();
});

/** /a and /b under one cache() record, both inside the chain layout. */
const cacheRouter = createRouter({}).routes(
  urls(({ path, cache, layout }) => [
    cache({ ttl: 600 }, () => [
      layout(rootLayout, () => [
        layout(chainLayout, () => [
          revalidate(() => true),
          path("/a", pushes("a"), { name: "a" }),
          path("/b", pushes("b"), { name: "b" }),
        ]),
      ]),
    ]),
  ]),
);

describe("a cache() HIT lists the segments whose handler ran for the record", () => {
  it("a chain layout that re-runs and pushes nothing clears its crumb", async () => {
    const pageA = await documentOf(cacheRouter, "/a");
    expect(pageA.crumbs).toEqual(["root", "chain", "a"]);
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/a", segments: pageA.matched };
    const serve = () =>
      serveShellRequest(cacheRouter, "/b", { cacheStore, partial });
    // The MISS renders the navigation live and writes the record; the HIT
    // serves that record.
    chainPushes = false;
    const miss = await crumbsAfter(pageA.handles, await serve());
    const hit = await crumbsAfter(pageA.handles, await serve());
    expect(miss.crumbs).toEqual(["root", "b"]);
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
    expect(hit.crumbs).toEqual(miss.crumbs);
  });

  it("keeps the crumb of a layout the HIT does not send", async () => {
    const pageA = await documentOf(cacheRouter, "/a");
    const cacheStore = new MemorySegmentCacheStore();
    const serve = () =>
      serveShellRequest(cacheRouter, "/b", {
        cacheStore,
        partial: { from: "/a", segments: pageA.matched },
      });
    chainPushes = false;
    await serve();
    const hit = await crumbsAfter(pageA.handles, await serve());
    // The record was written by a render that ran the root layout's handler
    // (a record covering a held segment takes the proactive write), so its
    // marker is in the record. The HIT keeps the root layout, so the browser
    // must keep its values: not listed, crumb intact.
    expect(hit.resolvedIds).not.toContain(pageA.matched[0]);
    expect(hit.crumbs).toEqual(["root", "b"]);
  });
});

/**
 * /list and /item/:id inside the chain layout, with the detail page rendered
 * live or baked by Prerender(). The navigation below changes the params, so a
 * bake HIT sends the held chain layout and runs its revalidate() rules
 * (cache-lookup.ts storedEntrySends); on equal params it keeps the client's
 * copy.
 */
function makeDetailRouter(baked: boolean) {
  return createRouter({}).routes(
    urls(({ path, layout }) => [
      layout(rootLayout, () => [
        layout(chainLayout, () => [
          revalidate(() => true),
          path("/list", pushes("list"), { name: "list" }),
          baked
            ? path(
                "/item/:id",
                Prerender(
                  async () => [{ id: "1" }, { id: "2" }],
                  (ctx) => {
                    ctx.use(Crumbs)("item");
                    return <p>item</p>;
                  },
                ),
                { name: "item" },
              )
            : path("/item/:id", pushes<{ id: string }>("item"), {
                name: "item",
              }),
        ]),
      ]),
    ]),
  );
}

/** The navigation /list -> /item/1, served `times` times over one store. */
async function navigateToDetail(
  router: Router,
  times: number,
): Promise<{ crumbs: string[]; resolvedIds: string[] | undefined }> {
  const pageList = await documentOf(router, "/list");
  const cacheStore = new MemorySegmentCacheStore();
  const partial = { from: "/list", segments: pageList.matched };
  chainPushes = false;
  let last: ServeShellRequestResult | undefined;
  for (let i = 0; i < times; i++) {
    last = await serveShellRequest(router, "/item/1", { cacheStore, partial });
  }
  return crumbsAfter(pageList.handles, last!);
}

describe("a Prerender() HIT lists the segments whose handler ran for the bake", () => {
  it("reports the ids the live render of the same navigation reports", async () => {
    const live = await navigateToDetail(makeDetailRouter(false), 1);
    // The first request bakes /item/1 and serves the bake; the second is a
    // HIT of it. Both serve the same bake.
    const baking = await navigateToDetail(makeDetailRouter(true), 1);
    const baked = await navigateToDetail(makeDetailRouter(true), 2);
    expect(live.crumbs).toEqual(["root", "item"]);
    expect(baking.crumbs).toEqual(live.crumbs);
    expect(baking.resolvedIds).toEqual(live.resolvedIds);
    expect(baked.crumbs).toEqual(live.crumbs);
    expect(baked.resolvedIds).toEqual(live.resolvedIds);
  });
});

/** /list and /item/:id inside the chain layout, the detail page a ppr route. */
const pprRouter = createRouter({}).routes(
  urls(({ path, layout }) => [
    layout(rootLayout, () => [
      layout(chainLayout, () => [
        revalidate(() => true),
        path("/list", pushes("list"), { name: "list" }),
        path("/item/:id", pushes<{ id: string }>("item"), {
          name: "item",
          ppr: true,
        }),
      ]),
    ]),
  ]),
);

describe("a PPR navigation replay lists the segments whose handler ran for the snapshot", () => {
  it("reports the ids the live partial path reports", async () => {
    const pageList = await documentOf(pprRouter, "/list");
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/list", segments: pageList.matched };
    const serve = () =>
      serveShellRequest(pprRouter, "/item/1", { cacheStore, partial });
    chainPushes = false;
    // The first partial is the live path and captures the snapshot; the
    // second replays it.
    const live = await crumbsAfter(pageList.handles, await serve());
    const replay = await crumbsAfter(pageList.handles, await serve());
    expect(live.crumbs).toEqual(["root", "item"]);
    expect(replay.crumbs).toEqual(live.crumbs);
    expect(replay.resolvedIds).toEqual(live.resolvedIds);
  });
});
