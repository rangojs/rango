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

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());

/** Whether the chain layout pushes its crumb: a record keeps what it pushed. */
let chainPushes = true;
/** The same, for the layout above the prerendered route. */
let prerenderPushes = true;

const PageData = createLoader(async (ctx) => {
  ctx.use(Crumbs)("page-loader");
  return { page: true };
});

const router = createRouter({}).routes(
  urls(({ path, cache, layout, intercept, loader }) => [
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
              ctx.use(Crumbs)("a");
              return <p>a</p>;
            },
            { name: "a" },
            () => [loader(PageData)],
          ),
          path(
            "/b",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("b");
              return <p>b</p>;
            },
            { name: "b" },
          ),
          path(
            "/item/:id",
            (ctx: HandlerContext<{ id: string }>) => {
              ctx.use(Crumbs)("item-page");
              return <article>item</article>;
            },
            { name: "item" },
            () => [loader(PageData)],
          ),
          intercept(
            "@modal",
            ".item",
            (ctx: HandlerContext) => {
              ctx.use(Crumbs)("modal");
              return <dialog>modal</dialog>;
            },
            () => [loader(PageData)],
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

/** A document of `url` from a cold store: what the client holds on it. */
async function pageOf(
  url: string,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, url, {
      cacheStore: new MemorySegmentCacheStore(),
    }),
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

  it("leaks no internal marker to the client", async () => {
    const cacheStore = await recordOfA(false);
    const from = await pageOf("/b");
    const hit = await serveShellRequest(router, "/a", {
      cacheStore,
      partial: { from: "/b", segments: from.matched },
    });
    expect(hit.flight).not.toContain("_handlerRan");
  });

  it("lists the intercept slot a HIT sends, and carries no marker on it", async () => {
    // A cache HIT with an intercept sends the record's slot segment through
    // `state.slots`, a container buildMatchResult does not strip: a marker
    // set on the segment object (rather than the id recorded in the pipeline
    // state) reached the client here.
    const cacheStore = new MemorySegmentCacheStore();
    const from = await pageOf("/b");
    const request = {
      cacheStore,
      partial: {
        from: "/b",
        interceptSource: "/b",
        segments: from.matched,
      },
    };
    const miss = await serveShellRequest(router, "/item/1", request);
    const hit = await serveShellRequest(router, "/item/1", request);

    const { answer } = await readAnswer(hit);
    const slot = answer.matched.find((id) => id.includes(".@modal"));
    expect(slot).toBeDefined();
    expect(answer.resolvedIds).toContain(slot);
    for (const text of [
      miss.flight,
      miss.prelude,
      miss.body,
      hit.flight,
      hit.prelude,
      hit.body,
    ]) {
      expect(text ?? "").not.toContain("_handlerRan");
    }
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
  {
    name: "a fill holding the prefetch's segments",
    url: "/a",
    from: "/b",
    request: (held) => ({
      partial: { from: "/a", segments: held, fill: true },
    }),
  },
  {
    name: "a Prerender() route, same params, holding the page",
    url: "/pr/1",
    from: "/pr/1",
    request: (held) => ({ partial: { from: "/pr/1", segments: held } }),
  },
  {
    name: "a Prerender() route, params changed, holding the source",
    url: "/pr/2",
    from: "/pr/1",
    request: (held) => ({ partial: { from: "/pr/1", segments: held } }),
  },
  {
    name: "a Prerender() route holding nothing",
    url: "/pr/2",
    from: "/pr/1",
    request: () => ({ partial: { from: "/pr/1", segments: [] } }),
  },
];

describe("a stored answer lists what it sends, as the live render lists what it ran", () => {
  for (const shape of SHAPES) {
    it(shape.name, async () => {
      const cacheStore = new MemorySegmentCacheStore();
      const from = await readAnswer(
        await serveShellRequest(router, shape.from, { cacheStore }),
      );
      const request = shape.request(from.answer.matched);
      const miss = await readAnswer(
        await serveShellRequest(router, shape.url, { cacheStore, ...request }),
      );
      const hit = await readAnswer(
        await serveShellRequest(router, shape.url, { cacheStore, ...request }),
      );
      // The browser reads the list as a set (handles/pushed-by.ts); a HIT
      // yields the record before the loaders it resolves, so only membership
      // is the contract.
      expect([...(hit.answer.resolvedIds ?? [])].sort()).toEqual(
        [...(miss.answer.resolvedIds ?? [])].sort(),
      );
    });
  }
});
