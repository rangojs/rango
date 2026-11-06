/**
 * A cache HIT lists in `resolvedIds` the segments it re-sends, so the browser
 * replaces exactly the handle values the response delivers
 * (handles/pushed-by.ts mergePartialHandleData) and keeps the ones it does
 * not.
 *
 * A partial MISS marks each segment whose handler ran (`_handlerRan`,
 * segment-resolution/revalidation.ts) and match-result.ts turns that into
 * `resolvedIds`. A record does not carry the marker: segment-codec.ts
 * serializeSegments copies named fields only. The HIT therefore listed none of
 * the stored segments, and a segment the record re-sent with no value of its
 * own kept the client's previous one: a chain layout that clears its crumb on
 * a navigation brought it back on the next HIT of the same page.
 *
 * The marker is derived from the send decision instead
 * (match-middleware/cache-lookup.ts serveStoredSegments): a sent stored
 * segment's handler values are the record's, so the browser replaces them; a
 * kept one's are the client's, so it is not listed. Every stored source serves
 * through that loop — a cache() record, a Prerender() bake, and a PPR
 * navigation replay — so all three report the same `resolvedIds`.
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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes on this request. */
let chainPushes = true;
/** Whether the kept layout pushes on this request. */
let keptPushes = true;

const chainHandler = (ctx: HandlerContext): React.ReactNode => {
  if (chainPushes) ctx.use(Crumbs)("chain");
  return <section>chain</section>;
};

/** A layout the client holds, with no rules: every HIT keeps it. */
const keptHandler = (ctx: HandlerContext): React.ReactNode => {
  if (keptPushes) ctx.use(Crumbs)("kept");
  return <header>kept</header>;
};

const page = (crumb: string) =>
  function Page(ctx: HandlerContext): React.ReactNode {
    ctx.use(Crumbs)(crumb);
    return <article>{crumb}</article>;
  };

/**
 * A chain layout with `revalidate(() => true)`, so a navigation re-sends it
 * whether or not its handler pushes. The kept layout above it answers the
 * other side of the send decision.
 */
const router = createRouter({}).routes(
  urls(({ path, layout, revalidate, cache }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>shell</main>;
        },
        () => [
          layout(keptHandler, () => [
            layout(chainHandler, () => [
              revalidate(() => true),
              path("/a", page("a"), { name: "a" }),
              path("/b", page("b"), { name: "b" }),
            ]),
          ]),
        ],
      ),
    ]),
  ]),
);

/** The same chain, with a `ppr` target the replay path serves. */
const pprRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        layout(keptHandler, () => [
          layout(chainHandler, () => [
            revalidate(() => true),
            path("/list", page("list"), { name: "list" }),
            path("/target", page("target"), { name: "target", ppr: true }),
          ]),
        ]),
      ],
    ),
  ]),
);

/** Whether the intercept's handler pushes on this request. */
let modalPushes = true;

/** An intercept over /item/:id, opened from /list. */
const interceptRouter = createRouter({}).routes(
  urls(({ path, layout, intercept }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        path("/list", page("list"), { name: "list" }),
        path(
          "/item/:id",
          (ctx: HandlerContext<{ id: string }>) => {
            ctx.use(Crumbs)("item");
            return <article>item</article>;
          },
          { name: "item" },
        ),
        intercept("@modal", ".item", (ctx: HandlerContext<{ id: string }>) => {
          if (modalPushes) ctx.use(Crumbs)("modal");
          return <dialog>modal</dialog>;
        }),
      ],
    ),
  ]),
);

/** A baked page under a chain layout the client holds. */
const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        layout(chainHandler, () => [
          path("/plist", page("plist"), { name: "plist" }),
          path(
            "/baked",
            Prerender(
              async () => [{ id: "1" }],
              (ctx) => {
                ctx.use(Crumbs)("baked");
                return <article>baked</article>;
              },
            ),
            { name: "baked" },
          ),
        ]),
      ],
    ),
  ]),
);

