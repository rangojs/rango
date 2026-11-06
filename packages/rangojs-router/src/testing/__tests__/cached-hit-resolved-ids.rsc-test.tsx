/**
 * A stored hit (a cache() record, a Prerender() entry) lists the segments it
 * sends in `resolvedIds`, as the live render that wrote the record does. A
 * record stores no `_handlerRan` (segment-codec.ts serializeSegments copies
 * named fields), so a stored segment a hit sent was never named: the browser's
 * merge (mergePartialHandleData, handles/pushed-by.ts) kept the page's values
 * for a run the response had replaced, and a breadcrumb a handler cleared came
 * back on the next hit of the same page.
 *
 * The record needs no such field: both write paths render every stored
 * segment's handler (a direct write has no null component among the covered
 * segments; a proactive one re-renders the whole tree — cache-store.ts), so
 * "the record's render ran it" holds for all of them and is no data. What a
 * response decides is only which segments it sends, and those are the ones
 * whose handle values it replaces.
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
let chainPushes = true;
let chainRuns = 0;

const router = createRouter({}).routes(
  urls(({ path, layout, cache, parallel, intercept, revalidate }) => [
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
              parallel({
                "@side": (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("side");
                  return <nav>side</nav>;
                },
              }),
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
              path(
                "/item/:id",
                (ctx: HandlerContext<{ id: string }>) => {
                  ctx.use(Crumbs)(`item-${ctx.params.id}`);
                  return <article>item</article>;
                },
                { name: "item" },
                () => [
                  intercept("@modal", ".item", (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("modal");
                    return <dialog>modal</dialog>;
                  }),
                ],
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
  segments: { id: string; type: string }[];
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

/** The ids of the non-loader segments a response sends. */
function sentIds(answer: Answer): string[] {
  return answer.segments.filter((s) => s.type !== "loader").map((s) => s.id);
}

/** The runs a response names, its fresh loader runs left out. */
function namedRuns(answer: Answer): string[] {
  return (answer.resolvedIds ?? []).filter(
    (id) => !answer.segments.some((s) => s.id === id && s.type === "loader"),
  );
}

/** The document of `url`, with every handler pushing its breadcrumb. */
async function documentOf(url: string): Promise<{
  handles: HandleData;
  matched: string[];
  crumbs: string[];
  answer: Answer;
}> {
  chainPushes = true;
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const { answer, handles } = await readAnswer(result);
  return {
    handles,
    matched: answer.matched,
    crumbs: collectHandleData(
      Crumbs,
      handles,
      filterSegmentOrder(answer.matched),
    ),
    answer,
  };
}

beforeEach(async () => {
  chainPushes = true;
  chainRuns = 0;
  await resetShellTestState();
});

describe("a cache() HIT lists the runs whose values it replaces", () => {
  it("a re-run layout that pushes nothing clears its breadcrumb on the MISS and keeps it cleared on the HIT", async () => {
    const page = await documentOf("/a");
    expect(page.crumbs).toEqual(["root", "chain", "side", "a"]);
    const partial = { from: "/a", segments: page.matched };
    const cacheStore = new MemorySegmentCacheStore();

    chainPushes = false;
    chainRuns = 0;
    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    const missAnswer = (await readAnswer(miss)).answer;
    expect(chainRuns).toBeGreaterThan(0);
    expect(await crumbsAfter(page.handles, miss)).toEqual([
      "root",
      "side",
      "b",
    ]);

    chainPushes = false;
    chainRuns = 0;
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const hitAnswer = (await readAnswer(hit)).answer;
    // Served from the record: no handler ran.
    expect(chainRuns).toBe(0);
    // The HIT replaces the same runs as the MISS that wrote the record.
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "side", "b"]);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
  });

  it("the HIT names the stored layout and the route it re-rendered", async () => {
    const page = await documentOf("/a");
    const partial = { from: "/a", segments: page.matched };
    const cacheStore = new MemorySegmentCacheStore();
    chainPushes = false;

    const miss = (
      await readAnswer(
        await serveShellRequest(router, "/b", { cacheStore, partial }),
      )
    ).answer;
    const hit = (
      await readAnswer(
        await serveShellRequest(router, "/b", { cacheStore, partial }),
      )
    ).answer;

    const layoutIds = page.answer.segments
      .filter((s) => s.type === "layout")
      .map((s) => s.id);
    const chainId = layoutIds[layoutIds.length - 1]!;
    expect(hit.resolvedIds).toHaveLength(2);
    expect(hit.resolvedIds![0]).toBe(chainId);
    // The second is the /b route the response re-rendered.
    expect(
      hit.segments.some(
        (s) => s.id === hit.resolvedIds![1] && s.type === "route",
      ),
    ).toBe(true);
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
    // A kept segment is not named: the client's values stand.
    expect(hit.resolvedIds).not.toContain(page.matched[0]);
  });

  it("an intercept opened from the record names the slot it sends", async () => {
    const page = await documentOf("/a");
    const partial = {
      from: "/a",
      interceptSource: "/a",
      segments: page.matched,
    };
    const cacheStore = new MemorySegmentCacheStore();

    const miss = (
      await readAnswer(
        await serveShellRequest(router, "/item/1", { cacheStore, partial }),
      )
    ).answer;
    const hit = (
      await readAnswer(
        await serveShellRequest(router, "/item/1", { cacheStore, partial }),
      )
    ).answer;

    // The intercept's variant of the item route and the chain layout
    // (revalidate() true) are what the record re-sends.
    expect(sentIds(hit)).toHaveLength(2);
    expect(namedRuns(hit)).toEqual(sentIds(hit));
    expect(hit.resolvedIds).toEqual(miss.resolvedIds);
  });
});

const prerendered = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("chrome");
        return <main>chrome</main>;
      },
      () => [
        path(
          "/p/:id",
          Prerender(
            async () => [{ id: "1" }, { id: "2" }],
            (ctx: BuildContext<{ id: string }>) => {
              ctx.use(Crumbs)(`p-${ctx.params.id}`);
              return <p>pre</p>;
            },
          ),
          { name: "p" },
          () => [revalidate(() => true)],
        ),
        path(
          "/q/:id",
          (ctx: HandlerContext<{ id: string }>) => {
            ctx.use(Crumbs)(`q-${ctx.params.id}`);
            return <p>q</p>;
          },
          { name: "q" },
        ),
      ],
    ),
  ]),
);

describe("a Prerender() HIT lists the runs whose values it replaces", () => {
  it("a params change names the stored route it sends", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await readAnswer(
      await serveShellRequest(prerendered, "/p/1", { cacheStore }),
    );
    const partial = { from: "/p/1", segments: doc.answer.matched };

    const hit = (
      await readAnswer(
        await serveShellRequest(prerendered, "/p/2", { cacheStore, partial }),
      )
    ).answer;
    expect(sentIds(hit)).toHaveLength(1);
    expect(namedRuns(hit)).toEqual(sentIds(hit));
  });
});
