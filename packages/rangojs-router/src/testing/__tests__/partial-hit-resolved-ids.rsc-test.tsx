/**
 * A partial response served from storage reports the segments it re-resolved
 * in `resolvedIds`, as the live walk for the same request does.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * when the response delivers values of that run or lists it in `resolvedIds`.
 * A live walk marks every segment it re-resolved (`_handlerRan`,
 * router/segment-resolution/revalidation.ts), and buildMatchResult
 * (router/match-result.ts) reports those ids. A stored record does not carry
 * the marker (serializeSegments, cache/segment-codec.ts copies named fields),
 * so a HIT listed none of its sent segments and the browser kept a handle
 * value the navigation had cleared.
 *
 * Every stored source serves through serveStoredSegments
 * (router/match-middleware/cache-lookup.ts): a cache() record, a Prerender()
 * bake and a ppr shell replay are the three below.
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
  urls,
  type HandlerContext,
  type Rango,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import { collectHandleData } from "../../handle.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;
/** The chain layout's handler runs. */
let chainRuns = 0;

/** Where the destination page is served from. */
type Target = "live" | "cache" | "prerender" | "ppr";

/**
 * A tree whose chain layout re-runs on every navigation
 * (`revalidate(() => true)`), with a source page `/a` beside the destination
 * `/item/:id`. The target decides how the destination is served: live, from a
 * cache() record, from a Prerender() bake, or from a ppr shell replay.
 */
const itemPage = (ctx: HandlerContext<{ id: string }>): React.ReactNode => {
  ctx.use(Crumbs)("item");
  return <article>item</article>;
};

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  (ctx) => {
    ctx.use(Crumbs)("item");
    return <article>item</article>;
  },
);

function makeRouter(target: Target): Rango<any, any> {
  return createRouter({
    cache: { store: new MemorySegmentCacheStore() },
  }).routes(
    urls(({ path, layout, cache, revalidate }) => {
      const tree = () =>
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("root");
            return <main>shell</main>;
          },
          () => [
            layout(
              (ctx: HandlerContext) => {
                chainRuns++;
                if (chainPushes) ctx.use(Crumbs)("chain");
                return <section>chain</section>;
              },
              () => [
                revalidate(() => true),
                path(
                  "/a",
                  (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("a");
                    return <p>a</p>;
                  },
                  { name: "a" },
                ),
                path(
                  "/item/:id",
                  target === "prerender" ? PrerenderedItem : itemPage,
                  { name: "item", ...(target === "ppr" ? { ppr: true } : {}) },
                ),
              ],
            ),
          ],
        );
      return [
        target === "cache" ? cache({ ttl: 600 }, () => [tree()]) : tree(),
      ];
    }),
  );
}

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  handles?: AsyncIterable<HandleData>;
}

/** A response's metadata and the last handle state it streamed. */
async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData }> {
  // The live marker is internal: a response never carries it, stored or not.
  expect(result.flight).not.toContain("_handlerRan");
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

/** The page at /a as the browser holds it, and the navigation to /item/1. */
async function navigate(target: Target) {
  const router = makeRouter(target);
  const page = await readAnswer(await serveShellRequest(router, "/a"));
  const partial = { from: "/a", segments: page.answer.matched };
  return {
    page,
    crumbs: collectHandleData(
      Crumbs,
      page.handles,
      filterSegmentOrder(page.answer.matched),
    ),
    /** The request the browser sends for /item/1. */
    toItem: () => serveShellRequest(router, "/item/1", { partial }),
    /** The document of /item/1: it bakes a Prerender() and captures a ppr shell. */
    document: () => serveShellRequest(router, "/item/1"),
  };
}

beforeEach(async () => {
  chainPushes = true;
  chainRuns = 0;
  await resetShellTestState();
});

describe("a partial HIT reports the segments it re-resolved, as a live walk does", () => {
  it("a cache() record: the HIT reports the MISS's resolvedIds", async () => {
    const nav = await navigate("cache");
    const runsAfterDocument = chainRuns;

    const missAnswer = (await readAnswer(await nav.toItem())).answer;
    const runsAfterMiss = chainRuns;
    const hitAnswer = (await readAnswer(await nav.toItem())).answer;

    // The navigation ran the chain layout (its response, then the proactive
    // re-render that wrote the record); the second one was a HIT.
    expect(runsAfterMiss).toBeGreaterThan(runsAfterDocument);
    expect(chainRuns).toBe(runsAfterMiss);
    expect(missAnswer.resolvedIds?.length).toBeGreaterThan(0);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
  });

  it("a cache() record: a handle value the MISS cleared stays cleared", async () => {
    const nav = await navigate("cache");
    expect(nav.crumbs).toEqual(["root", "chain", "a"]);

    chainPushes = false;
    const miss = await nav.toItem();
    expect(await crumbsAfter(nav.page.handles, miss)).toEqual(["root", "item"]);

    const hit = await nav.toItem();
    expect(await crumbsAfter(nav.page.handles, hit)).toEqual(["root", "item"]);
  });

  it("a Prerender() bake: the HIT reports the live walk's resolvedIds", async () => {
    const live = await navigate("live");
    const liveAnswer = (await readAnswer(await live.toItem())).answer;

    const nav = await navigate("prerender");
    const item = await nav.document();
    expect(item.shellStatus).toBeNull();
    const runsAfterDocument = chainRuns;
    const hit = await nav.toItem();
    const hitAnswer = (await readAnswer(hit)).answer;

    // The document baked and served the entry; the navigation did not re-run
    // the chain layout.
    expect(chainRuns).toBe(runsAfterDocument);
    expect(hitAnswer.resolvedIds).toEqual(liveAnswer.resolvedIds);
  });

  it("a document HIT lists every segment, as the document MISS does", async () => {
    const router = makeRouter("cache");
    const miss = (await readAnswer(await serveShellRequest(router, "/item/1")))
      .answer;
    const hit = (await readAnswer(await serveShellRequest(router, "/item/1")))
      .answer;

    expect(hit.resolvedIds?.length).toBeGreaterThan(0);
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
  });

  it("a ppr shell replay: the HIT reports the live walk's resolvedIds", async () => {
    const live = await navigate("live");
    const liveAnswer = (await readAnswer(await live.toItem())).answer;

    const nav = await navigate("ppr");
    const document = await nav.document();
    expect(document.shellStatus).toBe("MISS");
    const hit = await nav.toItem();
    expect(hit.replayStatus?.outcome).toBe("HIT");
    const hitAnswer = (await readAnswer(hit)).answer;

    expect(hitAnswer.resolvedIds).toEqual(liveAnswer.resolvedIds);
  });
});
