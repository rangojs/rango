/**
 * `prefetch: false` and `revalidate()` on an intercept()'s loaders, through
 * the public serveShellRequest primitive and the browser's own reconcile and
 * fold steps (docs/design/prefetch-false.md, "Intercepts").
 *
 * An intercept's loaders are loader segments of its slot
 * (`${parent}.@modalD${i}.${$$id}`, router/intercept-resolution.ts), resolved
 * by the partial lane's funnel (segment-resolution/revalidation.ts
 * resolveOwnerLoaders). A prefetch from the source defers a flagged one; the
 * fill of the intercept, sent from the source with the intercept source
 * header as the browser sends it (browser/partial-update.ts), runs only what
 * the client lacks. The browser folds the loader segments back onto the slot
 * (segment-system.tsx foldInterceptLoaders).
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
} from "../flight.entry.js";
import {
  createHandle,
  createLoader,
  createRouter,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { reconcileSegments } from "../../browser/segment-reconciler.js";
import { foldInterceptLoaders } from "../../segment-system.js";
import { mergePartialHandleData } from "../../handles/pushed-by.js";
import { filterSegmentOrder } from "../../browser/react/filter-segment-order.js";
import type { ResolvedSegment } from "../../types.js";
import type { HandleData } from "../../server/handle-store.js";

const runs: Record<string, number> = {};
const ran = (name: string): number => (runs[name] = (runs[name] ?? 0) + 1);
const count = (name: string): number => runs[name] ?? 0;

function counted(name: string) {
  return createLoader(async () => ({ value: `${name}-run-${ran(name)}` }));
}

const LoaderA = counted("a");
const LoaderB = counted("b");
const ReadLoader = counted("read");
/** What the next held-modal navigation's revalidate() answers, per loader. */
const keep = { a: false, b: false };
const SkipA = counted("skip-a");
const SkipB = counted("skip-b");

const Crumbs = createHandle<string, string[]>((segments) => segments.flat());
const PushingLoader = createLoader(async (ctx) => {
  ctx.use(Crumbs)("held-loader");
  return { value: `pushing-run-${ran("pushing")}` };
});

async function touch(): Promise<void> {}

const router = createRouter({}).routes(
  urls(
    ({ path, layout, intercept, loader, loading, middleware, revalidate }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path(
            "/item/:id",
            () => <article>item</article>,
            { name: "item" },
            () => [
              middleware(async (_ctx, next) => {
                ran("route-middleware");
                await next();
              }),
            ],
          ),
          intercept(
            "@modal",
            ".item",
            () => <dialog>{`modal-run-${ran("modal")}`}</dialog>,
            () => [
              loader(LoaderA),
              loader(LoaderB, { prefetch: false }),
              loading(<p>modal-loading</p>),
            ],
          ),
          // A second intercept into the same slot with the same loaders:
          // from the open modal its loader segments are the ones held.
          path("/item-b/:id", () => <article>item b</article>, {
            name: "itemB",
          }),
          intercept(
            "@modal",
            ".itemB",
            () => <dialog>modal b</dialog>,
            () => [
              loader(LoaderA),
              loader(LoaderB, { prefetch: false }),
              loading(<p>modal-loading</p>),
            ],
          ),
          path("/reader/:id", () => <article>reader</article>, {
            name: "reader",
          }),
          intercept(
            "@modal",
            ".reader",
            async (ctx) => {
              const read = await ctx.use(ReadLoader);
              return <dialog>{read.value}</dialog>;
            },
            () => [loader(ReadLoader, { prefetch: false })],
          ),
          path("/held/:id", () => <article>held</article>, { name: "held" }),
          intercept(
            "@modal",
            ".held",
            () => <dialog>{`held-modal-run-${ran("held-modal")}`}</dialog>,
            () => [
              loader(SkipA, () => [revalidate(() => !keep.a)]),
              loader(SkipB, () => [revalidate(() => !keep.b)]),
            ],
          ),
          path("/held-b/:id", () => <article>held b</article>, {
            name: "heldB",
          }),
          intercept(
            "@modal",
            ".heldB",
            () => <dialog>held modal b</dialog>,
            () => [
              loader(SkipA, () => [revalidate(() => !keep.a)]),
              loader(SkipB, () => [revalidate(() => !keep.b)]),
            ],
          ),
          path("/pushes/:id", () => <article>pushes</article>, {
            name: "pushes",
          }),
          intercept(
            "@modal",
            ".pushes",
            (ctx) => {
              ctx.use(Crumbs)("handler");
              return <dialog>pushes</dialog>;
            },
            () => [loader(PushingLoader, () => [revalidate(() => false)])],
          ),
        ],
      ),
    ],
  ),
);

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  resolvedIds?: string[];
}

