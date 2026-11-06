/**
 * A cache() HIT reports the same `resolvedIds` as the MISS that wrote its
 * record, so a stored segment's handle values give way on a HIT as they did
 * on the MISS.
 *
 * A partial response's `resolvedIds` (MatchResult) names the runs whose handle
 * values the browser replaces with what the response delivered, nothing when
 * it delivered none (mergePartialHandleData, handles/pushed-by.ts). A live
 * walk marks each segment whose handler ran (`_handlerRan`,
 * router/segment-resolution/revalidation.ts) and match-result.ts lists it. A
 * record carries no such marker — serializeSegments (cache/segment-codec.ts)
 * copies named fields only — so a HIT listed only the segments it resolved
 * live, above the cache() boundary: a chain layout whose revalidate() rule
 * sent it from the record, and which had pushed nothing when the record was
 * written, kept its old crumb on the page.
 *
 * A stored segment the HIT sends stands in for a run of its handler: the
 * record's values are that run's, and the browser replaces them. So it is
 * listed, exactly when it is sent (serveStoredSegments, cache-lookup.ts).
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
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;
/** How often the chain layout's handler ran. */
let chainRuns = 0;

const router = createRouter({}).routes(
  urls(({ path, layout, cache, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        cache({ ttl: 600 }, () => [
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
      ],
    ),
  ]),
);

/**
 * The same shape for a Prerender() route: its entry is baked with the handler
 * pushing on one param set only, so the navigation to the other one sends a
 * stored route segment whose recorded values are none.
 */
const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        path(
          "/item/:id",
          Prerender<{ id: string }>(
            async () => [{ id: "1" }, { id: "2" }],
            (ctx) => {
              if (ctx.params.id === "1") ctx.use(Crumbs)("item-1");
              return <article>{ctx.params.id}</article>;
            },
          ),
          { name: "item" },
        ),
      ],
    ),
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

/** The segment id whose Crumbs values include `crumb`. */
function segmentWith(handles: HandleData, crumb: string): string {
  const bySegment = handles[Crumbs.$$id] ?? {};
  for (const [id, values] of Object.entries(bySegment)) {
    if (values.includes(crumb)) return id;
  }
  throw new Error(`no segment pushed ${crumb}`);
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

/** A document of `url`, its handles and the ids the client mounts. */
async function documentOf(
  app: typeof router | typeof prerenderRouter,
  url: string,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(app, url, {
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
  chainRuns = 0;
  await resetShellTestState();
});

describe("a cache() HIT lists the segments its record sends", () => {
  it("resolvedIds of the HIT equal the MISS's", async () => {
    const page = await documentOf(router, "/a");
    const chainId = segmentWith(page.handles, "chain");
    chainPushes = false;
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/a", segments: page.matched };

    const miss = await readAnswer(
      await serveShellRequest(router, "/b", { cacheStore, partial }),
    );
    // The chain layout's rule re-runs it; the route is new to the client.
    expect(miss.answer.resolvedIds).toEqual([
      chainId,
      segmentWith(miss.handles, "b"),
    ]);

    const hit = await readAnswer(
      await serveShellRequest(router, "/b", { cacheStore, partial }),
    );
    // The record serves both: their values stand for the runs the MISS made.
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
  });

  it("a breadcrumb the chain layout stops pushing clears on the HIT too", async () => {
    const page = await documentOf(router, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);
    chainPushes = false;
    chainRuns = 0;
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/a", segments: page.matched };

    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    const runsAfterMiss = chainRuns;
    expect(runsAfterMiss).toBeGreaterThan(0);
    expect(await crumbsAfter(page.handles, miss)).toEqual(["root", "b"]);

    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    // The record serves the chain layout: its handler does not run.
    expect(chainRuns).toBe(runsAfterMiss);
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "b"]);
  });

  it("a Prerender() HIT lists the route segment it sends", async () => {
    const first = await documentOf(prerenderRouter, "/item/1");
    expect(first.crumbs).toEqual(["root", "item-1"]);
    const routeId = segmentWith(first.handles, "item-1");
    const partial = { from: "/item/1", segments: first.matched };

    // The entry for /item/2 is baked without the handler's push; the params
    // changed, so the stored route segment is sent.
    const hit = await serveShellRequest(prerenderRouter, "/item/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial,
    });
    const { answer } = await readAnswer(hit);
    expect(answer.resolvedIds).toEqual([routeId]);
    // The layout above the route has no rule asking for it: kept, unlisted.
    expect(answer.resolvedIds).not.toContain(
      segmentWith(first.handles, "root"),
    );
    expect(await crumbsAfter(first.handles, hit)).toEqual(["root"]);
  });
});
