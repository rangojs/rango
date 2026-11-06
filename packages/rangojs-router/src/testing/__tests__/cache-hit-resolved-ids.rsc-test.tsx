/**
 * A stored HIT lists in `resolvedIds` every segment it sends from its record,
 * as the MISS that wrote the record does: a cache() record, a Prerender()
 * bake, and the snapshot a PPR navigation replay serves.
 *
 * The browser replaces a segment's handle values only for an id the response
 * lists (NavigationProvider → eventController.setHandleData →
 * mergePartialHandleData): a run with no values in the response loses the
 * values it had, every other run keeps them. A MISS lists a segment whose
 * handler ran; a stored copy carries no such flag, so a HIT that re-sent a
 * segment from its record (a revalidate() asking for it, a changed param)
 * delivered the record's values and still left the client on the values it
 * held before the navigation: a breadcrumb that cleared on the MISS came back
 * on the HIT.
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
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { HandleData } from "../../server/handle-store.js";

const Breadcrumb = createHandle<string, string[]>((segments) =>
  segments.flat(),
);

/**
 * The chain layout's crumb names the item it sits above. The second item
 * pushes none, so its breadcrumb is the one the client must clear.
 */
const router = createRouter({}).routes(
  urls(({ path, layout, cache, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Breadcrumb)("root");
          return <main>shell</main>;
        },
        () => [
          layout(
            (ctx: HandlerContext<{ id: string }>) => {
              if (ctx.params.id === "1") ctx.use(Breadcrumb)("chain:1");
              return <section>chain</section>;
            },
            () => [
              revalidate(() => true),
              path(
                "/item/:id",
                (ctx: HandlerContext<{ id: string }>) => (
                  <article>{ctx.params.id}</article>
                ),
                { name: "item" },
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
  resolvedIds?: string[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  return (await deserializeResult<{ metadata: Answer }>(result.flight!))
    .metadata;
}

/** The last handle state a response streamed, pushedBy records included. */
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

/** The browser's merge of a partial response onto the page's handles. */
async function merged(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<HandleData> {
  const answer = await answerOf(result);
  return mergePartialHandleData(
    current,
    await streamedHandles(result),
    filterSegmentOrder(answer.matched),
    answer.matched,
    answer.resolvedIds,
  );
}

/** Each segment's Breadcrumb values the handle data holds. */
function crumbs(data: HandleData): Record<string, unknown[]> {
  return (data[Breadcrumb.$$id] ?? {}) as Record<string, unknown[]>;
}

describe("cache() HIT: resolvedIds names every stored segment it sends", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  /** The page on /item/1, the MISS that writes /item/2's record, and a HIT. */
  async function navigate() {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(router, "/item/1", { cacheStore });
    const held = (await answerOf(page)).matched;
    const nav = () =>
      serveShellRequest(router, "/item/2", {
        cacheStore,
        partial: { from: "/item/1", segments: held },
      });
    return { page, miss: await nav(), hit: await nav() };
  }

  it("lists the same ids as the MISS that wrote the record", async () => {
    const { page, miss, hit } = await navigate();
    const chain = idHolding(await streamedHandles(page), "chain:1");
    const missAnswer = await answerOf(miss);
    const hitAnswer = await answerOf(hit);
    // The chain layout's revalidate(() => true) sends it from the record, as
    // the MISS sent it live; the route is new to the client on both.
    expect(missAnswer.resolvedIds).toContain(chain);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
  });

  it("clears a breadcrumb the HIT re-sends with no values", async () => {
    const { page, miss, hit } = await navigate();
    const before = await streamedHandles(page);
    const chain = idHolding(before, "chain:1");
    const root = idHolding(before, "root");
    const afterMiss = await merged(before, miss);
    const afterHit = await merged(before, hit);
    // The chain's handler pushed nothing for /item/2, and the record holds
    // none: both answers clear the crumb the page held.
    expect(crumbs(afterMiss)[chain]).toBeUndefined();
    expect(crumbs(afterHit)).toEqual(crumbs(afterMiss));
    // The root layout has no revalidate() rule, so the HIT keeps it: its
    // values stay as the page held them.
    expect(crumbs(afterHit)[root]).toEqual(["root"]);
  });
});

/** The segment whose Breadcrumb bucket holds `crumb`. */
function idHolding(data: HandleData, crumb: string): string {
  const id = Object.entries(crumbs(data)).find(([, values]) =>
    values.includes(crumb),
  )?.[0];
  expect(id, `the segment that pushed ${crumb}`).toBeDefined();
  return id!;
}

describe("Prerender() HIT: resolvedIds names the baked segments it sends", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  const prerenderRouter = createRouter({}).routes(
    urls(({ path, layout }) => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Breadcrumb)("root");
          return <main>shell</main>;
        },
        () => [
          path(
            "/p/:id",
            Prerender(
              async () => [{ id: "1" }, { id: "2" }],
              (ctx) => {
                ctx.use(Breadcrumb)(`p:${ctx.params.id}`);
                return <article>{ctx.params.id}</article>;
              },
            ),
            { name: "p" },
          ),
        ],
      ),
    ]),
  );

  it("lists a baked route it re-sends for the new params", async () => {
    const page = await serveShellRequest(prerenderRouter, "/p/1", {
      cacheStore: new MemorySegmentCacheStore(),
    });
    const held = (await answerOf(page)).matched;
    const nav = await serveShellRequest(prerenderRouter, "/p/2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/p/1", segments: held },
    });
    const before = await streamedHandles(page);
    const routeId = idHolding(before, "p:1");
    expect((await answerOf(nav)).resolvedIds).toContain(routeId);
    const after = await merged(before, nav);
    expect(crumbs(after)[routeId]).toEqual(["p:2"]);
  });
});

describe("PPR navigation replay: resolvedIds names the snapshot's segments", () => {
  beforeEach(async () => {
    await resetShellTestState();
  });

  const replayRouter = createRouter({}).routes(
    urls(({ path }) => [
      path(
        "/r/:id",
        (ctx: HandlerContext<{ id: string }>) => {
          ctx.use(Breadcrumb)(`r:${ctx.params.id}`);
          return <article>{ctx.params.id}</article>;
        },
        { name: "r", ppr: true },
      ),
    ]),
  );

  it("lists the route it re-sends from the capture for the new params", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const page = await serveShellRequest(replayRouter, "/r/1", { cacheStore });
    const held = (await answerOf(page)).matched;
    const partial = { from: "/r/1", segments: held };
    // The live partial captures the navigation; the second replays it.
    const live = await serveShellRequest(replayRouter, "/r/2", {
      cacheStore,
      partial,
    });
    const replay = await serveShellRequest(replayRouter, "/r/2", {
      cacheStore,
      partial,
    });
    expect(replay.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    const before = await streamedHandles(page);
    const routeId = idHolding(before, "r:1");
    const liveAnswer = await answerOf(live);
    expect(liveAnswer.resolvedIds).toContain(routeId);
    expect((await answerOf(replay)).resolvedIds).toEqual(
      liveAnswer.resolvedIds,
    );
    const after = await merged(before, replay);
    expect(crumbs(after)[routeId]).toEqual(["r:2"]);
  });
});
