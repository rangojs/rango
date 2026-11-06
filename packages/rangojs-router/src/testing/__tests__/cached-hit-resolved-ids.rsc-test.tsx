/**
 * A cache() HIT lists the segments it sends in `resolvedIds`, as the MISS
 * that wrote the record did, so the browser replaces their handle values
 * instead of keeping the ones from before the navigation.
 *
 * The browser merges a partial response run by run
 * (`mergePartialHandleData`, handles/pushed-by.ts): a run's old values give
 * way only when the response delivers values of that run or lists it in
 * `resolvedIds`. A live walk marks the segments whose handler ran
 * (`_handlerRan`, segment-resolution/revalidation.ts), which is how a
 * breadcrumb that clears on a MISS clears. A stored record does not carry
 * that marker (segment-codec.ts `serializeSegments` copies named fields
 * only), so a HIT listed none of the segments it re-sent: a chain layout
 * whose `revalidate()` re-sends it kept its crumb from the page before, and
 * the breadcrumb came back on the HIT.
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

/** Whether the chain layout pushes on this request. */
let chainPushes = true;

const router = createRouter({}).routes(
  urls(({ path, cache, layout, parallel, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>shell</main>;
        },
        () => [
          layout(
            (ctx: HandlerContext) => {
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [
              revalidate(() => true),
              // A slot of its own rule: re-sent on the HIT like the layout.
              parallel({ "@side": () => <nav>side</nav> }, () => [
                revalidate(() => true),
              ]),
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
          // Kept on a HIT: its rule says no, so it is not sent and must not
          // be listed.
          layout(
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("kept-layout");
              return <div>kept</div>;
            },
            () => [
              revalidate(() => false),
              path(
                "/kept",
                (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("kept");
                  return <p>kept</p>;
                },
                { name: "kept" },
              ),
              path(
                "/kept-again",
                (ctx: HandlerContext) => {
                  ctx.use(Crumbs)("kept-again");
                  return <p>kept again</p>;
                },
                { name: "keptAgain" },
              ),
            ],
          ),
        ],
      ),
    ]),
  ]),
);

interface Answer {
  matched: string[];
  diff: string[];
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

/** A document of `url`, and the store its record was written to. */
async function documentOf(url: string): Promise<{
  handles: HandleData;
  matched: string[];
  store: MemorySegmentCacheStore;
}> {
  const store = new MemorySegmentCacheStore();
  const result = await serveShellRequest(router, url, { cacheStore: store });
  const { answer, handles } = await readAnswer(result);
  return { handles, matched: answer.matched, store };
}

/** One navigation, served twice on one store: its MISS, then its HIT. */
async function missThenHit(
  url: string,
  partial: NonNullable<ServeShellRequestOptions["partial"]>,
  store: MemorySegmentCacheStore,
): Promise<{ miss: ServeShellRequestResult; hit: ServeShellRequestResult }> {
  return {
    miss: await serveShellRequest(router, url, { cacheStore: store, partial }),
    hit: await serveShellRequest(router, url, { cacheStore: store, partial }),
  };
}

beforeEach(async () => {
  chainPushes = true;
  await resetShellTestState();
});

describe("a cache() HIT lists the segments it sends", () => {
  it("a chain layout that re-runs and pushes nothing clears its crumb on the HIT, as on the MISS", async () => {
    const page = await documentOf("/a");
    const { handles, matched } = page;
    expect(
      await crumbsAfter(
        handles,
        await serveShellRequest(router, "/a", { cacheStore: page.store }),
      ),
    ).toEqual(["root", "chain", "a"]);

    chainPushes = false;
    const { miss, hit } = await missThenHit(
      "/b",
      { from: "/a", segments: matched },
      page.store,
    );
    expect(await crumbsAfter(handles, miss)).toEqual(["root", "b"]);
    expect(await crumbsAfter(handles, hit)).toEqual(["root", "b"]);
  });

  it("the HIT reports the resolvedIds of the MISS that wrote the record", async () => {
    const page = await documentOf("/a");
    chainPushes = false;
    const { miss, hit } = await missThenHit(
      "/b",
      { from: "/a", segments: page.matched },
      page.store,
    );
    const missAnswer = (await readAnswer(miss)).answer;
    const hitAnswer = (await readAnswer(hit)).answer;
    expect(missAnswer.resolvedIds?.length).toBeGreaterThan(0);
    // A parallel slot the HIT re-sends is listed too, as its MISS listed it.
    expect(missAnswer.resolvedIds?.some((id) => id.endsWith(".@side"))).toBe(
      true,
    );
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
  });

  it("a segment the HIT keeps is not listed", async () => {
    const page = await documentOf("/kept");
    const { miss, hit } = await missThenHit(
      "/kept-again",
      { from: "/kept", segments: page.matched },
      page.store,
    );
    const missAnswer = (await readAnswer(miss)).answer;
    const hitAnswer = (await readAnswer(hit)).answer;
    // The kept layout's rule said no: neither side re-sends it, so neither
    // lists it. The route under it is new to the page on both.
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    expect(missAnswer.resolvedIds?.filter((id) => id.endsWith("L1"))).toEqual(
      [],
    );
    expect(await crumbsAfter(page.handles, hit)).toEqual([
      "root",
      "kept-layout",
      "kept-again",
    ]);
  });
});
