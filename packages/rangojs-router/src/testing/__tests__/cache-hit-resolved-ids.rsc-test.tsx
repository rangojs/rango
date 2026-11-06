/**
 * A stored response lists in `resolvedIds` every segment whose handler values
 * it carries, so a HIT reports the MISS's list and the browser replaces the
 * same runs.
 *
 * The browser merges a partial response run by run (mergePartialHandleData,
 * handles/pushed-by.ts): a run's old values give way when the response
 * delivers values of that run or lists it in `resolvedIds`. A live walk marks
 * a segment it re-rendered (`_handlerRan`, revalidation.ts), so a handler that
 * re-runs and pushes nothing still clears its breadcrumb. A stored record
 * carries no such marker: serializeSegments (cache/segment-codec.ts) copies
 * named fields only. A HIT therefore listed only its loaders, and a segment
 * whose record values it replayed kept the client's values of the page it
 * left — the breadcrumb a MISS cleared came back on the HIT.
 *
 * The answer is derived on serve, not stored: which segments a response
 * carries is decided per request (the revalidate() rules, the params, what the
 * client holds), so what the MISS wrote cannot answer it. serveStoredSegments
 * (match-middleware/cache-lookup.ts) records every segment its send rule sends
 * — the same set it replays the record's handle values for — on the pipeline
 * state, for every stored source: a cache() record, a Prerender() bake, and the
 * PPR shell replay. The segment object itself is never marked: MatchResult.slots
 * hands the same objects to the client.
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
  Passthrough,
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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/**
 * serveShellRequest, asserting no request it serves leaks an internal segment
 * field: `_handlerRan` is stripped by match-result.ts (buildMatchResult)
 * before the payload is serialized.
 */
async function serve(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  options: ServeShellRequestOptions = {},
): Promise<ServeShellRequestResult> {
  const result = await serveShellRequest(router, url, options);
  expect(result.flight ?? "").not.toContain("_handlerRan");
  expect(result.body ?? "").not.toContain("_handlerRan");
  return result;
}

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

/** The crumb the page shows after `result` lands on it, merged as the browser merges. */
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

/** The crumb the page shows from `handles` alone. */
function crumbsOf(handles: HandleData, matched: string[]): string[] {
  return collectHandleData(Crumbs, handles, filterSegmentOrder(matched));
}

/** The segment whose bucket holds `crumb`. */
function idOfCrumb(handles: HandleData, crumb: string): string {
  const bySegment = (handles[Crumbs.$$id] ?? {}) as Record<string, unknown[]>;
  const found = Object.entries(bySegment).find(([, values]) =>
    values.includes(crumb),
  );
  expect(found, `no segment pushed ${crumb}`).toBeDefined();
  return found![0];
}

/** The document at `url`, its handles, and its mounted ids. */
async function documentOf(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  cacheStore: MemorySegmentCacheStore,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(
    await serve(router, url, { cacheStore }),
  );
  return {
    handles,
    matched: answer.matched,
    crumbs: crumbsOf(handles, answer.matched),
  };
}

/**
 * A layout the routes sit in, inside a cache() boundary, whose revalidate()
 * asks for a re-render on every navigation. It stops pushing its breadcrumb
 * after the document, as a handler whose breadcrumb depends on the request
 * would.
 */
let chainPushes = true;
let chainRevalidates = true;
let chainRuns = 0;

function page(crumb: string): (ctx: HandlerContext) => React.ReactNode {
  return (ctx: HandlerContext) => {
    ctx.use(Crumbs)(crumb);
    return <p>{crumb}</p>;
  };
}

const cacheRouter = createRouter({}).routes(
  urls(({ path, cache, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>root</main>;
      },
      () => [
        cache({ ttl: 600 }, () => [
          layout(
            (ctx: HandlerContext) => {
              chainRuns += 1;
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [
              revalidate(() => chainRevalidates),
              path("/a", page("a"), { name: "a" }),
              path("/b", page("b"), { name: "b" }),
            ],
          ),
        ]),
      ],
    ),
  ]),
);

beforeEach(async () => {
  chainPushes = true;
  chainRevalidates = true;
  chainRuns = 0;
  await resetShellTestState();
});