interface Answer {
  matched: string[];
  diff: string[];
  resolvedIds?: string[];
  segments: { id: string; type: string; component: unknown }[];
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

/** A partial response merged onto `current` as the browser merges it. */
async function mergedOnto(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<{ data: HandleData; order: string[] }> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  return {
    data: mergePartialHandleData(
      current,
      handles,
      order,
      answer.matched,
      answer.resolvedIds,
    ),
    order,
  };
}

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const { data, order } = await mergedOnto(current, result);
  return collectHandleData(Crumbs, data, order);
}

/** The segment whose crumb bucket holds `crumb`. */
function segmentOf(handles: HandleData, crumb: string): string {
  const buckets = (handles[Crumbs.$$id] ?? {}) as Record<string, string[]>;
  const found = Object.entries(buckets).find(([, values]) =>
    values.includes(crumb),
  );
  expect(found, crumb).toBeDefined();
  return found![0];
}

/** The ids of the segments the response delivers a component for. */
function sentIds(answer: Answer): string[] {
  return answer.segments
    .filter((s) => s.component !== null && s.component !== undefined)
    .map((s) => s.id);
}

/** No internal segment marker reaches the client, in any payload container. */
function expectNoInternalFields(result: ServeShellRequestResult): void {
  const text = [result.flight, result.prelude, result.body]
    .filter(Boolean)
    .join("\n");
  const leaked = new Set(
    [...text.matchAll(/"(_[A-Za-z][A-Za-z0-9]*)":/g)].map((m) => m[1]),
  );
  expect([...leaked].sort()).toEqual([]);
}

beforeEach(async () => {
  await resetShellTestState();
  chainPushes = true;
  keptPushes = true;
  modalPushes = true;
});

describe("a cache() HIT lists the segments it re-sends", () => {
  it("a chain layout that re-runs and pushes nothing keeps its crumb cleared", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const document = await serveShellRequest(router, "/a", { cacheStore });
    const { answer: docAnswer, handles: docHandles } =
      await readAnswer(document);
    expectNoInternalFields(document);
    expect(
      collectHandleData(
        Crumbs,
        docHandles,
        filterSegmentOrder(docAnswer.matched),
      ),
    ).toEqual(["root", "kept", "chain", "a"]);

    // The navigation re-runs the chain layout (revalidate() true) and the
    // route; neither pushes this time, so both buckets clear. The kept
    // layout's handler does not run, so its crumb stays.
    chainPushes = false;
    keptPushes = false;
    const partial = { from: "/a", segments: docAnswer.matched };
    const miss = await serveShellRequest(router, "/b", { cacheStore, partial });
    const { answer: missAnswer } = await readAnswer(miss);
    expectNoInternalFields(miss);
    expect(await crumbsAfter(docHandles, miss)).toEqual(["root", "kept", "b"]);

    // The HIT serves the record the MISS wrote: it sends the same segments,
    // so it lists them too and the chain layout's crumb stays cleared.
    chainPushes = true;
    keptPushes = true;
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const { answer: hitAnswer } = await readAnswer(hit);
    expectNoInternalFields(hit);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    expect(await crumbsAfter(docHandles, hit)).toEqual(["root", "kept", "b"]);
  });

  it("a layout the HIT keeps is not listed and keeps its crumb", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const document = await serveShellRequest(router, "/a", { cacheStore });
    const { answer: docAnswer, handles: docHandles } =
      await readAnswer(document);
    const keptId = segmentOf(docHandles, "kept");
    const chainId = segmentOf(docHandles, "chain");

    chainPushes = false;
    keptPushes = false;
    const partial = { from: "/a", segments: docAnswer.matched };
    await serveShellRequest(router, "/b", { cacheStore, partial });
    const hit = await serveShellRequest(router, "/b", { cacheStore, partial });
    const { answer } = await readAnswer(hit);

    // The client holds the kept layout and its rules keep it: the response
    // delivers no component and no value, so it is not listed and its crumb
    // survives. The chain layout is re-sent, so it is listed and clears.
    expect(sentIds(answer)).toEqual([chainId, answer.matched.at(-1)]);
    expect(answer.resolvedIds).toEqual(sentIds(answer));
    expect(answer.resolvedIds).not.toContain(keptId);
    expect(await crumbsAfter(docHandles, hit)).toEqual(["root", "kept", "b"]);
  });
});

