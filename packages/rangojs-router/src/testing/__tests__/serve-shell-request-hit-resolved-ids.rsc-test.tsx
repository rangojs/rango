/**
 * A stored HIT lists in `resolvedIds` every segment it sends, as the live
 * render of the same navigation does.
 *
 * The browser replaces a run's handle values only when the response delivers
 * values of that run or names it in `resolvedIds` (mergePartialHandleData,
 * handles/pushed-by.ts). A live partial pass names each segment it re-renders
 * (`_handlerRan`, segment-resolution/revalidation.ts resolveEntryHandler), so
 * a handler that re-ran and pushed nothing clears the value it pushed before:
 * a breadcrumb. A stored record carries no `_handlerRan` (segment-codec.ts
 * serializeSegments copies named fields), so a cache() or Prerender() HIT
 * named no segment at all and the page kept every value from before the
 * navigation: the crumb a live render clears came back on the HIT.
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
import type { ResolvedSegment } from "../../types.js";

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;

/** The chain layout's handler: one push, or none. */
function chainHandler(ctx: HandlerContext): React.ReactNode {
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <section>chain</section>;
}

/** The router's root layout: it pushes once and is never re-run here. */
function rootHandler(ctx: HandlerContext): React.ReactNode {
  ctx.use(Crumbs)("root");
  return <main>root</main>;
}

const BakedItem = Prerender(
  async () => [{ id: "1" }],
  (ctx) => {
    ctx.use(Crumbs)("baked-1");
    return <article>baked 1</article>;
  },
);

/** Where the navigation's answer comes from. */
type Shape = "cache" | "prerender";

function makeRouter(shape: Shape, chainRevalidates = true) {
  return createRouter({}).routes(
    urls(({ path, cache, layout, revalidate }) => {
      // Built inside each container's body: a node created outside it lands
      // on the parent instead, and the container is dropped (a cache() with
      // no children is no entry at all).
      const chain = () =>
        layout(chainHandler, () => [
          ...(chainRevalidates ? [revalidate(() => true)] : []),
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
          ...(shape === "prerender"
            ? [path("/baked/:id", BakedItem, { name: "baked" })]
            : []),
        ]);
      const routes = () => layout(rootHandler, () => [chain()]);
      return shape === "cache"
        ? [cache({ ttl: 600 }, () => [routes()])]
        : [routes()];
    }),
  );
}

/** A ppr route under the chain layout: a navigation replay serves its doc record. */
function makePprRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, revalidate }) => [
      layout(chainHandler, () => [
        revalidate(() => true),
        path(
          "/list",
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)(`list-${ctx.searchParams.get("page") ?? "1"}`);
            return <ul>list</ul>;
          },
          { name: "list", ppr: true },
        ),
      ]),
    ]),
  );
}

type Router = Parameters<typeof serveShellRequest>[0];

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  segments: ResolvedSegment[];
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

/** The crumbs the page shows once a partial response lands on `current`. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const answer = await answerOf(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    current,
    await streamedHandles(result),
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return collectHandleData(Crumbs, merged, order);
}

/** The ids of the segments a response sends with a body. */
function sentIds(answer: Answer): string[] {
  return answer.segments
    .filter((s) => s.type !== "loader" && s.component !== null)
    .map((s) => s.id);
}

/** The layout segment `crumb` is filed under. */
async function segmentOf(
  result: ServeShellRequestResult,
  crumb: string,
): Promise<string> {
  const handles = await streamedHandles(result);
  const bySegment = handles[Crumbs.$$id] ?? {};
  const found = Object.entries(bySegment).find(([, values]) =>
    (values as string[]).includes(crumb),
  );
  return found![0];
}

/** A document of `url`, as the browser holds it once the page loaded. */
async function pageOf(
  router: Router,
  url: string,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  chainPushes = true;
  const result = await serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
  });
  const answer = await answerOf(result);
  const handles = await streamedHandles(result);
  const order = filterSegmentOrder(answer.matched);
  return {
    handles,
    matched: answer.matched,
    crumbs: collectHandleData(Crumbs, handles, order),
  };
}

