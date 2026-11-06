/**
 * An intercept slot's handler that re-ran and pushed nothing this time
 * replaces the client's pushes with none.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. resolveInterceptEntry (router/intercept-resolution.ts) built
 * the slot segment without the run marker a chain entry gets, so a slot whose
 * handler re-ran and pushed nothing was never listed and kept the pushes of
 * the page the navigation left (a stale breadcrumb in the modal). A fill that
 * keeps the slot runs neither its handler nor its layout: it is not listed.
 *
 * The slot segment also reaches the client in `state.slots`, the same object
 * the walk yielded, so buildMatchResult strips the marker from both copies.
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

/** Whether the modal pushes its crumb on this request. */
let modalPushes = true;

const router = createRouter({}).routes(
  urls(({ path, intercept }) => [
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
        ctx.use(Crumbs)("item-page");
        return <article>item</article>;
      },
      { name: "item" },
    ),
    intercept("@modal", ".item", (ctx: HandlerContext) => {
      if (modalPushes) ctx.use(Crumbs)("modal");
      return <dialog>modal</dialog>;
    }),
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
  const { metadata } = await deserializeResult<{
    metadata: Answer & { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let handles: HandleData = {};
  for await (const data of metadata.handles ?? []) handles = data;
  return { answer: metadata, handles };
}

/** The page's crumbs after a partial response, merged as the browser merges. */
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

beforeEach(async () => {
  modalPushes = true;
  await resetShellTestState();
});

describe("an intercept slot's resolvedIds names its handler's run", () => {
  it("clears a crumb the slot's handler no longer pushes", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", { cacheStore });
    const listPage = await readAnswer(list);
    const opened = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/list",
        interceptSource: "/list",
        segments: listPage.answer.matched,
      },
    });
    // The modal renders over the source page: the slot's crumb is the one the
    // move must clear.
    expect(await crumbsAfter(listPage.handles, opened)).toContain("modal");
    const openedAnswer = await readAnswer(opened);
    const move = (to: string) =>
      serveShellRequest(router, to, {
        cacheStore,
        partial: {
          from: "/item/1",
          interceptSource: "/list",
          segments: openedAnswer.answer.matched,
        },
      });

    // Control: the slot's handler still pushes its crumb, so the move keeps it.
    expect(
      await crumbsAfter(openedAnswer.handles, await move("/item/2")),
    ).toContain("modal");

    modalPushes = false;
    const moved = await move("/item/3");
    const { answer } = await readAnswer(moved);
    const slot = answer.matched.find((id) => id.endsWith(".@modal"));
    expect(slot).toBeDefined();
    expect(await crumbsAfter(openedAnswer.handles, moved)).not.toContain(
      "modal",
    );
    expect(answer.resolvedIds).toContain(slot);
  });

  it("does not list a slot a fill keeps, and keeps its crumb", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", { cacheStore });
    const listPage = await readAnswer(list);
    const opened = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/list",
        interceptSource: "/list",
        segments: listPage.answer.matched,
      },
    });
    const openedAnswer = await readAnswer(opened);
    const slot = openedAnswer.answer.matched.find((id) =>
      id.endsWith(".@modal"),
    );
    expect(slot).toBeDefined();

    modalPushes = false;
    const fill = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/item/1",
        interceptSource: "/list",
        segments: openedAnswer.answer.matched,
        fill: true,
      },
    });
    const { answer } = await readAnswer(fill);
    expect(answer.resolvedIds ?? []).not.toContain(slot);
    expect(await crumbsAfter(openedAnswer.handles, fill)).toContain("modal");
  });

  it("leaks no internal marker through the segment list or the slot", async () => {
    const cacheStore = new MemorySegmentCacheStore();
    const list = await serveShellRequest(router, "/list", { cacheStore });
    const listPage = await readAnswer(list);
    const opened = await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: {
        from: "/list",
        interceptSource: "/list",
        segments: listPage.answer.matched,
      },
    });
    for (const text of [opened.flight, opened.prelude, opened.body]) {
      expect(text ?? "").not.toContain("_handlerRan");
    }
  });
});