describe("a PPR navigation replay lists what the live navigation lists", () => {
  it("a replayed HIT of the captured page", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(pprRouter, "/list", { cacheStore });
    const { answer: listAnswer, handles: listHandles } = await readAnswer(list);
    const partial = { from: "/list", segments: listAnswer.matched };

    // The first partial is the live path (no capture for the URL yet) and
    // schedules the navigation-only capture; the second replays it.
    chainPushes = false;
    keptPushes = false;
    const live = await serveShellRequest(pprRouter, "/target", {
      cacheStore,
      partial,
    });
    expect(live.replayStatus).toEqual({
      outcome: "BYPASS",
      reason: "no-entry",
    });
    const { answer: liveAnswer } = await readAnswer(live);
    expectNoInternalFields(live);
    expect(await crumbsAfter(listHandles, live)).toEqual([
      "root",
      "kept",
      "target",
    ]);

    chainPushes = true;
    keptPushes = true;
    const replay = await serveShellRequest(pprRouter, "/target", {
      cacheStore,
      partial,
    });
    expect(replay.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    const { answer: replayAnswer } = await readAnswer(replay);
    expectNoInternalFields(replay);
    expect(replayAnswer.resolvedIds).toEqual(liveAnswer.resolvedIds);
    expect(await crumbsAfter(listHandles, replay)).toEqual([
      "root",
      "kept",
      "target",
    ]);
  });
});

describe("a live intercept navigation lists the slot whose handler ran", () => {
  it("a slot that re-runs and pushes nothing clears its crumb", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(interceptRouter, "/list", {
      cacheStore,
    });
    const { answer: listAnswer, handles: listHandles } = await readAnswer(list);

    const first = await serveShellRequest(interceptRouter, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: listAnswer.matched },
    });
    const { answer: firstAnswer } = await readAnswer(first);
    expectNoInternalFields(first);
    const open = await mergedOnto(listHandles, first);
    expect(collectHandleData(Crumbs, open.data, open.order)).toEqual([
      "root",
      "modal",
      "list",
    ]);

    // A second open re-runs the slot's handler, which pushes nothing this
    // time: the client clears the crumb it holds.
    modalPushes = false;
    const second = await serveShellRequest(interceptRouter, "/item/2", {
      cacheStore,
      partial: { from: "/list", segments: listAnswer.matched },
    });
    const { answer: secondAnswer } = await readAnswer(second);
    expectNoInternalFields(second);
    expect(await crumbsAfter(open.data, second)).toEqual(["root", "list"]);
  });
});

describe("a Prerender() HIT lists the segments its bake sends", () => {
  it("a baked page under a chain layout the client holds", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(prerenderRouter, "/plist", {
      cacheStore,
    });
    const { answer: listAnswer, handles: listHandles } = await readAnswer(list);
    const partial = { from: "/plist", segments: listAnswer.matched };

    chainPushes = false;
    const baked = await serveShellRequest(prerenderRouter, "/baked", {
      cacheStore,
      partial,
    });
    const { answer } = await readAnswer(baked);
    expectNoInternalFields(baked);
    // The bake's route is sent whole; the chain layout above it is the
    // client's, so it is neither delivered nor listed.
    expect(sentIds(answer)).toEqual(answer.resolvedIds);
    expect(answer.resolvedIds).toHaveLength(1);
    expect(await crumbsAfter(listHandles, baked)).toEqual([
      "root",
      "chain",
      "baked",
    ]);
  });
});
