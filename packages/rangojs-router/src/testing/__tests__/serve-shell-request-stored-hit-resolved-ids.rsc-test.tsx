/**
 * A stored HIT lists in `resolvedIds` every segment it re-sends, as the live
 * walk that wrote the record did. The browser replaces a run's handle values
 * only when the response delivers values of that run or lists it in
 * `resolvedIds` (mergePartialHandleData, handles/pushed-by.ts), so a HIT that
 * omits the runs it re-sends leaves their previous pushes on the page: a
 * breadcrumb a chain layout stops pushing stayed after a navigation that hit
 * a cache() record, and came back on every later HIT.
 *
 * The record cannot carry the marker (`serializeSegments` in
 * segment-codec.ts copies named fields only), and it does not have to: the
 * send rule that decides whether a stored segment is re-sent is the same
 * decision the live walk makes when it re-runs a handler, so
 * serveStoredSegments (router/match-middleware/cache-lookup.ts) marks each
 * segment it sends. A segment the client keeps is not sent and not marked:
 * it keeps the client's values, as on a live walk.
 *
 * Every source serves through that loop, so the same holds for a
 * Prerender() HIT and for a PPR navigation replay.
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
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { collectHandleData } from "../../handle.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb on this render. */
let chainPushes = true;

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  diff: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  return (await deserializeResult<{ metadata: Answer }>(result.flight!))
    .metadata;
}

/** The last handle state a response streamed. */
async function streamedHandles(
  result: ServeShellRequestResult,
): Promise<HandleData> {
  const { metadata } = await deserializeResult<{
    metadata: { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let last: HandleData = {};
  for await (const data of metadata.handles ?? []) last = data;
  return last;
}

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const answer = await answerOf(result);
  const order = filterSegmentOrder(answer.matched);
  return collectHandleData(
    Crumbs,
    mergePartialHandleData(
      current,
      await streamedHandles(result),
      order,
      answer.matched,
      answer.resolvedIds,
    ),
    order,
  );
}

/** A page's handle data and the ids it mounts. */
async function documentOf(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  cacheStore: MemorySegmentCacheStore,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const result = await serveShellRequest(router, url, { cacheStore });
  const answer = await answerOf(result);
  const handles = await streamedHandles(result);
  const order = filterSegmentOrder(answer.matched);
  return {
    handles,
    matched: answer.matched,
    crumbs: collectHandleData(Crumbs, handles, order),
  };
}

/**
 * A cache() record over two routes: a chrome layout the navigation keeps, and
 * a chain layout whose `revalidate(() => true)` re-sends it, as a page that
 * pushes a breadcrumb from its own data does.
 */
const cachedRouter = createRouter({}).routes(
  urls(({ path, cache, layout, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("chrome");
          return <header>chrome</header>;
        },
        () => [
          layout(
            (ctx: HandlerContext) => {
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <main>chain</main>;
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
        ],
      ),
    ]),
  ]),
);

beforeEach(async () => {
  chainPushes = true;
  await resetShellTestState();
});

describe("a cache() HIT lists the segments it re-sends", () => {
  it("the HIT's resolvedIds are the MISS's, and the crumb clears", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(cachedRouter, "/a", cacheStore);
    expect(page.crumbs).toEqual(["chrome", "chain", "a"]);
    chainPushes = false;
    const partial = { from: "/a", segments: page.matched };
    const miss = await serveShellRequest(cachedRouter, "/b", {
      cacheStore,
      partial,
    });
    const hit = await serveShellRequest(cachedRouter, "/b", {
      cacheStore,
      partial,
    });
    const missAnswer = await answerOf(miss);
    const hitAnswer = await answerOf(hit);
    // The chain layout re-ran and pushed nothing: the response replaces its
    // values with nothing, so the crumb clears.
    expect(await crumbsAfter(page.handles, miss)).toEqual(["chrome", "b"]);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    expect(await crumbsAfter(page.handles, hit)).toEqual(["chrome", "b"]);
    // The marker behind the list is internal: the payload carries the ids.
    expect(hit.body).not.toContain("_handlerRan");
  });

  it("a segment the client keeps is not listed, and keeps the client's crumb", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(cachedRouter, "/a", cacheStore);
    const partial = { from: "/a", segments: page.matched };
    // The chain layout pushes again, so its crumb is in the record: a
    // response that listed it would replace the client's value with the
    // record's, which is the same here; the chrome layout's crumb is the one
    // only the client holds.
    chainPushes = true;
    const hit = await serveShellRequest(cachedRouter, "/b", {
      cacheStore,
      partial,
    });
    const answer = await answerOf(hit);
    const kept = answer.matched.filter((id) => !answer.diff.includes(id));
    expect(kept.length).toBeGreaterThan(0);
    for (const id of kept) expect(answer.resolvedIds).not.toContain(id);
    expect(await crumbsAfter(page.handles, hit)).toEqual([
      "chrome",
      "chain",
      "b",
    ]);
  });
});

