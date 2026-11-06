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
 * entry, a PPR navigation replay (the shell's doc record), and a cache() record
 * whose slot reaches the payload a second way, through `metadata.slots`.
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
/** How many times the intercept's handler has run. */
let modalRuns = 0;
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

/**
 * The chain layout with an intercept that opens over /list: a cache() HIT that
 * re-sends the slot, whose segment the walk files into `metadata.slots`.
 */
function makeInterceptRouter() {
  return createRouter({}).routes(
    urls(({ path, cache, layout, intercept }) => [
      cache({ ttl: 600 }, () => [
        layout(RootLayout, () => [
          path(
            "/list",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("list");
              return <ul>list</ul>;
            },
            { name: "list" },
          ),
          path(
            "/item/:id",
            (ctx: HandlerContext<{ id: string }>) => {
              ctx.use(Crumbs)("item-page");
              return <article>item page</article>;
            },
            { name: "item" },
          ),
          intercept(
            "@modal",
            ".item",
            (ctx: HandlerContext) => {
              // Pushes on its first render only, so the record a second render
              // writes holds no values for the slot.
              if (modalRuns++ === 0) ctx.use(Crumbs)("modal");
              return <dialog>modal</dialog>;
            },
            { when: ({ from }) => from.url.pathname === "/list" },
          ),
        ]),
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

/** The handles and segment order a partial response leaves the page with. */
async function mergedAfter(
  page: Page,
  result: ServeShellRequestResult,
): Promise<{ handles: HandleData; order: string[] }> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    page.handles,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return { handles: merged, order };
}

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  page: Page,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const { handles, order } = await mergedAfter(page, result);
  return collectHandleData(Crumbs, handles, order);
}

/**
 * No server-side marker rides the wire: `resolvedIds` is the only trace. Walks
 * the whole payload, a slot's segments included (they are the walk's own
 * objects, filed into `metadata.slots`).
 */
async function expectNoMarkers(result: ServeShellRequestResult): Promise<void> {
  const found: string[] = [];
  const walk = (value: unknown, path: string): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, inner] of Object.entries(value as object)) {
      if (key === "_handlerRan") found.push(path);
      else walk(inner, `${path}.${key}`);
    }
  };
  const { metadata } = await deserializeResult<{ metadata: unknown }>(
    result.flight!,
  );
  walk(metadata, "metadata");
  expect(found).toEqual([]);
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
  modalRuns = 0;
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

describe("a cache() HIT of an intercept navigation lists the slot it re-renders", () => {
  it("an intercept that re-ran and pushed nothing, with the slot in metadata.slots", async () => {
    const router = makeInterceptRouter();
    const page = await readAnswer(
      await serveShellRequest(router, "/list", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
    );
    expect(crumbsOf(page)).toEqual(["root", "list"]);

    const cacheStore = new MemorySegmentCacheStore();
    const partial = { from: "/list", segments: page.answer.matched } as const;

    // The navigation that writes the intercept's record: the slot renders
    // live and pushes its crumb.
    const miss = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial,
    });
    const afterMiss = await mergedAfter(page, miss);
    expect(
      collectHandleData(Crumbs, afterMiss.handles, afterMiss.order),
    ).toEqual(["root", "modal", "list"]);
    await expectNoMarkers(miss);

    // The same intercept again, the client holding it: the record answers and
    // re-sends the slot. The record holds no values for it: the render that
    // wrote it ran the slot's handler a second time, which pushed nothing.
    // The slot must be listed, or the client keeps the crumb the page shows.
    const held = {
      answer: (await readAnswer(miss)).answer,
      handles: afterMiss.handles,
    };
    const hit = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: held.answer.matched },
    });
    expect(await crumbsAfter(held, hit)).toEqual(["root", "list"]);
    expect(await resolvedIdsOf(hit)).toEqual(await resolvedIdsOf(miss));
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