describe("a cache() HIT reports the resolvedIds of the MISS that wrote the record", () => {
  it("lists the layout it re-sends, so the breadcrumb clears on both", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await documentOf(cacheRouter, "/a", cacheStore);
    expect(doc.crumbs).toEqual(["root", "chain", "a"]);
    const chainId = idOfCrumb(doc.handles, "chain");
    const rootId = idOfCrumb(doc.handles, "root");

    chainPushes = false;
    chainRuns = 0;
    const partial = { from: "/a", segments: doc.matched };
    const miss = await serve(cacheRouter, "/b", { cacheStore, partial });
    const missAnswer = await readAnswer(miss);
    expect(missAnswer.answer.resolvedIds).toContain(chainId);
    expect(await crumbsAfter(doc.handles, miss)).toEqual(["root", "b"]);
    // The MISS ran the handler: its marker is a live walk's.
    expect(chainRuns).toBeGreaterThan(0);

    chainRuns = 0;
    const hit = await serve(cacheRouter, "/b", { cacheStore, partial });
    const hitAnswer = await readAnswer(hit);
    // The record's values stand for the segment: the HIT lists it too, though
    // its handler never ran.
    expect(chainRuns).toBe(0);
    expect(hitAnswer.answer.resolvedIds).toEqual(missAnswer.answer.resolvedIds);
    expect(await crumbsAfter(doc.handles, hit)).toEqual(["root", "b"]);
    // A held segment the response keeps stays out of the list.
    expect(hitAnswer.answer.resolvedIds).not.toContain(rootId);
  });

  it("keeps a segment it does not send out of the list, and lists it again when it does", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await documentOf(cacheRouter, "/a", cacheStore);
    const chainId = idOfCrumb(doc.handles, "chain");

    chainPushes = false;
    const partial = { from: "/a", segments: doc.matched };
    // The MISS that writes the record sends the layout (revalidate -> true).
    const miss = await readAnswer(
      await serve(cacheRouter, "/b", { cacheStore, partial }),
    );
    expect(miss.answer.resolvedIds).toContain(chainId);

    // A HIT whose rule keeps the layout: the client keeps its values, so the
    // segment is not listed — the marker is per response, not stored.
    chainRevalidates = false;
    const kept = await readAnswer(
      await serve(cacheRouter, "/b", { cacheStore, partial }),
    );
    expect(kept.answer.resolvedIds).not.toContain(chainId);
    // Kept: the client keeps the values of the page it is on, as on a live
    // walk that skips the layout.
    const keptResult = await serve(cacheRouter, "/b", { cacheStore, partial });
    expect(await crumbsAfter(doc.handles, keptResult)).toEqual([
      "root",
      "chain",
      "b",
    ]);

    // The rule asks for it again on the same store: the HIT decodes a fresh
    // segment, lists it, and its empty record clears the client's breadcrumb.
    chainRevalidates = true;
    const sent = await serve(cacheRouter, "/b", { cacheStore, partial });
    expect((await readAnswer(sent)).answer.resolvedIds).toContain(chainId);
    expect(await crumbsAfter(doc.handles, sent)).toEqual(["root", "b"]);
  });
});

/** A bake of param 1, and the live handler for a param it does not bake. */
const BakedPage = Passthrough(
  Prerender<{ id: string }>(
    async () => [{ id: "1" }],
    (ctx) => {
      ctx.use(Crumbs)(`baked-${ctx.params.id}`);
      return <p>baked</p>;
    },
  ),
  (ctx: HandlerContext<{ id: string }>) => {
    ctx.use(Crumbs)(`live-${ctx.params.id}`);
    return <p>live</p>;
  },
);

const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
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
            revalidate(() => true),
            path("/item/:id", BakedPage, { name: "item" }),
          ],
        ),
      ],
    ),
  ]),
);