/** A handler and a loader rendered live and baked by Prerender(). */
const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("chrome");
        return <header>chrome</header>;
      },
      () => [
        revalidate(() => true),
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path(
          "/live/:id",
          (ctx: HandlerContext<{ id: string }>) => {
            ctx.use(Crumbs)("twin");
            return <p>live</p>;
          },
          { name: "live" },
        ),
        path(
          "/baked/:id",
          Prerender(
            async () => [{ id: "1" }],
            (ctx) => {
              ctx.use(Crumbs)("twin");
              return <p>baked</p>;
            },
          ),
          { name: "baked" },
        ),
      ],
    ),
  ]),
);

describe("a Prerender() HIT lists the segments it re-sends", () => {
  it("every segment the HIT sends is listed, as a live render lists its own", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(prerenderRouter, "/list", cacheStore);
    const partial = { from: "/list", segments: page.matched };
    const live = await answerOf(
      await serveShellRequest(prerenderRouter, "/live/1", {
        cacheStore,
        partial,
      }),
    );
    const baked = await answerOf(
      await serveShellRequest(prerenderRouter, "/baked/1", {
        cacheStore,
        partial,
      }),
    );
    // The control: a live partial lists every segment it sends.
    expect(live.diff.filter((id) => !live.resolvedIds?.includes(id))).toEqual(
      [],
    );
    expect(baked.diff.filter((id) => !baked.resolvedIds?.includes(id))).toEqual(
      [],
    );
    // The bake's chain layout re-sent and its route rendered: both listed.
    expect(baked.resolvedIds).toHaveLength(baked.diff.length);
  });
});

/** Two `ppr` routes under a chain layout that re-sends on every navigation. */
const pprRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("chrome");
        return <header>chrome</header>;
      },
      () => [
        layout(
          (ctx: HandlerContext) => {
            if (chainPushes) ctx.use(Crumbs)("chain");
            return <main>chain</main>;
          },
          () => [
            revalidate(() => true),
            path(
              "/list",
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("list");
                return <ul>list</ul>;
              },
              { name: "list", ppr: true },
            ),
            path(
              "/item/:id",
              (ctx: HandlerContext<{ id: string }>) => {
                ctx.use(Crumbs)("item");
                return <p>item</p>;
              },
              { name: "item", ppr: true },
            ),
          ],
        ),
      ],
    ),
  ]),
);

const TOUCH_ACTION = "src/stored-hit.actions.ts#touch";
async function touch(): Promise<void> {}

/** An on-demand Prerender route, served from the overlay a refresh writes. */
function onDemandRouter(withStore: boolean) {
  return createRouter({
    ...(withStore
      ? { prerender: { store: createMemoryPrerenderStore() } }
      : {}),
  }).routes(
    urls(({ path, layout, revalidate }) => [
      layout(
        (ctx: HandlerContext) => {
          if (chainPushes) ctx.use(Crumbs)("chain");
          return <main>chain</main>;
        },
        () => [
          revalidate(() => true),
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path(
            "/article/:slug",
            Prerender<{ slug: string }>(
              async () => [],
              (ctx) => {
                if (chainPushes) ctx.use(Crumbs)("article");
                return <h1>{ctx.params.slug}</h1>;
              },
              { onDemand: true },
            ),
            { name: "article" },
          ),
        ],
      ),
    ]),
  );
}

describe("an on-demand prerender overlay lists the segments it re-sends", () => {
  it("an action's re-send of the route is listed, the kept layout is not", async () => {
    const router = onDemandRouter(true);
    const page = await documentOf(
      router,
      "/list",
      new MemorySegmentCacheStore(),
    );
    // The refresh's render, with the chain layout pushing: the entry holds
    // the article's values.
    const written = await router.prerender({ env: {} })("/article/intro");
    expect(written).toMatchObject({ ok: true, status: "rendered" });
    chainPushes = false;
    const action = await serveShellRequest(router, "/article/intro", {
      action: { ref: touch, id: TOUCH_ACTION, segments: page.matched },
    });
    const answer = await answerOf(action);
    // The action re-sends the route from the entry, and keeps the layout
    // above it (equal params: its rules do not run, as for a bake).
    expect(answer.diff).toHaveLength(1);
    expect(
      answer.diff.filter((id) => !answer.resolvedIds?.includes(id)),
    ).toEqual([]);
    const kept = answer.matched.filter((id) => !answer.diff.includes(id));
    for (const id of kept) expect(answer.resolvedIds).not.toContain(id);
  });
});

describe("a PPR navigation replay lists the segments it re-sends", () => {
  it("the replay HIT's resolvedIds are the live partial's", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await documentOf(pprRouter, "/list", cacheStore);
    expect(page.crumbs).toEqual(["chrome", "chain", "list"]);
    chainPushes = false;
    const partial = { from: "/list", segments: page.matched };
    const live = await serveShellRequest(pprRouter, "/item/1", {
      cacheStore,
      partial,
    });
    const replay = await serveShellRequest(pprRouter, "/item/1", {
      cacheStore,
      partial,
    });
    expect(live.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    expect(replay.replayStatus?.outcome).toBe("HIT");
    const liveAnswer = await answerOf(live);
    const replayAnswer = await answerOf(replay);
    expect(replayAnswer.resolvedIds).toEqual(liveAnswer.resolvedIds);
    expect(await crumbsAfter(page.handles, live)).toEqual(["chrome", "item"]);
    expect(await crumbsAfter(page.handles, replay)).toEqual(["chrome", "item"]);
  });
});
