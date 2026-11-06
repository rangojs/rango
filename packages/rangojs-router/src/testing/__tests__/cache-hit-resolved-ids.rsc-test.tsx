/**
 * A stored segment a partial response serves replaces its handle values in
 * the browser, exactly as a segment whose handler ran does: a cache() record
 * HIT, a Prerender() HIT and a ppr shell replay list the segments they send
 * in `resolvedIds`.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. A record does not carry `_handlerRan` (serializeSegments
 * copies named fields only) and serveStoredSegments (cache-lookup.ts) never
 * set it, so a HIT listed none of its stored segments: a breadcrumb the MISS
 * that wrote the record cleared came back on every HIT of it.
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

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;

/** Whether the intercept's slot pushes its crumb on this request. */
let modalPushes = true;

/** Handler runs per page, to tell a stored serve from a fresh render. */
const runs = { list: 0, a: 0, b: 0, baked: 0, shelled: 0 };

/**
 * The three storage kinds, one router each: a cache() record, the artifact a
 * Prerender() route bakes into the build store, and a ppr route whose shell
 * entry carries a doc record a navigation replays.
 */
const cacheRouter = createRouter({}).routes(
  urls(({ path, cache, layout, revalidate }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>shell</main>;
        },
        () => [
          layout(
            (ctx: HandlerContext) => {
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [
              revalidate(() => true),
              path(
                "/a",
                (ctx: HandlerContext) => {
                  runs.a += 1;
                  ctx.use(Crumbs)("a");
                  return <p>a</p>;
                },
                { name: "a" },
              ),
              path(
                "/b",
                (ctx: HandlerContext) => {
                  runs.b += 1;
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

const prerenderRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        layout(
          (ctx: HandlerContext) => {
            if (chainPushes) ctx.use(Crumbs)("chain");
            return <section>chain</section>;
          },
          () => [
            revalidate(() => true),
            path(
              "/list",
              (ctx: HandlerContext) => {
                runs.list += 1;
                ctx.use(Crumbs)("list");
                return <ul>list</ul>;
              },
              { name: "list" },
            ),
            path(
              "/baked/:id",
              Prerender(
                async () => [{ id: "1" }],
                (ctx) => {
                  runs.baked += 1;
                  if (chainPushes) ctx.use(Crumbs)("baked");
                  return <article>baked</article>;
                },
              ),
              { name: "baked" },
            ),
          ],
        ),
      ],
    ),
  ]),
);

const pprRouter = createRouter({}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("root");
        return <main>shell</main>;
      },
      () => [
        layout(
          (ctx: HandlerContext) => {
            if (chainPushes) ctx.use(Crumbs)("chain");
            return <section>chain</section>;
          },
          () => [
            revalidate(() => true),
            path(
              "/list",
              (ctx: HandlerContext) => {
                runs.list += 1;
                ctx.use(Crumbs)("list");
                return <ul>list</ul>;
              },
              { name: "list" },
            ),
            path(
              "/shelled",
              (ctx: HandlerContext) => {
                runs.shelled += 1;
                if (chainPushes) ctx.use(Crumbs)("shelled");
                return <article>shelled</article>;
              },
              { name: "shelled", ppr: true },
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

/**
 * An intercept over a cache() route: the slot is the segment whose handler
 * owns its pushes, and the stored copy of it is what a HIT serves.
 */
const interceptRouter = createRouter({}).routes(
  urls(({ path, cache, layout, revalidate, intercept }) => [
    cache({ ttl: 600 }, () => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("root");
          return <main>shell</main>;
        },
        () => [
          layout(
            (ctx: HandlerContext) => {
              if (chainPushes) ctx.use(Crumbs)("chain");
              return <section>chain</section>;
            },
            () => [
              revalidate(() => true),
              intercept("@modal", ".item", (ctx: HandlerContext) => {
                if (modalPushes) ctx.use(Crumbs)("modal");
                return <dialog>modal</dialog>;
              }),
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
                  ctx.use(Crumbs)("item");
                  return <p>item</p>;
                },
                { name: "item" },
              ),
            ],
          ),
        ],
      ),
    ]),
  ]),
);

/**
 * A response's metadata and the handle state the browser merges: the last
 * streamed yield, which holds everything the response pushed so far, or the
 * document snapshot when nothing streamed.
 */
async function readAnswer(
  result: ServeShellRequestResult,
): Promise<{ answer: Answer; handles: HandleData; payload: string }> {
  const payload = result.flight!;
  const { metadata } = await deserializeResult<{ metadata: Answer }>(payload);
  const handles = await result.readHandles();
  return {
    answer: metadata,
    handles: handles?.late.at(-1) ?? handles?.hydration ?? {},
    payload: [result.flight, result.prelude, result.body]
      .filter(Boolean)
      .join("\n"),
  };
}

/** The id of the segment whose pushes hold `crumb`. */
function idPushing(handles: HandleData, crumb: string): string {
  const bySegment = handles[Crumbs.$$id] ?? {};
  const id = Object.keys(bySegment).find((key) =>
    (bySegment[key] as string[]).includes(crumb),
  );
  expect(id).toBeDefined();
  return id!;
}

/**
 * The page after a partial response: its handle data merged as the browser
 * merges it, the ids it mounts, and the crumbs that state shows.
 */
async function after(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  const merged = mergePartialHandleData(
    current,
    handles,
    order,
    answer.matched,
    answer.resolvedIds,
  );
  return {
    handles: merged,
    matched: answer.matched,
    crumbs: collectHandleData(Crumbs, merged, order),
  };
}

/** A document of `url`: its handles, the ids it mounts and its crumbs. */
async function documentOf(
  router: Parameters<typeof serveShellRequest>[0],
  url: string,
  cacheStore: MemorySegmentCacheStore,
): Promise<{
  handles: HandleData;
  matched: string[];
  crumbs: string[];
  answer: Answer;
  result: ServeShellRequestResult;
}> {
  const result = await serveShellRequest(router, url, { cacheStore });
  const { answer, handles } = await readAnswer(result);
  const order = filterSegmentOrder(answer.matched);
  return {
    handles,
    matched: answer.matched,
    answer,
    result,
    crumbs: collectHandleData(Crumbs, handles, order),
  };
}

beforeEach(async () => {
  chainPushes = true;
  modalPushes = true;
  for (const page of Object.keys(runs) as (keyof typeof runs)[]) {
    runs[page] = 0;
  }
  await resetShellTestState();
});

describe("a cache() HIT lists the segments it serves in resolvedIds", () => {
  it("a chain layout that pushed nothing when the record was written clears its crumb on the HIT", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const pageA = await documentOf(cacheRouter, "/a", cacheStore);
    expect(pageA.crumbs).toEqual(["root", "chain", "a"]);

    // The navigation that writes /b's record: the chain's handler runs and
    // pushes nothing, so its crumb clears.
    chainPushes = false;
    const miss = await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: pageA.matched },
    });
    const missAnswer = (await readAnswer(miss)).answer;
    expect((await after(pageA.handles, miss)).crumbs).toEqual(["root", "b"]);

    // The same navigation again, served from the record the MISS wrote.
    const runsBefore = runs.b;
    const hit = await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: pageA.matched },
    });
    const hitAnswer = (await readAnswer(hit)).answer;
    expect(runs.b).toBe(runsBefore);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    expect((await after(pageA.handles, hit)).crumbs).toEqual(["root", "b"]);
  });

  it("keeps a held layout out of resolvedIds, so its crumb stays", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const pageA = await documentOf(cacheRouter, "/a", cacheStore);
    chainPushes = false;
    await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: pageA.matched },
    });
    const hit = await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: pageA.matched },
    });
    const { answer, payload } = await readAnswer(hit);
    // The root layout has no revalidate() rule and the params did not change:
    // the client keeps it, so the response must not list it.
    expect(answer.resolvedIds).not.toContain(idPushing(pageA.handles, "root"));
    expect((await after(pageA.handles, hit)).crumbs).toEqual(["root", "b"]);
    // The marker that drives the list is internal.
    expect(payload).not.toContain("_handlerRan");
  });

  it("a document HIT reports the ids its MISS reported", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const miss = await documentOf(cacheRouter, "/a", cacheStore);
    const hit = await documentOf(cacheRouter, "/a", cacheStore);
    expect(hit.answer.resolvedIds).toEqual(miss.answer.resolvedIds);
  });

  it("still shows a crumb the record holds", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const pageA = await documentOf(cacheRouter, "/a", cacheStore);
    // The navigation that writes /b's record, with the chain pushing.
    const miss = await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: pageA.matched },
    });
    const missPage = await after(pageA.handles, miss);
    expect(missPage.crumbs).toEqual(["root", "chain", "b"]);

    // /a has no navigation record: it renders live and clears the crumb.
    chainPushes = false;
    const back = await serveShellRequest(cacheRouter, "/a", {
      cacheStore,
      partial: { from: "/b", segments: missPage.matched },
    });
    const backPage = await after(missPage.handles, back);
    expect(backPage.crumbs).toEqual(["root", "a"]);

    const hit = await serveShellRequest(cacheRouter, "/b", {
      cacheStore,
      partial: { from: "/a", segments: backPage.matched },
    });
    expect((await after(backPage.handles, hit)).crumbs).toEqual([
      "root",
      "chain",
      "b",
    ]);
  });
});