async function metadataOf(
  result: Awaited<ReturnType<typeof serveShellRequest>>,
): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(
    result.flight!,
  );
  return metadata;
}

const cacheStore = new MemorySegmentCacheStore();
const serve = (
  url: string,
  extra: Omit<ServeShellRequestOptions, "cacheStore">,
) => serveShellRequest(router, url, { cacheStore, ...extra });

/** The page /list holds: what a navigation to it delivered. */
async function listPage(): Promise<string[]> {
  return (await metadataOf(await serve("/list", { partial: { from: "/" } })))
    .matched;
}

/** The modal slot `segments` render, its loader segments folded onto it. */
async function foldedSlot(
  segments: ResolvedSegment[],
): Promise<ResolvedSegment> {
  const folded = await foldInterceptLoaders(
    segments.filter((s) => s.namespace?.startsWith("intercept:")),
    true,
  );
  return folded.find((s) => s.slot === "@modal")!;
}

const loaderIdOf = (s: ResolvedSegment) => s.loaderId;

/** The last handle state a response streamed, pushedBy records included. */
async function streamedHandles(
  result: Awaited<ReturnType<typeof serveShellRequest>>,
): Promise<HandleData> {
  const { metadata } = await deserializeResult<{
    metadata: { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let last: HandleData = {};
  for await (const data of metadata.handles ?? []) last = data;
  return last;
}

beforeEach(async () => {
  for (const key of Object.keys(runs)) delete runs[key];
  keep.a = keep.b = false;
  await resetShellTestState();
});

describe("a prefetch of an intercept from its source", () => {
  it("defers the flagged intercept loader and runs the unflagged one and the handler", async () => {
    const held = await listPage();
    const result = await serve("/item/1", {
      partial: { from: "/list", segments: held, prefetch: true },
    });
    const prefetched = await metadataOf(result);
    const flagged = prefetched.segments.find(
      (s) => s.loaderId === LoaderB.$$id,
    )!;
    expect(flagged.id).toMatch(/\.@modalD1\./);
    expect(await result.readDeferred()).toEqual([flagged.id]);
    expect(count("b")).toBe(0);
    expect({ a: count("a"), modal: count("modal") }).toEqual({
      a: 1,
      modal: 1,
    });
  });

  it("its fill, from the source with the intercept source, runs only the flagged loader", async () => {
    const held = await listPage();
    const prefetched = await metadataOf(
      await serve("/item/1", {
        partial: { from: "/list", segments: held, prefetch: true },
      }),
    );
    const deferred = prefetched.segments
      .filter((s) => s.deferred)
      .map((s) => s.id);
    const filled = await metadataOf(
      await serve("/item/1", {
        partial: {
          from: "/list",
          interceptSource: "/list",
          segments: prefetched.matched.filter((id) => !deferred.includes(id)),
          fill: true,
        },
      }),
    );

    expect(filled.segments.map((s) => s.id)).toEqual(deferred);
    expect(filled.matched).toEqual(prefetched.matched);
    expect({
      a: count("a"),
      b: count("b"),
      modal: count("modal"),
      // The target route's middleware runs for the modal on the prefetch and
      // on the fill.
      routeMiddleware: count("route-middleware"),
    }).toEqual({ a: 1, b: 1, modal: 1, routeMiddleware: 2 });
  });

  it("with the modal open (slot and loaders held), defers nothing", async () => {
    const held = await listPage();
    const opened = await metadataOf(
      await serve("/item/1", { partial: { from: "/list", segments: held } }),
    );
    // A link in the open modal to another intercepted route whose modal has
    // the same loaders: the prefetch is sent from the modal's URL.
    const result = await serve("/item-b/2", {
      partial: { from: "/item/1", segments: opened.matched, prefetch: true },
    });
    expect(await result.readDeferred()).toEqual([]);
    // New params: both loaders revalidate and run.
    expect({ a: count("a"), b: count("b") }).toEqual({ a: 2, b: 2 });
  });

  it("delivers a flagged loader the intercept handler reads with ctx.use(): one run", async () => {
    const held = await listPage();
    const result = await serve("/reader/1", {
      partial: { from: "/list", segments: held, prefetch: true },
    });
    const prefetched = await metadataOf(result);
    expect(await result.readDeferred()).toEqual([]);
    expect(count("read")).toBe(1);
    const read = prefetched.segments.find(
      (s) => s.loaderId === ReadLoader.$$id,
    )!;
    await expect(read.loaderData).resolves.toMatchObject({
      data: { value: "read-run-1" },
    });
  });
});

describe("a navigation inside the open modal", () => {
  /**
   * Open the held modal at /held/1 from /list, then follow a link in it to
   * /held-b/2, another intercepted route with the same loaders, as the
   * browser sends it (from the modal's URL). Returns the loaders the response
   * sent and the slot the browser renders after its navigation reconcile.
   */
  async function navigateInModal() {
    const held = await listPage();
    const opened = await metadataOf(
      await serve("/held/1", { partial: { from: "/list", segments: held } }),
    );
    const answered = await metadataOf(
      await serve("/held-b/2", {
        partial: { from: "/held/1", segments: opened.matched },
      }),
    );
    const reconciled = reconcileSegments({
      actor: "navigation",
      matched: answered.matched,
      diff: answered.diff,
      serverSegments: answered.segments,
      cachedSegments: opened.segments,
      insertMissingDiff: true,
    });
    return {
      sent: answered.segments
        .filter((s) => s.type === "loader" && s.id.includes(".@modalD"))
        .map(loaderIdOf),
      slot: await foldedSlot(reconciled.interceptSegments),
    };
  }

  it("a predicate that skips one loader sends the other alone; the modal keeps the skipped one's data", async () => {
    keep.a = true;
    const { sent, slot } = await navigateInModal();
    expect(sent).toEqual([SkipB.$$id]);
    expect(slot.loaderIds).toEqual([SkipA.$$id, SkipB.$$id]);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { value: "skip-a-run-1" } },
      { data: { value: "skip-b-run-2" } },
    ]);
  });

  it("skipping both sends neither, and the modal keeps both", async () => {
    keep.a = keep.b = true;
    const { sent, slot } = await navigateInModal();
    expect(sent).toEqual([]);
    expect(slot.loaderIds).toEqual([SkipA.$$id, SkipB.$$id]);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { value: "skip-a-run-1" } },
      { data: { value: "skip-b-run-1" } },
    ]);
  });
});

describe("an action inside the open modal", () => {
  it("keeps the handle pushes of an intercept loader it did not re-run, though the slot's handler re-ran", async () => {
    const held = await listPage();
    const opening = await serve("/pushes/1", {
      partial: { from: "/list", segments: held },
    });
    const opened = await metadataOf(opening);
    const answering = await serve("/pushes/1", {
      headers: { "X-RSC-Router-Intercept-Source": "/list" },
      action: {
        ref: touch,
        id: "src/modal.actions.ts#touch",
        segments: opened.matched,
      },
    });
    const answered = await metadataOf(answering);
    expect(count("pushing")).toBe(1);

    const slotId = opened.segments.find((s) => s.slot === "@modal")!.id;
    // The browser's merge of the action's handles onto the page's
    // (NavigationProvider), with the pushedBy records readHandles() strips.
    const merged = mergePartialHandleData(
      await streamedHandles(opening),
      await streamedHandles(answering),
      filterSegmentOrder(answered.matched),
      answered.matched,
      answered.resolvedIds,
    );
    expect(merged[Crumbs.$$id]?.[slotId]).toEqual(["held-loader", "handler"]);
  });
});
