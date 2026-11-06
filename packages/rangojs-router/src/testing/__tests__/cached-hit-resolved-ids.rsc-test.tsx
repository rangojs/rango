/**
 * A stored HIT lists in `resolvedIds` every segment whose run it serves, as
 * the MISS that wrote the record did.
 *
 * `resolvedIds` tells the browser which runs' handle values to replace
 * (mergePartialHandleData, handles/pushed-by.ts). A live walk lists the
 * segments whose handler ran (`_handlerRan`, match-result.ts). A stored
 * segment carries no such marker: segment-codec.ts copies named fields only.
 * So a HIT listed only its live segments, and a segment served from a record
 * that pushed nothing kept the page's previous value: a chain layout's
 * breadcrumb cleared on a cache() MISS and came back on the HIT of the same
 * navigation. serveStoredSegments (match-middleware/cache-lookup.ts) decides
 * which stored segments it sends, so it marks those: the record's run stands
 * for the handler's, and the response carries its bucket (the restored one,
 * or none).
 *
 * The Prerender() bake serves through the same loop (decodeStoredEntry), so
 * it reports the same thing: a route segment re-sent from a bake that pushed
 * nothing clears the crumb the page carried.
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

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;
/** Whether the item route pushes its crumb on this request. */
let itemPushes = true;

const rootLayout = (ctx: HandlerContext): React.ReactNode => {
  ctx.use(Crumbs)("root");
  return <main>root</main>;
};

const chainLayout = (ctx: HandlerContext): React.ReactNode => {
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <section>chain</section>;
};

const pageA = (ctx: HandlerContext): React.ReactNode => {
  ctx.use(Crumbs)("a");
  return <p>a</p>;
};

const pageB = (ctx: HandlerContext): React.ReactNode => {
  ctx.use(Crumbs)("b");
  return <p>b</p>;
};

const itemPage = (ctx: HandlerContext<{ id: string }>): React.ReactNode => {
  if (itemPushes) ctx.use(Crumbs)(`item-${ctx.params.id}`);
  return <article>item</article>;
};

const prerenderedItemPage = (
  ctx: BuildContext<{ id: string }>,
): React.ReactNode => {
  if (itemPushes) ctx.use(Crumbs)(`item-${ctx.params.id}`);
  return <article>item</article>;
};

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }, { id: "2" }],
  prerenderedItemPage,
);

const modal = (ctx: HandlerContext): React.ReactNode => {
  ctx.use(Crumbs)("modal");
  return <dialog>modal</dialog>;
};

/** The same chain, with an intercept of /b that a stored record holds. */
function makeInterceptRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, cache, intercept }) => [
      cache({ ttl: 600 }, () => [
        layout(rootLayout, () => [
          layout(chainLayout, () => [
            path("/a", pageA, { name: "a" }),
            path("/b", pageB, { name: "b" }),
            intercept("@modal", ".b", modal),
          ]),
        ]),
      ]),
    ]),
  );
}

/**
 * The tree both cases share: a chain layout under a root layout, the chain's
 * entry carrying `revalidate(() => true)` so a navigation re-runs it.
 */
function makeRouter(kind: "cache" | "prerender") {
  return createRouter({}).routes(
    urls(({ path, layout, revalidate, cache }) => {
      const tree = () =>
        layout(rootLayout, () => [
          layout(chainLayout, () => [
            revalidate(() => true),
            path("/a", pageA, { name: "a" }),
            path("/b", pageB, { name: "b" }),
            kind === "prerender"
              ? path("/item/:id", PrerenderedItem, { name: "item" })
              : path("/item/:id", itemPage, { name: "item" }),
          ]),
        ]);
      return kind === "cache"
        ? [cache({ ttl: 600 }, () => [tree()])]
        : [tree()];
    }),
  );
}

/** The Flight, prelude and HTML text a response sends. */
function wireText(result: ServeShellRequestResult): string {
  return [result.flight, result.prelude, result.body]
    .filter(Boolean)
    .join("\n");
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

/** A document of `url`: its mounted ids, handle data and crumbs. */
async function documentOf(
  router: Router,
  url: string,
): Promise<{ matched: string[]; handles: HandleData; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
  );
  return {
    matched: answer.matched,
    handles,
    crumbs: collectHandleData(
      Crumbs,
      handles,
      filterSegmentOrder(answer.matched),
    ),
  };
}

beforeEach(async () => {
  chainPushes = true;
  itemPushes = true;
  await resetShellTestState();
});

describe("a cache() HIT lists the segments its record serves", () => {
  it("reports the resolvedIds its MISS reported", async () => {
    const router = makeRouter("cache");
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(router, "/a");
    const navigate = () =>
      serveShellRequest(router, "/b", {
        cacheStore,
        partial: { from: "/a", segments: page.matched },
      });

    // The chain layout re-runs and pushes nothing: its crumb clears.
    chainPushes = false;
    const miss = await readAnswer(await navigate());
    const hit = await readAnswer(await navigate());
    expect(miss.answer.resolvedIds?.length).toBeGreaterThan(0);
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
  });

  it("clears a chain layout's crumb on the HIT, as on the MISS", async () => {
    const router = makeRouter("cache");
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(router, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);

    chainPushes = false;
    const navigate = () =>
      serveShellRequest(router, "/b", {
        cacheStore,
        partial: { from: "/a", segments: page.matched },
      });
    expect(await crumbsAfter(page.handles, await navigate())).toEqual([
      "root",
      "b",
    ]);
    expect(await crumbsAfter(page.handles, await navigate())).toEqual([
      "root",
      "b",
    ]);
  });
});

describe("an intercept slot that re-runs", () => {
  it("is listed on the MISS and on the HIT, and the marker stays off the wire", async () => {
    const router = makeInterceptRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(router, "/a");
    const open = () =>
      serveShellRequest(router, "/b", {
        cacheStore,
        partial: {
          from: "/a",
          interceptSource: "/a",
          segments: page.matched,
        },
      });

    const missResult = await open();
    const hitResult = await open();
    const miss = await readAnswer(missResult);
    const hit = await readAnswer(hitResult);
    const slotId = miss.answer.matched.find((id) => id.includes(".@modal"));
    expect(slotId).toBeDefined();
    expect(miss.answer.resolvedIds).toContain(slotId);
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
    // The slot's segments are the pipeline's own objects, so the marker that
    // lists them must be stripped there too (match-result.ts
    // withoutHandlerRanInSlots).
    expect(wireText(missResult)).not.toContain("_handlerRan");
    expect(wireText(hitResult)).not.toContain("_handlerRan");
  });
});

describe("a Prerender() HIT lists the segments its bake serves", () => {
  it("clears the crumb of a re-sent route segment whose bake pushed nothing", async () => {
    const router = makeRouter("prerender");
    const page = await documentOf(router, "/item/1");
    expect(page.crumbs).toEqual(["root", "chain", "item-1"]);

    // The bake of /item/2 pushes no crumb of its own: its route segment is
    // sent (the params changed) and carries no values, so the page's crumb
    // for it goes.
    itemPushes = false;
    const hit = await serveShellRequest(router, "/item/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/item/1", segments: page.matched },
    });
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "chain"]);
  });
});
