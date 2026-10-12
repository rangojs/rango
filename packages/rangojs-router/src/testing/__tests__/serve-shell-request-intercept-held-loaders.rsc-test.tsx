/**
 * A held intercept slot whose loaders skip revalidate(), through
 * serveShellRequest's JS `action` call and the browser's own reconcile and
 * fold steps.
 *
 * An intercept's loaders are loader segments of its slot
 * (`${parent}.@modalD${i}.${$$id}`, router/intercept-resolution.ts), each
 * revalidated on its own. A loader whose revalidate() answers false is left
 * out of the response; the browser keeps its cached segment (it is in
 * `matched`) and folds every loader segment back onto the slot as one
 * aggregate (segment-system.tsx foldInterceptLoaders), so renderSlotContent
 * (client.tsx) mounts the slot's LoaderBoundary with all of them. Before the
 * loaders were segments, a slot sent with none of them replaced the cached
 * aggregate and the modal's `useLoader()` threw "data not found in context".
 *
 * The request is the one the browser sends from an open modal: the page URL,
 * the held segment ids and the intercept source header
 * (browser/server-action-bridge.ts).
 *
 * Over a `Prerender()` target the modal is served from the build's intercept
 * variant, on the action too (match-middleware/cache-lookup.ts
 * yieldFromStore). The stored slot is kept like any held stored segment; its
 * loaders, never stored, run as loader segments of it.
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

import { resetShellTestState, serveShellRequest } from "../flight.entry.js";
import {
  Prerender,
  createLoader,
  createRouter,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { reconcileSegments } from "../../browser/segment-reconciler.js";
import { foldInterceptLoaders } from "../../segment-system.js";
import type { ResolvedSegment } from "../../types.js";

const runs = { a: 0, b: 0 };

const LoaderA = createLoader(async () => ({ a: `a-run-${++runs.a}` }));
const LoaderB = createLoader(async () => ({ b: `b-run-${++runs.b}` }));

async function touch(): Promise<void> {}

type Mode = "skip" | "rerun";
type Target = "live" | "prerender";

/** Intercept handler runs: every live resolution, the bake only over a Prerender(). */
const modalRenders = { count: 0 };

const PrerenderedItem = Prerender(
  async () => [{ id: "1" }],
  () => <article>item</article>,
);

/**
 * The modal's two loaders, each held (revalidate() false) or following the
 * default, over a live or a Prerender() target route.
 */
function makeRouter(a: Mode, b: Mode, target: Target) {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader, revalidate }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path(
            "/item/:id",
            target === "prerender"
              ? PrerenderedItem
              : () => <article>item</article>,
            { name: "item" },
          ),
          intercept(
            "@modal",
            ".item",
            () => <dialog>modal {++modalRenders.count}</dialog>,
            () => [
              loader(
                LoaderA,
                a === "skip" ? () => [revalidate(() => false)] : undefined,
              ),
              loader(
                LoaderB,
                b === "skip" ? () => [revalidate(() => false)] : undefined,
              ),
            ],
          ),
        ],
      ),
    ]),
  );
}

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function metadataOf(flight: string | undefined): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(flight!);
  return metadata;
}

/**
 * Open the modal from /list, then call a server action from it (the
 * intercept source still names /list). Returns the modal slot as the browser
 * renders it after reconciling the action's response (folded, on the action
 * lane).
 */
