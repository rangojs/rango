/**
 * A stored segment a HIT re-serves replaces its handle values in the browser
 * exactly as a segment whose handler re-ran does, so `resolvedIds` names the
 * same segments on a HIT as on the MISS that wrote the record.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. A live walk marks a segment whose handler ran (_handlerRan,
 * router/segment-resolution/revalidation.ts) and match-result.ts lists it. A
 * stored record holds the segments' data, not the mark (serializeSegments
 * copies named fields only), and a HIT listed no stored segment at all: a
 * layout whose handler stopped pushing kept its old crumb on the page after a
 * HIT of a record its own MISS cleared it on.
 *
 * The HIT marks the segments it serves from the record — the ones it does not
 * keep (cache-lookup.ts serveStoredSegments) — the same decision that replays
 * their recorded values (restoreHandles' `sent`). Every stored source decides
 * that in the one loop, so a route cache() record, a Prerender() artifact and
 * a PPR navigation replay answer alike.
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

/** Whether the layouts push on this request. */
let chainPushes = true;
let keptPushes = true;
let modalPushes = true;

/** The chain layout: its rule re-runs it on every navigation. */
const Chain = (ctx: HandlerContext): React.ReactNode => {
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <main>shell</main>;
};

/** A routeless sibling its rule keeps: its values stay the client's. */
const Kept = (ctx: HandlerContext): React.ReactNode => {
  if (keptPushes) ctx.use(Crumbs)("kept");
  return <aside>kept</aside>;
};

function crumbPage(crumb: string): (ctx: HandlerContext) => React.ReactNode {
  return (ctx: HandlerContext): React.ReactNode => {
    ctx.use(Crumbs)(crumb);
    return <p>{crumb}</p>;
  };
}

/** The handler of the live and the baked twin routes. */
function twin(ctx: Pick<HandlerContext<{ id: string }>, "params" | "use">) {
  ctx.use(Crumbs)("twin");
  return <h1>{`twin ${ctx.params.id}`}</h1>;
}

const buildTwin = (ctx: BuildContext<{ id: string }>): React.ReactNode =>
  twin({ params: ctx.params, use: ctx.use as HandlerContext["use"] });

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  fromStorage?: true;
}

