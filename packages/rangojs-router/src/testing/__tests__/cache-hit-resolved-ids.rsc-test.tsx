/**
 * A stored answer reports the same `resolvedIds` as the live render it stands
 * in for, so the browser's handle merge keeps the same values.
 *
 * `resolvedIds` names the runs (a segment's handler, a loader registered on
 * it) whose handle values the browser replaces with the response's
 * (`mergePartialHandleData`, handles/pushed-by.ts): a run in it that the
 * response carries no values for is cleared. The live walk lists a segment
 * whose handler re-ran (`_handlerRan`, segment-resolution/revalidation.ts). A
 * record does not carry that marker (`serializeSegments` copies named fields,
 * cache/segment-codec.ts), and the cache lookup sent its segments without it,
 * so a HIT omitted a segment it re-sent from the record: the breadcrumb a
 * chain layout no longer pushes cleared on a MISS and stayed on a HIT.
 *
 * A stored segment the response sends stands in for a run of its handler — its
 * values are the record's, or none — so `serveStoredSegments`
 * (match-middleware/cache-lookup.ts) marks it as run, exactly as a re-run
 * handler's is marked. A segment it keeps stays unmarked: the browser keeps
 * that segment's values, as on a live walk.
 *
 * Every source that serves there is covered, since each one reaches the
 * browser as a different kind of request: a route's `cache()` record (a
 * navigation, a prefetch, a fill), a `Prerender()` bake, an on-demand
 * `Prerender()` overlay entry, and a `ppr` route's shell doc record, which a
 * navigation replay reads as a record under the shell's key.
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
import { createMemoryPrerenderStore } from "../index.js";
import {
  createHandle,
  createLoader,
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

const ORIGIN = "http://localhost";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb: a record keeps what it pushed. */
let chainPushes = true;
/** The same, for the layout above the prerendered route. */
let prerenderPushes = true;
/** The same, for the layout above the ppr route. */
let pprPushes = true;
/** The same, for the layout above the on-demand route. */
let onDemandPushes = true;
/**
 * Route handlers that ran, by crumb. A request served from a record runs none
 * of them: the table below asserts its "miss" really rendered live, so a row
 * whose first request is already a HIT cannot pass.
 */
let handlerRuns: string[] = [];

const PageData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("page-loader");
  return { page: true };
});

const router = createRouter({}).routes(
  urls(({ path, cache, layout, loader }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        cache({ ttl: 600 }, () => [
          layout(
            (ctx: HandlerContext) => {
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [revalidate(() => true)],
          ),
          path(
            "/a",
            (ctx: HandlerContext) => {
              handlerRuns.push("a");
              ctx.use(Crumbs)("a");
              return <p>a</p>;
            },
            { name: "a" },
            () => [loader(PageData)],
          ),
          path(
            "/b",
            (ctx: HandlerContext) => {
              handlerRuns.push("b");
              ctx.use(Crumbs)("b");
              return <p>b</p>;
            },
            { name: "b" },
          ),
        ]),
        layout(
          (ctx: HandlerContext) => {
            if (prerenderPushes) ctx.use(Crumbs)("pr-root");
            return <div>pr</div>;
          },
          () => [
            revalidate(() => true),
            path(
              "/pr/:id",
              Prerender<{ id: string }>(
                async () => [{ id: "1" }, { id: "2" }],
                (ctx) => <article>{`pr:${ctx.params.id}`}</article>,
              ),
              { name: "pr" },
            ),
          ],
        ),
        layout(
          (ctx: HandlerContext) => {
            if (pprPushes) ctx.use(Crumbs)("ppr-chain");
            return <div>ppr</div>;
          },
          () => [
            revalidate(() => true),
            path(
              "/ppr/:id",
              (ctx: HandlerContext<{ id: string }>) => {
                ctx.use(Crumbs)(`page-${ctx.params.id}`);
                return <p>{ctx.params.id}</p>;
              },
              { name: "ppr", ppr: true },
            ),
          ],
        ),
      ],
    ),
  ]),
);

/**
 * A second router for the on-demand Prerender overlay: its entries are written
 * by `router.prerender()`, not baked with the URL, so the route's param sets
 * need a warm before they serve.
 */