async function slotAfterAction(a: Mode, b: Mode, target: Target = "live") {
  const router = makeRouter(a, b, target);
  const cacheStore = new MemorySegmentCacheStore();
  const opened = await metadataOf(
    (
      await serveShellRequest(router, "/item/1", {
        cacheStore,
        partial: { from: "/list" },
      })
    ).flight,
  );
  const openedSlot = await foldedSlot(opened.segments);

  const answered = await metadataOf(
    (
      await serveShellRequest(router, "/item/1", {
        cacheStore,
        headers: { "X-RSC-Router-Intercept-Source": "/list" },
        action: {
          ref: touch,
          id: "src/modal.actions.ts#touch",
          segments: opened.matched,
        },
      })
    ).flight,
  );
  const sentSlot = answered.segments.find((s) => s.slot === "@modal");

  const reconciled = reconcileSegments({
    actor: "action",
    matched: answered.matched,
    diff: answered.diff,
    serverSegments: answered.segments,
    cachedSegments: opened.segments,
  });
  const slot = await foldedSlot(reconciled.interceptSegments);
  const sentLoaders = answered.segments
    .filter((s) => s.type === "loader" && s.id.includes(".@modalD"))
    .map((s) => s.loaderId);
  return { openedSlot, sentSlot, sentLoaders, slot };
}

/** The modal slot `segments` render, its loader segments folded onto it. */
async function foldedSlot(
  segments: ResolvedSegment[],
): Promise<ResolvedSegment> {
  const intercept = segments.filter((s) =>
    s.namespace?.startsWith("intercept:"),
  );
  const folded = await foldInterceptLoaders(intercept, true);
  return folded.find((s) => s.slot === "@modal")!;
}

beforeEach(async () => {
  runs.a = 0;
  runs.b = 0;
  modalRenders.count = 0;
  await resetShellTestState();
});

describe("a modal held across a server action keeps its loader data", () => {
  it("control: loaders that follow the default re-run and reach the slot", async () => {
    const { openedSlot, sentLoaders, slot } = await slotAfterAction(
      "rerun",
      "rerun",
    );
    expect(sentLoaders).toEqual([LoaderA.$$id, LoaderB.$$id]);
    expect(slot.loaderIds).toEqual(openedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-2" } },
      { data: { b: "b-run-2" } },
    ]);
  });

  it("one held loader and one re-run: the slot has the re-run's data and the held one's, the handler's re-render applies", async () => {
    const { openedSlot, sentSlot, sentLoaders, slot } = await slotAfterAction(
      "skip",
      "rerun",
    );
    expect(sentLoaders).toEqual([LoaderB.$$id]);
    expect(slot.component).toBe(sentSlot!.component);
    expect(slot.loaderIds).toEqual(openedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-1" } },
      { data: { b: "b-run-2" } },
    ]);
    expect(runs).toEqual({ a: 1, b: 2 });
  });

  it("every loader held: the slot keeps the data it was opened with", async () => {
    const { openedSlot, sentSlot, sentLoaders, slot } = await slotAfterAction(
      "skip",
      "skip",
    );
    expect(runs).toEqual({ a: 1, b: 1 });
    expect(sentLoaders).toEqual([]);
    // The handler's re-render applies, as when the loaders re-run.
    expect(slot.component).toBe(sentSlot!.component);
    // renderSlotContent mounts the slot's LoaderBoundary only when both are set.
    expect(slot.loaderIds).toEqual(openedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-1" } },
      { data: { b: "b-run-1" } },
    ]);
  });
});

describe("over a Prerender() target, the stored modal keeps its loaders' data across a server action", () => {
  for (const [a, b] of [
    ["skip", "rerun"],
    ["rerun", "rerun"],
    ["skip", "skip"],
  ] as const) {
    it(`loaders ${a}/${b}: the re-run loaders' data reaches the stored modal`, async () => {
      const { openedSlot, slot } = await slotAfterAction(a, b, "prerender");
      // The bake rendered the modal; neither request ran its handler.
      expect(modalRenders.count).toBe(1);
      expect(await slot.loaderDataPromise).toMatchObject([
        { data: { a: a === "skip" ? "a-run-1" : "a-run-2" } },
        { data: { b: b === "skip" ? "b-run-1" : "b-run-2" } },
      ]);
      // The stored handler output the modal opened with.
      expect(slot.component).toBeTruthy();
      expect(slot.component).toBe(openedSlot.component);
    });
  }
});
