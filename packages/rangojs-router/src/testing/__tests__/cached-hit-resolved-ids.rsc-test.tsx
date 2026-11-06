/**
 * A HIT reports the same `resolvedIds` as the MISS that wrote what it serves,
 * so a segment whose handle values the response replays replaces the client's
 * copy instead of leaving the page's old ones in place.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's values give way when
 * the response delivers values of that run or lists it in `resolvedIds`. A
 * live MISS lists every segment whose handler ran. A HIT serves the record's
 * segments instead, and a stored segment carries no `_handlerRan`
 * (serializeSegments, cache/segment-codec.ts, copies named fields only), so a
 * segment the HIT sent was not listed: the client kept the values the source
 * page pushed, and the record's copy — nothing, when the writing request's
 * handler pushed nothing — never replaced them. A breadcrumb cleared by a
 * navigation came back on the next one, from the same record.
 *
 * serveStoredSegments (router/match-middleware/cache-lookup.ts) collects the
 * ids of the stored segments it sends, so a HIT lists what its MISS listed:
 * the entry's handler values stand in for a run. All three stored sources go
 * through that one loop (a cache() record, a Prerender() bake, and an
 * on-demand overlay entry), and so does a PPR navigation replay
 * (serve-shell-request-replay-revalidate.rsc-test.tsx).
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
import { createMemoryPrerenderStore } from "../index.js";
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

/** Whether a handler pushes its crumb on this request. */
const pushes = { chain: true, item: true, overlay: true };

const router = createRouter({}).routes(
  urls(({ path, cache, layout, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>root</main>;
        },
        () => [
          layout(
            (ctx: HandlerContext) => {
              if (pushes.chain) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [revalidate(() => true)],
          ),
          path(
            "/a",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("a");
              return <p>a</p>;
            },
            { name: "a" },
          ),
          path(
            "/b",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("b");
              return <p>b</p>;
            },
            { name: "b" },
          ),
        ],
      ),
    ]),
  ]),
);

/** A bake whose route handler pushes its crumb only when it is told to. */
const BakedItem = Prerender(
  async () => [{ id: "1" }, { id: "2" }],
  (ctx) => {
    if (pushes.item) ctx.use(Crumbs)(`item-${ctx.params.id}`);
    return <article>item {ctx.params.id}</article>;
  },
);

const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>root</main>;
      },
      () => [path("/item/:id", BakedItem, { name: "item" })],
    ),
  ]),
);

/** An on-demand route: its entries come from router.prerender(), no bake. */
const OnDemandItem = Prerender<{ slug: string }>(
  async () => [{ slug: "a" }, { slug: "b" }],
  (ctx) => {
    if (pushes.overlay) ctx.use(Crumbs)(`od-${ctx.params.slug}`);
    return <article>od {ctx.params.slug}</article>;
  },
  { onDemand: true },
);

interface Answer {
  matched: string[];
  resolvedIds?: string[];
}

/** A response's metadata and the last handle state it streamed. */
async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData }> {
  const { metadata } = await deserializeResult<{
    metadata: Answer & { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

/** The page's crumbs after `result`, merged as the browser merges it. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    current,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return collectHandleData(Crumbs, merged, order);
}

/** A document of `url`: its handles and mounted ids. */
async function documentOf(
  target: Parameters<typeof serveShellRequest>[0],
  url: string,
): Promise<{ handles: HandleData; matched: string[] }> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(target, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  return { handles, matched: answer.matched };
}

beforeEach(async () => {
  await resetShellTestState();
  pushes.chain = true;
  pushes.item = true;
  pushes.overlay = true;
});

describe("a cache() HIT lists the segments it replays in resolvedIds", () => {
  it("the HIT lists what the MISS that wrote the record listed", async () => {
    const page = await documentOf(router, "/a");
    expect(page.handles[Crumbs.$$id]).toBeDefined();
    // The navigation re-runs the chain layout, which pushes nothing now.
    pushes.chain = false;
    const partial = { from: "/a", segments: page.matched };

    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    const missAnswer = await readAnswer(miss);
    expect(await crumbsAfter(page.handles, miss)).toEqual(["root", "b"]);

    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const hitAnswer = await readAnswer(hit);
    expect(hitAnswer.answer.resolvedIds).toEqual(missAnswer.answer.resolvedIds);
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "b"]);
    // Only resolvedIds changed: no internal marker rides the payload.
    expect(hit.flight).not.toContain("storedSentIds");
    expect(hit.flight).not.toContain("_handlerRan");

    // A document lists every segment it renders, a HIT of its record included:
    // the full-match branch of buildMatchResult, which the marker never
    // reaches.
    const documentHit = await serveShellRequest(router, "/a", { cacheStore });
    const documentAnswer = await readAnswer(documentHit);
    expect(documentAnswer.answer.resolvedIds).toEqual(
      documentAnswer.answer.matched,
    );
  });
});

describe("a Prerender() HIT lists the segments it replays in resolvedIds", () => {
  it("a re-sent route replaces the crumbs the source page pushed", async () => {
    // Bake /item/2 with the route handler pushing nothing, then /item/1 with
    // it pushing: the page the navigation starts from shows "item-1".
    pushes.item = false;
    await documentOf(prerenderRouter, "/item/2");
    pushes.item = true;
    const page = await documentOf(prerenderRouter, "/item/1");
    expect(page.handles[Crumbs.$$id]).toBeDefined();
    pushes.item = false;

    const partial = { from: "/item/1", segments: page.matched };
    const hit = await serveShellRequest(prerenderRouter, "/item/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial,
    });
    // The root layout is held, so its crumb stays; the route's is the
    // response's, and the bake pushed none.
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root"]);
    expect(hit.flight).not.toContain("storedSentIds");
  });
});

describe("an on-demand overlay HIT lists the segments it replays in resolvedIds", () => {
  it("a re-sent route replaces the crumbs the source page pushed", async () => {
    const store = createMemoryPrerenderStore();
    const odRouter = createRouter({ prerender: { store } }).routes(
      urls(({ path, layout }) => [
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("root");
            return <main>root</main>;
          },
          () => [path("/od/:slug", OnDemandItem, { name: "od" })],
        ),
      ]),
    );
    // An on-demand route has no live handler to render with, so the page the
    // navigation starts from is served from /od/b's own overlay entry.
    expect(await odRouter.prerender({ env: {} })("/od/b")).toMatchObject({
      ok: true,
      status: "rendered",
    });
    const page = await documentOf(odRouter, "/od/b");
    expect(page.handles[Crumbs.$$id]).toBeDefined();
    // A refresh writes /od/a's entry with its handler pushing nothing.
    pushes.overlay = false;
    expect(await odRouter.prerender({ env: {} })("/od/a")).toMatchObject({
      ok: true,
      status: "rendered",
    });

    const hit = await serveShellRequest(odRouter, "/od/a", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/od/b", segments: page.matched },
    });
    // The root layout is held, so its crumb stays; the route's is the
    // overlay's, and the refresh pushed none.
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root"]);
  });
});
