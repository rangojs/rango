/**
 * A held intercept slot whose loaders all skip revalidate(), through
 * serveShellRequest's JS `action` call and the browser's own reconcile step.
 *
 * An intercept's loaders ride on the slot segment as one aggregate
 * (`loaderIds` + `loaderDataPromise`, router/intercept-resolution.ts), not as
 * loader segments of their own. A loader whose revalidate() answers false is
 * left out of it, and when every loader is, resolveInterceptEntry sends the
 * slot with `loaderIds: undefined` (`loaderIds.length > 0 ? loaderIds :
 * undefined`). The browser's action reconcile (browser/segment-reconciler.ts)
 * merges a partial aggregate only when the server's has `loaderIds`
 * (`needsLoaderMerge`, browser/merge-segment-loaders.ts), so the cached
 * aggregate is replaced by nothing. renderSlotContent (client.tsx) then finds
 * no `loaderDataPromise && loaderIds` and mounts the slot with no
 * LoaderBoundary; the modal's `useLoader()` throws "data not found in
 * context".
 *
 * The request is the one the browser sends from an open modal: the page URL,
 * the held segment ids and the intercept source header
 * (browser/server-action-bridge.ts).
 *
 * KNOWN GAP: the `red` test is vitest's `it.fails`, which keeps the suite
 * green while the assertion fails and turns red the moment it passes. Drop
 * `red` for `it` when the slot keeps its aggregate.
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
import { createLoader, createRouter, urls } from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { reconcileSegments } from "../../browser/segment-reconciler.js";
import type { ResolvedSegment } from "../../types.js";

const red = it.fails;

const runs = { a: 0, b: 0 };

const LoaderA = createLoader(async () => ({ a: `a-run-${++runs.a}` }));
const LoaderB = createLoader(async () => ({ b: `b-run-${++runs.b}` }));

async function touch(): Promise<void> {}

type Mode = "skip" | "rerun";

/** The modal's two loaders, each held (revalidate() false) or following the default. */
function makeRouter(a: Mode, b: Mode) {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader, revalidate }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            () => <dialog>modal</dialog>,
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
async function slotAfterAction(a: Mode, b: Mode) {
  const router = makeRouter(a, b);
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

  it("control: one held loader and one re-run merge into the cached aggregate", async () => {
    const { cachedSlot, sentSlot, slot } = await slotAfterAction(
      "skip",
      "rerun",
    );
    expect(sentSlot?.loaderIds).toHaveLength(1);
    expect(slot.loaderIds).toEqual(cachedSlot.loaderIds);
    expect(await slot.loaderDataPromise).toMatchObject([
      { data: { a: "a-run-1" } },
      { data: { b: "b-run-2" } },
    ]);
    expect(runs).toEqual({ a: 1, b: 2 });
  });

  red(
    "every loader held: the slot keeps the aggregate it was opened with",
    async () => {
      const { cachedSlot, slot } = await slotAfterAction("skip", "skip");
      expect(runs).toEqual({ a: 1, b: 1 });
      // renderSlotContent mounts the slot's LoaderBoundary only when both are set.
      expect(slot.loaderIds).toEqual(cachedSlot.loaderIds);
      expect(await slot.loaderDataPromise).toMatchObject([
        { data: { a: "a-run-1" } },
        { data: { b: "b-run-1" } },
      ]);
    },
  );
});