beforeEach(async () => {
  chainPushes = true;
  await resetShellTestState();
});

describe("a stored HIT lists the segments it sends, as a live render does", () => {
  it("cache(): a re-run layout that pushes nothing clears its crumb", async () => {
    const router = makeRouter("cache");
    const page = await pageOf(router, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);

    // The MISS renders live and writes the record; the HIT serves it.
    const store = new MemorySegmentCacheStore();
    const navigate = () => {
      chainPushes = false;
      return serveShellRequest(router, "/b", {
        cacheStore: store,
        partial: { from: "/a", segments: page.matched },
      });
    };
    const miss = await navigate();
    const hit = await navigate();
    const missAnswer = await answerOf(miss);
    const hitAnswer = await answerOf(hit);

    expect(missAnswer.resolvedIds).toEqual(
      expect.arrayContaining(sentIds(missAnswer)),
    );
    // The chain layout's handler ran and pushed nothing: its crumb goes, on
    // the HIT exactly as on the MISS.
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    // The marker stays server-side: only resolvedIds crosses to the client.
    expect(hit.flight).not.toContain("_handlerRan");
    expect(miss.flight).not.toContain("_handlerRan");
    expect(await crumbsAfter(page.handles, miss)).toEqual(["root", "b"]);
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "b"]);
  });

  it("cache(): a kept layout keeps its crumb and is not listed", async () => {
    const router = makeRouter("cache", false);
    const page = await pageOf(router, "/a");
    const chainId = await segmentOf(
      await serveShellRequest(router, "/a", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
      "chain",
    );
    const store = new MemorySegmentCacheStore();
    const navigate = () => {
      chainPushes = false;
      return serveShellRequest(router, "/b", {
        cacheStore: store,
        partial: { from: "/a", segments: page.matched },
      });
    };
    await navigate();
    const hit = await navigate();
    const answer = await answerOf(hit);

    // No rule asks for the held layout: it is kept, unlisted, and the crumb
    // it pushed before stays on the page.
    expect(answer.resolvedIds ?? []).not.toContain(chainId);
    expect(await crumbsAfter(page.handles, hit)).toEqual([
      "root",
      "chain",
      "b",
    ]);
  });

  it("a PPR navigation replay lists what the live navigation listed", async () => {
    const router = makePprRouter();
    const page = await pageOf(router, "/list?cc=1");
    expect(page.crumbs).toEqual(["chain", "list-1"]);

    // The first partial renders live (no snapshot yet); the second replays the
    // navigation-only capture it scheduled.
    const store = new MemorySegmentCacheStore();
    chainPushes = false;
    const partial = { from: "/list", segments: page.matched };
    const live = await serveShellRequest(router, "/list?page=2", {
      cacheStore: store,
      partial,
    });
    const replay = await serveShellRequest(router, "/list?page=2", {
      cacheStore: store,
      partial,
    });
    expect(replay.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });

    const liveAnswer = await answerOf(live);
    const replayAnswer = await answerOf(replay);
    expect(replayAnswer.resolvedIds).toEqual(liveAnswer.resolvedIds);
    expect(await crumbsAfter(page.handles, replay)).toEqual(["list-2"]);
  });

  it("Prerender(): a baked layout that pushed nothing clears its crumb", async () => {
    const router = makeRouter("prerender");
    const page = await pageOf(router, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);

    // The bake renders the chain layout with no push; the navigation holds
    // the layout the page shows, crumb included.
    chainPushes = false;
    await serveShellRequest(router, "/baked/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: true,
    });
    const hit = await serveShellRequest(router, "/baked/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/a", segments: page.matched },
    });
    const answer = await answerOf(hit);

    expect(answer.resolvedIds).toEqual(expect.arrayContaining(sentIds(answer)));
    expect(hit.flight).not.toContain("_handlerRan");
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "baked-1"]);
  });
});