/** A response's metadata and the handle state it streamed. */
async function answerOf(result: ServeShellRequestResult): Promise<{
  answer: Answer;
  handles: HandleData;
}> {
  const { metadata } = await deserializeResult<{
    metadata: Answer & { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

/** The page's crumbs after `result`, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const { answer, handles } = await answerOf(result);
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

/** The page's crumbs as its own document delivers them. */
function pageCrumbs(handles: HandleData, matched: string[]): string[] {
  return collectHandleData(Crumbs, handles, filterSegmentOrder(matched));
}

/** The document at /a: its handles and the ids the client then holds. */
async function pageOf(router: Parameters<typeof serveShellRequest>[0]) {
  const cacheStore = new MemorySegmentCacheStore();
  const page = await answerOf(
    await serveShellRequest(router, "/a", { cacheStore }),
  );
  return {
    cacheStore,
    handles: page.handles,
    matched: page.answer.matched,
    crumbs: pageCrumbs(page.handles, page.answer.matched),
  };
}

beforeEach(async () => {
  chainPushes = true;
  keptPushes = true;
  modalPushes = true;
  await resetShellTestState();
});

describe("a stored segment a HIT re-serves replaces its handle values", () => {
  it("a chain layout that re-runs: a cache() HIT lists it, as its MISS did", async () => {
    const router = createRouter({}).routes(
      urls(({ path, cache, layout, revalidate }) => [
        cache({ ttl: 600 }, () => [
          layout(Chain, () => [
            revalidate(() => true),
            path("/a", crumbPage("a"), { name: "a" }),
            path("/b", crumbPage("b"), { name: "b" }),
          ]),
        ]),
      ]),
    );
    const page = await pageOf(router);
    expect(page.crumbs).toEqual(["chain", "a"]);
    chainPushes = false;
    const partial = { from: "/a", segments: page.matched } as const;
    const serve = () =>
      serveShellRequest(router, "/b", { cacheStore: page.cacheStore, partial });
    const missResult = await serve();
    const miss = await answerOf(missResult);
    const hitResult = await serve();
    const hit = await answerOf(hitResult);
    expect(miss.answer.resolvedIds).toHaveLength(2);
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
    // The mark is the server's: match-result.ts strips it from the payload.
    expect(hitResult.flight).not.toContain("_handlerRan");
    // The chain layout's handler stopped pushing: the page drops its crumb on
    // the HIT as it did on the MISS.
    expect(await crumbsAfter(page.handles, await serve())).toEqual(["b"]);
  });

  it("an intercept slot whose handler re-runs: the MISS and the HIT both list it", async () => {
    const router = createRouter({}).routes(
      urls(({ path, cache, layout, intercept, revalidate }) => [
        cache({ ttl: 600 }, () => [
          layout(Chain, () => [
            revalidate(() => true),
            path("/list", crumbPage("list"), { name: "list" }),
            path(
              "/item/:id",
              (ctx: HandlerContext<{ id: string }>) => {
                ctx.use(Crumbs)("item");
                return <p>item</p>;
              },
              { name: "item" },
            ),
            intercept("@modal", ".item", (ctx: HandlerContext) => {
              if (modalPushes) ctx.use(Crumbs)("modal");
              return <dialog>modal</dialog>;
            }),
          ]),
        ]),
      ]),
    );
    const page = await pageOf(router);
    // A modal navigation that pushes: the page then holds the slot's crumb.
    const opened = await serveShellRequest(router, "/item/1", {
      cacheStore: page.cacheStore,
      partial: { from: "/list", segments: page.matched },
    });
    expect(await crumbsAfter(page.handles, opened)).toEqual(["chain", "modal"]);
    modalPushes = false;
    const partial = { from: "/list", segments: page.matched } as const;
    const serve = () =>
      serveShellRequest(router, "/item/2", {
        cacheStore: page.cacheStore,
        partial,
      });
    const missResult = await serve();
    const miss = await answerOf(missResult);
    const hitResult = await serve();
    const hit = await answerOf(hitResult);
    const slotId = miss.answer.matched.find((id) => id.endsWith(".@modal"));
    expect(slotId).toBeDefined();
    expect(miss.answer.resolvedIds).toContain(slotId);
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
    expect(hitResult.flight).not.toContain("_handlerRan");
    // The slot's handler pushed nothing this time, on either path.
    expect(await crumbsAfter(page.handles, missResult)).toEqual(["chain"]);
    expect(await crumbsAfter(page.handles, hitResult)).toEqual(["chain"]);
  });

  it("a Prerender() HIT lists the segments it serves, as a live render does", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout, revalidate }) => [
        layout(Chain, () => [
          revalidate(() => true),
          layout(Kept, () => [revalidate(() => false)]),
          path("/a", crumbPage("a"), { name: "a" }),
          path("/live/:id", twin, { name: "live" }),
          path(
            "/baked/:id",
            Prerender<{ id: string }>(async () => [{ id: "1" }], buildTwin),
            { name: "baked" },
          ),
        ]),
      ]),
    );
    const page = await pageOf(router);
    chainPushes = false;
    const navigate = async (url: string) => {
      const result = await serveShellRequest(router, url, {
        cacheStore: page.cacheStore,
        partial: { from: "/a", segments: page.matched },
      });
      expect(result.flight).not.toContain("_handlerRan");
      return {
        resolvedIds: (await answerOf(result)).answer.resolvedIds,
        crumbs: await crumbsAfter(page.handles, result),
      };
    };
    const live = await navigate("/live/1");
    // The first request to a Prerender() route bakes it and serves the bake;
    // the second serves it from the store.
    const baked = await navigate("/baked/1");
    const bakedHit = await navigate("/baked/1");
    // The twin routes have their own ids: the chain layout's is shared, and
    // the kept layout is in neither list.
    expect(live.resolvedIds).toHaveLength(2);
    for (const served of [baked, bakedHit]) {
      expect(served.resolvedIds).toHaveLength(2);
      expect(served.resolvedIds?.[0]).toBe(live.resolvedIds?.[0]);
    }
    expect(bakedHit.crumbs).toEqual(live.crumbs);
    expect(bakedHit.crumbs).not.toContain("chain");
    expect(bakedHit.crumbs).toContain("kept");
  });

  it("a PPR navigation replay lists the segments it serves, as the live pass did", async () => {
    const router = createRouter({}).routes(
      urls(({ path, layout, revalidate }) => [
        layout(Chain, () => [
          revalidate(() => true),
          layout(Kept, () => [revalidate(() => false)]),
          path("/a", crumbPage("a"), { name: "a" }),
          path("/ppr", crumbPage("ppr"), { name: "ppr", ppr: true }),
        ]),
      ]),
    );
    const page = await pageOf(router);
    chainPushes = false;
    const partial = { from: "/a", segments: page.matched } as const;
    const serve = async () => {
      const result = await serveShellRequest(router, "/ppr", {
        cacheStore: page.cacheStore,
        partial,
      });
      expect(result.flight).not.toContain("_handlerRan");
      return {
        replayStatus: result.replayStatus,
        resolvedIds: (await answerOf(result)).answer.resolvedIds,
        crumbs: await crumbsAfter(page.handles, result),
      };
    };
    const live = await serve();
    const replay = await serve();
    expect(live.resolvedIds).toHaveLength(2);
    expect(replay.resolvedIds).toEqual(live.resolvedIds);
    expect(replay.crumbs).toEqual(live.crumbs);
    expect(replay.crumbs).not.toContain("chain");
  });
});