const onDemandRouter = createRouter({
  prerender: { store: createMemoryPrerenderStore() },
}).routes(
  urls(({ path, layout }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        layout(
          (ctx: HandlerContext) => {
            if (onDemandPushes) ctx.use(Crumbs)("od-chain");
            return <section>od</section>;
          },
          () => [
            revalidate(() => true),
            path(
              "/od/:id",
              Prerender<{ id: string }>(
                async () => [{ id: "1" }, { id: "2" }],
                (ctx) => <article>{`od:${ctx.params.id}`}</article>,
                { onDemand: true },
              ),
              { name: "od" },
            ),
          ],
        ),
      ],
    ),
  ]),
);

interface Answer {
  matched: string[];
  resolvedIds?: string[];
}

/** A response's metadata and the last handle state it streamed. */
async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData }> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  let handles: HandleData = {};
  for await (const data of (metadata as any).handles ?? []) handles = data;
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

/**
 * A document of `url` from a cold store: what the client holds on it. A store
 * given here is the one the page's shell entry is written to, for a page a
 * later navigation replays.
 */
async function pageOf(
  url: string,
  cacheStore: MemorySegmentCacheStore = new MemorySegmentCacheStore(),
  served: Parameters<typeof serveShellRequest>[0] = router,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(served, url, { cacheStore }),
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

/**
 * A store holding `/a`'s record, written by a render whose chain layout pushed
 * (or did not push) its crumb.
 */
async function recordOfA(pushes: boolean): Promise<MemorySegmentCacheStore> {
  const cacheStore = new MemorySegmentCacheStore();
  chainPushes = pushes;
  await serveShellRequest(router, "/a", {
    cacheStore,
    partial: { from: "/b", segments: [] },
  });
  chainPushes = true;
  return cacheStore;
}

beforeEach(async () => {
  chainPushes = true;
  prerenderPushes = true;
  pprPushes = true;
  onDemandPushes = true;
  handlerRuns = [];
  await resetShellTestState();
});

describe("a partial response's resolvedIds names what its record replaces", () => {
  it("clears a crumb the record does not carry, as the MISS does", async () => {
    const cacheStore = await recordOfA(false);
    const from = await pageOf("/b");
    expect(from.crumbs).toEqual(["root", "chain", "b"]);

    const hit = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: from.matched },
    });
    chainPushes = false;
    const miss = await serveShellRequest(router, "/a", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/b", segments: from.matched },
    });

    expect(await crumbsAfter(from.handles, miss)).toEqual([
      "root",
      "page-loader",
      "a",
    ]);
    expect(await crumbsAfter(from.handles, hit)).toEqual([
      "root",
      "page-loader",
      "a",
    ]);
  });

  it("shows a crumb the record carries, where a live render pushes none", async () => {
    const cacheStore = await recordOfA(true);
    chainPushes = false;
    const from = await pageOf("/b");
    expect(from.crumbs).toEqual(["root", "b"]);

    const hit = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: from.matched },
    });
    const miss = await serveShellRequest(router, "/a", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/b", segments: from.matched },
    });

    expect(await crumbsAfter(from.handles, miss)).toEqual([
      "root",
      "page-loader",
      "a",
    ]);
    expect(await crumbsAfter(from.handles, hit)).toEqual([
      "root",
      "chain",
      "page-loader",
      "a",
    ]);
  });

  it("clears a crumb a Prerender() entry re-sent for new params does not carry", async () => {
    // The entry for /pr/1 bakes while its layout pushes nothing.
    prerenderPushes = false;
    const cold = new MemorySegmentCacheStore();
    await serveShellRequest(router, "/pr/1", { cacheStore: cold });
    // The page the client leaves carries the crumb.
    prerenderPushes = true;
    const from = await pageOf("/pr/2");
    expect(from.crumbs).toEqual(["root", "pr-root"]);

    const hit = await serveShellRequest(router, "/pr/1", {
      cacheStore: cold,
      partial: { from: "/pr/2", segments: from.matched },
    });
    expect(await crumbsAfter(from.handles, hit)).toEqual(["root"]);
  });

  it("lists nothing for a Prerender() entry it keeps on equal params", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const from = await readAnswer(
      await serveShellRequest(router, "/pr/1", { cacheStore }),
    );
    const kept = await readAnswer(
      await serveShellRequest(router, "/pr/1", {
        cacheStore,
        partial: { from: "/pr/1", segments: from.answer.matched },
      }),
    );
    expect(kept.answer.resolvedIds).toEqual([]);
  });

  it("clears a crumb a PPR shell record does not carry, on a navigation replay", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    // The shell entry for /ppr/1 is captured while its layout pushes nothing.
    pprPushes = false;
    await serveShellRequest(router, "/ppr/1", { cacheStore });
    // The page the client leaves carries the crumb.
    pprPushes = true;
    const from = await pageOf("/ppr/2", cacheStore);
    expect(from.crumbs).toEqual(["root", "ppr-chain", "page-2"]);

    pprPushes = false;
    const nav = await serveShellRequest(router, "/ppr/1", {
      cacheStore,
      partial: { from: "/ppr/2", segments: from.matched },
    });
    // The doc record answers: the handler layer is replayed, not run.
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(await crumbsAfter(from.handles, nav)).toEqual(["root", "page-1"]);
  });

  it("clears a crumb an on-demand Prerender() overlay entry does not carry", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    // /od/1's entry is written while its layout pushes nothing.
    onDemandPushes = false;
    await onDemandRouter.prerender({ env: {} })(`${ORIGIN}/od/1`);
    onDemandPushes = true;
    await onDemandRouter.prerender({ env: {} })(`${ORIGIN}/od/2`);
    const from = await pageOf("/od/2", cacheStore, onDemandRouter);
    expect(from.crumbs).toEqual(["root", "od-chain"]);

    onDemandPushes = false;
    const nav = await serveShellRequest(onDemandRouter, "/od/1", {
      cacheStore,
      partial: { from: "/od/2", segments: from.matched },
    });
    expect(await crumbsAfter(from.handles, nav)).toEqual(["root"]);
  });

  it("leaks no internal marker to the client", async () => {
    const cacheStore = await recordOfA(false);
    const from = await pageOf("/b");
    const hit = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: from.matched },
    });
    expect(hit.flight).not.toContain("_handlerRan");
  });
});

