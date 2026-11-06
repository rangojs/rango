/**
 * A stored response lists the segments whose handlers re-ran, as the live walk
 * that wrote the record does.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. A live walk marks a segment whose handler it ran
 * (`_handlerRan`, revalidation.ts) and match-result.ts lists it; a stored
 * segment carries no such mark (segment-codec.ts serializeSegments copies
 * named fields), so a HIT listed only the loader segments it resolved fresh.
 * A chain layout whose revalidate() re-rendered it, and pushed nothing this
 * time, kept its previous push on the page (a stale breadcrumb) on every HIT.
 *
 * Each source of stored segments is covered: a cache() record, a Prerender()
 * entry, and a PPR navigation replay (the shell's doc record).
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
import { createCacheSink, filterCacheDecisions } from "../cache-status.js";

const Crumbs = createHandle<string, string[]>(function (segments) {
  return segments.flat();
});

/** Whether the chain layout pushes on this request. */
let chainPushes = true;
/** How many times the chain layout's handler ran. */
let chainRuns = 0;
/** How many times the Prerender route's handler ran (the bake only). */
let prerenderRuns = 0;

const { sink, events } = createCacheSink();

function RootLayout(ctx: HandlerContext): React.ReactNode {
  ctx.use(Crumbs)("root");
  return <main>shell</main>;
}

function ChainLayout(ctx: HandlerContext): React.ReactNode {
  chainRuns++;
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <section>chain</section>;
}

function makeCacheRouter() {
  return createRouter({ telemetry: sink }).routes(
    urls(({ path, cache, layout, revalidate }) => [
      cache({ ttl: 600 }, () => [
        layout(RootLayout, () => [
          layout(ChainLayout, () => [revalidate(() => true)]),
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
        ]),
      ]),
    ]),
  );
}

/** A Prerender() route under the same chain layout. */
function makePrerenderRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, revalidate }) => [
      layout(RootLayout, () => [
        layout(ChainLayout, () => [revalidate(() => true)]),
        path(
          "/p/:id",
          Prerender<{ id: string }>((ctx: BuildContext<{ id: string }>) => {
            prerenderRuns++;
            ctx.use(Crumbs)(`p${ctx.params.id}`);
            return <p>{`p${ctx.params.id}`}</p>;
          }),
          { name: "p" },
        ),
      ]),
    ]),
  );
}

/** A ppr route under the same chain layout: a navigation replay's source. */
function makePprRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, revalidate }) => [
      layout(RootLayout, () => [
        layout(ChainLayout, () => [revalidate(() => true)]),
        path(
          "/list",
          (ctx: HandlerContext) => {
            const page = ctx.url.searchParams.get("page") ?? "1";
            ctx.use(Crumbs)(`list${page}`);
            return <ul>{`list-page-${page}`}</ul>;
          },
          { name: "list", ppr: true },
        ),
      ]),
    ]),
  );
}

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  segments: { id: string; type: string }[];
  handles?: AsyncIterable<HandleData>;
}

/** A response's metadata and the last handle state it streamed. */
interface Page {
  answer: Answer;
  handles: HandleData;
}

async function readAnswer(result: ServeShellRequestResult): Promise<Page> {
  const { metadata } = await deserializeResult<{ metadata: Answer }>(
    result.flight!,
  );
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

/** A response's `resolvedIds`, in payload order. */
async function resolvedIdsOf(
  result: ServeShellRequestResult,
): Promise<string[] | undefined> {
  return (await readAnswer(result)).answer.resolvedIds;
}

/** The crumbs a page holds. */
function crumbsOf(page: Page): string[] {
  const order = filterSegmentOrder(page.answer.matched);
  return collectHandleData(Crumbs, page.handles, order);
}

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  page: Page,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    page.handles,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return collectHandleData(Crumbs, merged, order);
}

/** No server-side marker rides the wire: `resolvedIds` is the only trace. */
async function expectNoMarkers(
  result: ServeShellRequestResult,
): Promise<void> {
  for (const segment of (await readAnswer(result)).answer.segments) {
    expect(Object.keys(segment)).not.toContain("_handlerRan");
  }
}

