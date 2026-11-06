/**
 * A live intercept's slot is listed in `resolvedIds` when its handler ran, so
 * the browser replaces the slot's handle values with this answer's or clears
 * them when it pushed none.
 *
 * `resolvedIds` names the runs whose handle values the browser replaces
 * (`mergePartialHandleData`, handles/pushed-by.ts): a run in it that the
 * response carries no values for is cleared, one it does not name keeps the
 * values the page already holds. Every walk funnel marks the segment whose
 * handler ran (`_handlerRan`, segment-resolution/revalidation.ts) and
 * match-result.ts lists it; the intercept funnel built its slot without the
 * marker (intercept-resolution.ts resolveInterceptEntry), so a link inside an
 * open modal whose handler pushed nothing kept the crumb the modal showed on
 * the page it came from.
 *
 * The slot's segment rides `metadata.slots`, not `segments`, so the marker is
 * stripped from both on the way out (match-result.ts cleanSlots): no internal
 * field reaches the client, as none does from a walk segment.
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

/** What the slot's handler pushes: "modal", nothing, or it throws. */
let slotPushes: "modal" | "none" | "throws" = "modal";

const router = createRouter({}).routes(
  urls(({ path, layout, intercept }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("layout");
        return <main>shell</main>;
      },
      () => [
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
            return <article>{`item-${ctx.params.id}`}</article>;
          },
          { name: "item" },
        ),
        intercept("@modal", ".item", (ctx: HandlerContext) => {
          if (slotPushes === "throws") throw new Error("slot handler");
          if (slotPushes === "modal") ctx.use(Crumbs)("modal");
          return <dialog>modal</dialog>;
        }),
      ],
    ),
  ]),
);

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  slots?: Record<
    string,
    { active: boolean; segments: Array<Record<string, unknown>> }
  >;
}

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

/** The slot segment the response carries, as the browser receives it. */
async function slotOf(result: ServeShellRequestResult) {
  const { answer } = await readAnswer(result);
  return answer.slots!["@modal"]!.segments[0]!;
}

/** `/list` opened, then the modal opened on `/item/1`. */
async function openModal() {
  const cacheStore = new MemorySegmentCacheStore();
  const list = await readAnswer(
    await serveShellRequest(router, "/list", { cacheStore }),
  );
  const opened = await serveShellRequest(router, "/item/1", {
    cacheStore,
    partial: { from: "/list", segments: list.answer.matched },
  });
  return { cacheStore, list, opened, openedAnswer: await readAnswer(opened) };
}

/** A link inside the open modal moves it to `/item/2`. */
function moveTo(
  cacheStore: MemorySegmentCacheStore,
  held: readonly string[],
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, "/item/2", {
    cacheStore,
    partial: {
      from: "/item/1",
      segments: held,
      interceptSource: "/list",
    },
  });
}

beforeEach(async () => {
  slotPushes = "modal";
  await resetShellTestState();
});

describe("a live intercept slot in resolvedIds", () => {
  it("is listed when its handler re-ran, so a crumb it no longer pushes clears", async () => {
    const { cacheStore, opened, openedAnswer } = await openModal();
    const shown = await crumbsAfter({}, opened);
    expect(shown).toContain("modal");

    slotPushes = "none";
    const moved = await moveTo(cacheStore, openedAnswer.answer.matched);
    const { answer } = await readAnswer(moved);

    const slot = await slotOf(moved);
    expect(answer.resolvedIds).toContain(slot.id);
    expect(await crumbsAfter(openedAnswer.handles, moved)).not.toContain(
      "modal",
    );
  });

  it("is listed when its handler threw, so a crumb it no longer pushes clears", async () => {
    const { cacheStore, openedAnswer } = await openModal();

    slotPushes = "throws";
    const moved = await moveTo(cacheStore, openedAnswer.answer.matched);
    const { answer } = await readAnswer(moved);

    expect(answer.resolvedIds).toContain((await slotOf(moved)).id);
    expect(await crumbsAfter(openedAnswer.handles, moved)).not.toContain(
      "modal",
    );
  });

  it("is not listed when a fill keeps it, so the values the page holds stay", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await readAnswer(
      await serveShellRequest(router, "/list", { cacheStore }),
    );
    const prefetched = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/list",
        segments: list.answer.matched,
        prefetch: true,
      },
    });
    const prefetchedAnswer = await readAnswer(prefetched);
    const slotId = (await slotOf(prefetched)).id;
    expect(prefetchedAnswer.answer.resolvedIds).toContain(slotId);

    // The fill the browser follows the prefetch with: the slot is held, so
    // neither its handler nor its layout runs and its values are kept.
    slotPushes = "none";
    const fill = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/list",
        segments: prefetchedAnswer.answer.matched,
        fill: true,
      },
    });
    const fillAnswer = await readAnswer(fill);

    expect(fillAnswer.answer.resolvedIds).toEqual([]);
    expect((await slotOf(fill)).component).toBeNull();
    expect(await crumbsAfter(prefetchedAnswer.handles, fill)).toContain(
      "modal",
    );
  });

  it("lists the slot a document request opens, and sends no internal marker", async () => {
    const document = await serveShellRequest(router, "/item/1", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/list", segments: [] },
    });
    const { answer } = await readAnswer(document);

    expect(answer.resolvedIds).toContain((await slotOf(document)).id);
    expect(await slotOf(document)).not.toHaveProperty("_handlerRan");
    expect(document.flight).not.toContain("_handlerRan");
  });

  it("is not listed when its handler and layout are static, so nothing of it ran", async () => {
    const staticRouter = createRouter({}).routes(
      urls(({ path, layout, intercept }) => [
        layout(
          () => <main>shell</main>,
          () => [
            path("/list", () => <ul>list</ul>, { name: "list" }),
            path("/item/:id", () => <article>item</article>, { name: "item" }),
            intercept("@modal", ".item", <dialog>static</dialog>),
          ],
        ),
      ]),
    );
    const cacheStore = new MemorySegmentCacheStore();
    const list = await readAnswer(
      await serveShellRequest(staticRouter, "/list", { cacheStore }),
    );
    const opened = await serveShellRequest(staticRouter, "/item/1", {
      cacheStore,
      partial: { from: "/list", segments: list.answer.matched },
    });
    const { answer } = await readAnswer(opened);

    expect(answer.slots?.["@modal"]?.segments[0]).toBeDefined();
    expect(answer.resolvedIds).toEqual([]);
  });

  it("sends no internal marker on a partial response either", async () => {
    const { cacheStore, openedAnswer } = await openModal();

    slotPushes = "none";
    const moved = await moveTo(cacheStore, openedAnswer.answer.matched);

    expect(await slotOf(moved)).not.toHaveProperty("_handlerRan");
    expect(moved.flight).not.toContain("_handlerRan");
  });
});
