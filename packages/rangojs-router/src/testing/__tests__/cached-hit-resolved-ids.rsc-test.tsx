/**
 * A stored hit lists in `resolvedIds` the segments whose handler run it serves
 * from the record — a route cache() record, a Prerender() artifact — as the
 * render that wrote the record did.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * when the response delivers values of that run or lists it in
 * `resolvedIds`. A record carries no `_handlerRan` (serializeSegments copies
 * named fields only), so a HIT that re-sent a revalidated segment listed
 * nothing: the handler's previous push stayed on the page. A breadcrumb the
 * handler stopped pushing cleared on the MISS and came back on every HIT.
 *
 * What a HIT serves from the record is the send decision
 * (serveStoredSegments), which is the same revalidate() answer the MISS's
 * walk gave that segment's handler.
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
  type BuildContext,
  type HandlerContext,
} from "../../index.rsc.js";
import { collectHandleData } from "../../handle.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its breadcrumb on this request. */
let breadcrumb = true;
/** The chain layout's handler runs. */
let chainRuns = 0;

const router = createRouter({}).routes(
  urls(({ path, layout, cache, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>root</main>;
      },
      () => [
        cache({ ttl: 600 }, () => [
          layout(
            (ctx: HandlerContext) => {
              chainRuns++;
              if (breadcrumb) ctx.use(Crumbs)("chain");
              return <div>chain</div>;
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

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  segments: { id: string }[];
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
): Promise<string[]> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  return collectHandleData(
    Crumbs,
    mergePartialHandleData(
      current,
      handles,
      order,
      answer.matched,
      answer.resolvedIds,
    ),
    order,
  );
}

/** A document of `url` on `target`, its handles and mounted ids. */
async function documentOf(
  url: string,
  target: Parameters<typeof serveShellRequest>[0] = router,
): Promise<{
  handles: HandleData;
  matched: string[];
  crumbs: string[];
}> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(target, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  const order = filterSegmentOrder(answer.matched);
  return {
    handles,
    matched: answer.matched,
    crumbs: collectHandleData(Crumbs, handles, order),
  };
}

/** The same layout handler and route, rendered live and baked by Prerender(). */
const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        chainRuns++;
        if (breadcrumb) ctx.use(Crumbs)("chain");
        return <div>chain</div>;
      },
      () => [
        revalidate(() => true),
        path(
          "/baked/:id",
          Prerender(
            async () => [{ id: "1" }, { id: "2" }],
            (ctx: BuildContext<{ id: string }>) => {
              ctx.use(Crumbs)("baked");
              return <p>baked</p>;
            },
          ),
          { name: "baked" },
        ),
      ],
    ),
  ]),
);

beforeEach(async () => {
  breadcrumb = true;
  chainRuns = 0;
  await resetShellTestState();
});

describe("a stored hit lists what it serves", () => {
  it("clears a breadcrumb the MISS cleared, on every HIT after it", async () => {
    const page = await documentOf("/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);

    // The handler stops pushing its crumb, and a navigation to /b holds
    // everything the page mounted.
    breadcrumb = false;
    const partial = { from: "/a", segments: page.matched };
    const cacheStore = new MemorySegmentCacheStore();

    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    const missAnswer = (await readAnswer(miss)).answer;
    expect(await crumbsAfter(page.handles, miss)).toEqual(["root", "b"]);

    // The HIT serves the record the MISS wrote, from the same page.
    const runsBeforeHit = chainRuns;
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const hitAnswer = (await readAnswer(hit)).answer;
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "b"]);

    // Same answer, segment for segment: the chain layout's handler run is the
    // record's, the route is new to the page.
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    // The record's copy of the run stands in for it: the HIT ran no handler.
    expect(chainRuns).toBe(runsBeforeHit);
  });

  it("a Prerender() HIT clears what the artifact's layout stopped pushing", async () => {
    const page = await documentOf("/baked/1", prerenderRouter);
    expect(page.crumbs).toEqual(["chain", "baked"]);

    breadcrumb = false;
    const hit = await serveShellRequest(prerenderRouter, "/baked/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/baked/1", segments: page.matched },
    });
    const { answer } = await readAnswer(hit);
    // The params changed: the artifact's layout and route are sent again.
    expect(answer.resolvedIds).toEqual(answer.segments.map((s) => s.id));
    expect(await crumbsAfter(page.handles, hit)).toEqual(["baked"]);
  });

  it("keeps a held segment the record does not serve", async () => {
    const page = await documentOf("/a");
    breadcrumb = false;
    const partial = { from: "/a", segments: page.matched };
    const cacheStore = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/b", { cacheStore, partial });

    // The root layout sits above the cache() boundary and no revalidate()
    // re-runs it: neither response lists it, so its crumb stands.
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const { answer } = await readAnswer(hit);
    expect(answer.resolvedIds).not.toContain(page.matched[0]);
    expect(await crumbsAfter(page.handles, hit)).toContain("root");
  });
});