describe("a Prerender() bake HIT reports the resolvedIds of a live render", () => {
  it("lists the layout the bake re-sends, as the live walk does", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    // Param 1 is baked (the document bakes it, as the build does).
    const baked = await documentOf(prerenderRouter, "/item/1", cacheStore);
    expect(baked.crumbs).toEqual(["root", "chain", "baked-1"]);
    const chainId = idOfCrumb(baked.handles, "chain");

    // Param 2 is not baked: the same navigation renders live.
    const live = await serve(prerenderRouter, "/item/2", {
      cacheStore,
      partial: { from: "/item/1", segments: baked.matched },
    });
    const liveAnswer = await readAnswer(live);
    expect(liveAnswer.answer.resolvedIds).toContain(chainId);

    // Back to the baked param: the bake serves it.
    const hit = await serve(prerenderRouter, "/item/1", {
      cacheStore,
      partial: { from: "/item/2", segments: liveAnswer.answer.matched },
    });
    const hitAnswer = await readAnswer(hit);
    // Same list: the bake re-sends the layout and replays its values, as the
    // live walk re-runs it. (The crumbs differ by design: the bake delivers
    // what its handler pushed then, a live render what the handler pushed now.)
    expect(hitAnswer.answer.resolvedIds).toEqual(liveAnswer.answer.resolvedIds);
    expect(hitAnswer.answer.resolvedIds).toContain(chainId);
  });
});

const pprRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
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
            revalidate(() => true),
            path("/list", page("list"), { name: "list" }),
            path(
              "/item/:id",
              (ctx: HandlerContext<{ id: string }>) => {
                ctx.use(Crumbs)("item");
                return <p>item {ctx.params.id}</p>;
              },
              { name: "item", ppr: true },
            ),
          ],
        ),
      ],
    ),
  ]),
);

describe("a PPR shell replay HIT reports the resolvedIds of the live partial", () => {
  it("lists the layout the replay re-sends, as the live path does", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await documentOf(pprRouter, "/list", cacheStore);
    const chainId = idOfCrumb(doc.handles, "chain");
    const partial = { from: "/list", segments: doc.matched };

    // The live partial writes the navigation capture; the second serves it.
    const live = await serve(pprRouter, "/item/1", { cacheStore, partial });
    expect(live.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    const replay = await serve(pprRouter, "/item/1", { cacheStore, partial });
    expect(replay.replayStatus).toMatchObject({ outcome: "HIT" });

    const liveAnswer = await readAnswer(live);
    const replayAnswer = await readAnswer(replay);
    expect(liveAnswer.answer.resolvedIds).toContain(chainId);
    expect(replayAnswer.answer.resolvedIds).toEqual(
      liveAnswer.answer.resolvedIds,
    );
    expect(await crumbsAfter(doc.handles, replay)).toEqual(
      await crumbsAfter(doc.handles, live),
    );
  });
});

const interceptRouter = createRouter({}).routes(
  urls(({ path, cache, layout, intercept, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>root</main>;
        },
        () => [
          revalidate(() => true),
          path("/list", page("list"), { name: "list" }),
          path(
            "/item/:id",
            (ctx: HandlerContext<{ id: string }>) => {
              ctx.use(Crumbs)(`item-${ctx.params.id}`);
              return <p>item {ctx.params.id}</p>;
            },
            { name: "item" },
          ),
          intercept("@modal", ".item", (ctx: HandlerContext) => {
            ctx.use(Crumbs)("modal");
            return <dialog>modal</dialog>;
          }),
        ],
      ),
    ]),
  ]),
);

describe("an intercept navigation lists its slot on the MISS and on the HIT", () => {
  it("reports the same resolvedIds on both", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const doc = await documentOf(interceptRouter, "/list", cacheStore);
    const partial = { from: "/list", segments: doc.matched };

    const miss = await serve(interceptRouter, "/item/1", {
      cacheStore,
      partial,
    });
    const missAnswer = await readAnswer(miss);
    const slot = missAnswer.answer.matched.find((id) => id.includes(".@"));
    expect(slot).toBeDefined();
    // The slot's handler ran for this response, so the browser replaces the
    // run's values even when it pushed none.
    expect(missAnswer.answer.resolvedIds).toContain(slot);

    const hit = await serve(interceptRouter, "/item/1", {
      cacheStore,
      partial,
    });
    const hitAnswer = await readAnswer(hit);
    expect(hitAnswer.answer.resolvedIds).toEqual(missAnswer.answer.resolvedIds);
    expect(await crumbsAfter(doc.handles, hit)).toEqual(
      await crumbsAfter(doc.handles, miss),
    );
  });
});