/** How the client asks: the shapes a partial response is served for. */
interface Shape {
  name: string;
  url: string;
  from: string;
  request: (
    held: readonly string[],
  ) => Omit<ServeShellRequestOptions, "cacheStore">;
}

const SHAPES: readonly Shape[] = [
  {
    name: "a navigation holding the page",
    url: "/a",
    from: "/b",
    request: (held) => ({ partial: { from: "/b", segments: held } }),
  },
  {
    name: "a navigation holding nothing",
    url: "/a",
    from: "/b",
    request: () => ({ partial: { from: "/b", segments: [] } }),
  },
  {
    name: "a prefetch",
    url: "/a",
    from: "/b",
    request: () => ({ partial: { from: "/b", segments: [], prefetch: true } }),
  },
];

// Rows only where the first request renders live and the second reads the
// record. A fill reads none (a fill renders what the client misses), and a
// Prerender() artifact is baked for its URL, so the request is served from it
// even the first time: in both, the two requests would be the same kind and
// the row would pass without the fix. The tests above cover the bake's HIT.

describe("a stored answer lists what it sends, as the live render lists what it ran", () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      const cacheStore = new MemorySegmentCacheStore();
      const from = await readAnswer(
        await serveShellRequest(router, shape.from, { cacheStore }),
      );
      const request = shape.request(from.answer.matched);
      handlerRuns = [];
      const miss = await readAnswer(
        await serveShellRequest(router, shape.url, { cacheStore, ...request }),
      );
      // The row compares a MISS with the HIT that follows it: the first
      // request must have rendered the page live, or the two would be two
      // HITs and the row would pass without the fix.
      expect(handlerRuns).not.toEqual([]);
      handlerRuns = [];
      const hit = await readAnswer(
        await serveShellRequest(router, shape.url, { cacheStore, ...request }),
      );
      expect(handlerRuns).toEqual([]);
      // The browser reads the list as a set (handles/pushed-by.ts); a HIT
      // yields the record before the loaders it resolves, so only membership
      // is the contract.
      expect([...(hit.answer.resolvedIds ?? [])].sort()).toEqual(
        [...(miss.answer.resolvedIds ?? [])].sort(),
      );
    });
  }
});