describe("a Prerender() HIT lists the segments it serves in resolvedIds", () => {
  it("a chain layout that pushed nothing when the bake was written clears its crumb on the HIT", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    chainPushes = false;
    const list = await documentOf(prerenderRouter, "/list", cacheStore);

    // The URL's first request bakes the entry; the chain runs and pushes
    // nothing.
    const bake = await serveShellRequest(prerenderRouter, "/baked/1", {
      cacheStore,
      partial: { from: "/list", segments: list.matched },
    });
    const bakeAnswer = (await readAnswer(bake)).answer;
    expect(runs.baked).toBe(1);

    // A page whose chain pushed again, then the bake's HIT.
    chainPushes = true;
    const back = await documentOf(prerenderRouter, "/list", cacheStore);
    expect(back.crumbs).toEqual(["root", "chain", "list"]);
    chainPushes = false;
    const hit = await serveShellRequest(prerenderRouter, "/baked/1", {
      cacheStore,
      partial: { from: "/list", segments: back.matched },
    });
    const hitAnswer = (await readAnswer(hit)).answer;
    expect(runs.baked).toBe(1);
    expect(hitAnswer.resolvedIds).toEqual(bakeAnswer.resolvedIds);
    expect((await after(back.handles, hit)).crumbs).toEqual(["root"]);
  });
});