/** The cache.decision status the last request reported for `pathname`. */
function cacheStatusOf(pathname: string): string | undefined {
  return filterCacheDecisions(events)
    .filter((decision) => decision.pathname === pathname)
    .flatMap((decision) => decision.segments ?? [])
    .find((segment) => segment.type === "route")?.cacheStatus;
}

beforeEach(async () => {
  chainPushes = true;
  chainRuns = 0;
  prerenderRuns = 0;
  events.length = 0;
  await resetShellTestState();
});

describe("a cache() HIT lists the segments it re-renders", () => {
  it("a chain layout that re-ran and pushed nothing, on a navigation", async () => {
    const router = makeCacheRouter();
    const page = await readAnswer(
      await serveShellRequest(router, "/a", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    );
    expect(crumbsOf(page)).toEqual(["root", "chain", "a"]);

    chainPushes = false;
    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/a", segments: page.answer.matched } as const;

    // The navigation that writes the record: the chain layout re-runs live.
    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    expect(cacheStatusOf("/b")).toBe("miss");
    expect(await crumbsAfter(page, miss)).toEqual(["root", "b"]);

    events.length = 0;
    // The same navigation again: the record answers, and the chain layout is
    // re-rendered from it (revalidate() asked for it) instead of live.
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    expect(cacheStatusOf("/b")).toBe("hit");
    expect(await crumbsAfter(page, hit)).toEqual(["root", "b"]);
    expect(await resolvedIdsOf(hit)).toEqual(await resolvedIdsOf(miss));
    await expectNoMarkers(hit);
  });
});

describe("a Prerender() HIT lists the segments it re-renders", () => {
  it("a chain layout re-sent for changed params, that pushed nothing", async () => {
    const router = makePrerenderRouter();
    // Bakes /p/1 with the layout's push, and /p/2 without it.
    const from = await readAnswer(
      await serveShellRequest(router, "/p/1", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    );
    expect(crumbsOf(from)).toEqual(["root", "chain", "p1"]);
    chainPushes = false;
    const target = await readAnswer(
      await serveShellRequest(router, "/p/2", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    );
    expect(crumbsOf(target)).toEqual(["root", "p2"]);
    const bakes = prerenderRuns;
    const runs = chainRuns;

    // The params changed, so the entry re-sends the chain layout (its rules)
    // and the route: both render from the record, where a live walk would
    // have run their handlers. The root layout above them stays held.
    const hit = await serveShellRequest(router, "/p/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/p/1", segments: from.answer.matched },
    });
    // Served from the entry: neither handler ran.
    expect({ prerenderRuns, chainRuns }).toEqual({
      prerenderRuns: bakes,
      chainRuns: runs,
    });
    expect(await crumbsAfter(from, hit)).toEqual(["root", "p2"]);
    const layouts = target.answer.segments.filter(
      (segment) => segment.type === "layout",
    );
    const route = target.answer.segments.find(
      (segment) => segment.type === "route",
    )!;
    expect(await resolvedIdsOf(hit)).toEqual([layouts.at(-1)!.id, route.id]);
    await expectNoMarkers(hit);
  });
});

describe("a PPR navigation replay lists the segments it re-renders", () => {
  it("a chain layout revalidating every navigation, that pushed nothing", async () => {
    const router = makePprRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const page = await readAnswer(
      await serveShellRequest(router, "/list", { cacheStore }),
    );
    expect(crumbsOf(page)).toEqual(["root", "chain", "list1"]);

    chainPushes = false;
    const partial = { from: "/list", segments: page.answer.matched } as const;
    // The live navigation, which schedules the navigation-only capture.
    const live = await serveShellRequest(router, "/list?page=2", {
      cacheStore,
      partial,
    });
    expect(live.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    expect(await crumbsAfter(page, live)).toEqual(["root", "list2"]);

    // The same navigation again: the capture's doc record replays it.
    const replay = await serveShellRequest(router, "/list?page=2", {
      cacheStore,
      partial,
    });
    expect(replay.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(await crumbsAfter(page, replay)).toEqual(["root", "list2"]);
    expect(await resolvedIdsOf(replay)).toEqual(await resolvedIdsOf(live));
    await expectNoMarkers(replay);
  });
});
