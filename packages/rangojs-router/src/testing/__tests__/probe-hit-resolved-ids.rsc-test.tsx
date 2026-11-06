/** Throwaway probe: resolvedIds on a cache() MISS vs its HIT. */
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
  urls,
  type HandlerContext,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import { collectHandleData } from "../../handle.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

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
              ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [
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
              revalidate(() => true),
            ],
          ),
        ],
      ),
    ]),
  ]),
);

async function answer(
  result: ServeShellRequestResult,
): Promise<{ matched: string[]; resolvedIds?: string[]; diff: string[] }> {
  const { metadata } = await deserializeResult<any>(result.flight!);
  return {
    matched: metadata.matched,
    resolvedIds: metadata.resolvedIds,
    diff: metadata.diff,
  };
}

async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const handles = await result.readHandles();
  return (handles?.late.at(-1) ?? handles?.hydration ?? {}) as HandleData;
}

beforeEach(async () => {
  await resetShellTestState();
});

describe("probe", () => {
  it("navigation MISS then HIT, empty store", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: [] },
    });
    const hit = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: [] },
    });
    console.log("nav miss", JSON.stringify(await answer(miss)));
    console.log("nav hit ", JSON.stringify(await answer(hit)));
    console.log("nav hit handles", JSON.stringify(await handlesOf(hit)));
    expect({}).toEqual({ probe: "see below" });
  });

  it("document then navigation holding the page", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await serveShellRequest(router, "/a", { cacheStore });
    const docMeta = await answer(doc);
    const docHandles = await handlesOf(doc);
    console.log("doc", JSON.stringify(docMeta));
    console.log("doc crumbs", JSON.stringify(collectHandleData(Crumbs, docHandles, filterSegmentOrder(docMeta.matched))));
    const miss = await serveShellRequest(router, "/a?v=1", {
      cacheStore,
      partial: { from: "/a", segments: docMeta.matched },
    });
    const hit = await serveShellRequest(router, "/a?v=1", {
      cacheStore,
      partial: { from: "/a", segments: docMeta.matched },
    });
    console.log("held miss", JSON.stringify(await answer(miss)));
    console.log("held hit ", JSON.stringify(await answer(hit)));
    expect({}).toEqual({ probe: "see below" });
  });

  it("breadcrumb that clears on a MISS and comes back on a HIT", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await serveShellRequest(router, "/a", { cacheStore });
    const docMeta = await answer(doc);
    const pageHandles = await handlesOf(doc);
    const order = filterSegmentOrder(docMeta.matched);
    const crumbs = (data: HandleData): string[] =>
      collectHandleData(Crumbs, data, order);
    console.log("page crumbs", JSON.stringify(crumbs(pageHandles)));
    const miss = await serveShellRequest(router, "/a?v=1", {
      cacheStore,
      partial: { from: "/a", segments: docMeta.matched },
    });
    const missAnswer = await answer(miss);
    const missMerged = mergePartialHandleData(
      pageHandles,
      await handlesOf(miss),
      order,
      missAnswer.matched,
      missAnswer.resolvedIds,
    );
    console.log("nav1 crumbs", JSON.stringify(crumbs(missMerged)), JSON.stringify(missAnswer.resolvedIds));
    const hit = await serveShellRequest(router, "/a?v=1", {
      cacheStore,
      partial: { from: "/a", segments: docMeta.matched },
    });
    const hitAnswer = await answer(hit);
    const hitMerged = mergePartialHandleData(
      missMerged,
      await handlesOf(hit),
      order,
      hitAnswer.matched,
      hitAnswer.resolvedIds,
    );
    console.log("nav2 crumbs", JSON.stringify(crumbs(hitMerged)), JSON.stringify(hitAnswer.resolvedIds));
    expect({}).toEqual({ probe: "see below" });
  });
});