describe("a ppr shell replay lists the segments it serves in resolvedIds", () => {
  it("a chain layout that pushed nothing on the shell's render clears its crumb", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await documentOf(pprRouter, "/list", cacheStore);
    expect(list.crumbs).toEqual(["root", "chain", "list"]);

    // Captures /shelled's shell entry and the doc record a navigation
    // replays, with the chain pushing nothing.
    chainPushes = false;
    const shelled = await documentOf(pprRouter, "/shelled", cacheStore);
    expect(shelled.result.shellStatus).toBe("MISS");
    expect(shelled.crumbs).toEqual(["root"]);

    chainPushes = true;
    const back = await documentOf(pprRouter, "/list", cacheStore);
    expect(back.crumbs).toEqual(["root", "chain", "list"]);

    chainPushes = false;
    const runsBefore = runs.shelled;
    const nav = await serveShellRequest(pprRouter, "/shelled", {
      cacheStore,
      partial: { from: "/list", segments: back.matched },
    });
    const { answer } = await readAnswer(nav);
    expect(nav.replayStatus).toEqual({ outcome: "HIT", freshness: "fresh" });
    expect(runs.shelled).toBe(runsBefore);
    expect((await after(back.handles, nav)).crumbs).toEqual(["root"]);
    // The chain layout is the one that pushed nothing: it is listed.
    expect(answer.resolvedIds).toContain(idPushing(list.handles, "chain"));
  });
});

describe("an intercept over a cache() route lists its slot", () => {
  /** The page the browser is on, and the intercept opened from it. */
  async function openModal(cacheStore: MemorySegmentCacheStore): Promise<{
    list: Awaited<ReturnType<typeof documentOf>>;
    miss: ServeShellRequestResult;
    hit: ServeShellRequestResult;
  }> {
    const list = await documentOf(interceptRouter, "/list", cacheStore);
    const partial = {
      from: "/list",
      interceptSource: "/list",
      segments: list.matched,
    };
    const miss = await serveShellRequest(interceptRouter, "/item/1", {
      cacheStore,
      partial,
    });
    const hit = await serveShellRequest(interceptRouter, "/item/1", {
      cacheStore,
      partial,
    });
    return { list, miss, hit };
  }

  it("a slot whose handler pushed nothing clears its crumb, on the MISS and on the HIT", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const { list, miss } = await openModal(cacheStore);
    const missPage = await after(list.handles, miss);
    // The intercepted route's handler does not run for an intercept: the page
    // it lands over keeps its route's values, and the slot pushes its own.
    expect(missPage.crumbs).toEqual(["root", "chain", "modal", "list"]);

    // Moving the open intercept re-runs the slot's handler, which pushes
    // nothing this time: its values replace the ones the page holds.
    modalPushes = false;
    const moved = await serveShellRequest(interceptRouter, "/item/2", {
      cacheStore,
      partial: {
        from: "/list",
        interceptSource: "/list",
        segments: list.matched,
      },
    });
    expect((await after(missPage.handles, moved)).crumbs).toEqual([
      "root",
      "chain",
      "list",
    ]);

    // The record that MISS wrote, served again: the same crumbs.
    const movedHit = await serveShellRequest(interceptRouter, "/item/2", {
      cacheStore,
      partial: {
        from: "/list",
        interceptSource: "/list",
        segments: list.matched,
      },
    });
    expect((await after(missPage.handles, movedHit)).crumbs).toEqual([
      "root",
      "chain",
      "list",
    ]);
  });

  it("a HIT reports the ids its MISS reported", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const { miss, hit } = await openModal(cacheStore);
    const missRead = await readAnswer(miss);
    const hitRead = await readAnswer(hit);
    const slotId = idPushing(missRead.handles, "modal");
    // The slot's handler ran for the MISS that wrote the record and a stored
    // copy of it is served here: both list it.
    expect(missRead.answer.resolvedIds).toContain(slotId);
    expect(hitRead.answer.resolvedIds).toEqual(missRead.answer.resolvedIds);
  });

  it("carries no internal field, in the slot container too", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const { miss, hit } = await openModal(cacheStore);
    // The slot carries the pipeline's own segment objects, not the copies the
    // segment list is built from, so the marker driving resolvedIds must be
    // stripped there as well: it reached the client on every HIT of an open
    // intercept while the slot container went unstripped.
    expect((await readAnswer(miss)).payload).not.toContain("_handlerRan");
    expect((await readAnswer(hit)).payload).not.toContain("_handlerRan");
  });
});
