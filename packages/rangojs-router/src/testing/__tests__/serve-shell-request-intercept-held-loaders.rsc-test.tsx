/**
 * A held intercept slot whose loaders all skip revalidate(), through
 * serveShellRequest's JS `action` call and the browser's own reconcile step.
 *
 * An intercept's loaders ride on the slot segment as one aggregate
 * (`loaderIds` + `loaderDataPromise`, router/intercept-resolution.ts), not as
 * loader segments of their own. A loader whose revalidate() answers false is
 * left out of it; when every loader is, the slot is sent with an EMPTY
 * aggregate. The browser's action reconcile (browser/segment-reconciler.ts)
 * merges a partial aggregate into the one it holds (`needsLoaderMerge`,
 * browser/merge-segment-loaders.ts). A slot sent with no aggregate at all
 * replaced the cached one: renderSlotContent (client.tsx) found no
 * `loaderDataPromise && loaderIds`, mounted the slot with no LoaderBoundary,
 * and the modal's `useLoader()` threw "data not found in context".
 *
 * The request is the one the browser sends from an open modal: the page URL,
 * the held segment ids and the intercept source header
 * (browser/server-action-bridge.ts).
 *
 * Over a `Prerender()` target the modal is served from the build's intercept
 * variant, on the action too (match-middleware/cache-lookup.ts
 * yieldFromStore). The stored slot is re-sent with its handler output, as on
 * the runtime cache path. Kept instead (component null), the response left the
 * slot out (match-result.ts drops a null segment the client holds), so the
 * loaders that re-ran never reached the modal.
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
 * holds it after reconciling the action's response.
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
  const cachedSlot = opened.segments.find((s) => s.slot === "@modal")!;

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
  const slot = reconciled.segments.find((s) => s.slot === "@modal")!;
  return { cachedSlot, sentSlot, slot };
}

beforeEach(async () => {
  runs.a = 0;
  runs.b = 0;
  modalRenders.count = 0;
  await resetShellTestState();
});

describe("a modal held across a server action keeps its loader data", () => {
  it("control: loaders that follow the default re-run and ride on the slot", async () => {
    const { cachedSlot, sentSlot, slot } = await slotAfterAction(
      "rerun",
      "rerun",
    );
    expect(sentSlot?.loaderIds).toEqual(cachedSlot.loaderIds);
    expect(slot.loaderIds).toEqual(cachedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-2" } },
      { data: { b: "b-run-2" } },
    ]);
  });

  it("one held loader and one re-run: the re-run merges into the cached aggregate, the handler's re-render applies", async () => {
    const { cachedSlot, sentSlot, slot } = await slotAfterAction(
      "skip",
      "rerun",
    );
    expect(sentSlot?.loaderIds).toHaveLength(1);
    expect(slot.component).toBe(sentSlot!.component);
    expect(slot.loaderIds).toEqual(cachedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-1" } },
      { data: { b: "b-run-2" } },
    ]);
    expect(runs).toEqual({ a: 1, b: 2 });
  });

  it("every loader held: the slot keeps the aggregate it was opened with", async () => {
    const { cachedSlot, sentSlot, slot } = await slotAfterAction(
      "skip",
      "skip",
    );
    expect(runs).toEqual({ a: 1, b: 1 });
    expect(sentSlot?.loaderIds).toEqual([]);
    // The handler's re-render applies, as when the loaders re-run.
    expect(slot.component).toBe(sentSlot!.component);
    // renderSlotContent mounts the slot's LoaderBoundary only when both are set.
    expect(slot.loaderIds).toEqual(cachedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-1" } },
      { data: { b: "b-run-1" } },
    ]);
  });
});

describe("over a Prerender() target, the stored modal is re-sent across a server action", () => {
  for (const [a, b] of [
    ["skip", "rerun"],
    ["rerun", "rerun"],
    ["skip", "skip"],
  ] as const) {
    it(`loaders ${a}/${b}: the re-run loaders' data reaches the stored modal`, async () => {
      const { sentSlot, slot } = await slotAfterAction(a, b, "prerender");
      // The bake rendered the modal; neither request ran its handler.
      expect(modalRenders.count).toBe(1);
      expect(await slot.loaderDataPromise).toMatchObject([
        { data: { a: a === "skip" ? "a-run-1" : "a-run-2" } },
        { data: { b: b === "skip" ? "b-run-1" : "b-run-2" } },
      ]);
      // Re-sent with the stored handler output, never as a kept (null) slot.
      expect(sentSlot?.component).toBeTruthy();
      expect(slot.component).toBe(sentSlot!.component);
    });
  }
});
