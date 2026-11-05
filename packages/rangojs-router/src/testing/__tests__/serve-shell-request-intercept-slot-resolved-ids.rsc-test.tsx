/**
 * An intercept slot (the modal) whose handler re-ran for a partial response
 * replaces its handle values in the browser, as a parallel slot's does, even
 * when it pushes nothing this time.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. resolveInterceptEntry (router/intercept-resolution.ts) never
 * marked the slot's segment as run, so a modal that re-ran and pushed nothing
 * kept its previous push on the page (a stale breadcrumb). A fill that keeps
 * the slot runs no handler, and the slot keeps its values.
 *
 * The requests are the ones the browser sends from an open modal: the modal's
 * URL, the held segment ids and the intercept source naming the page under it
 * (browser/navigation-client.ts, browser/server-action-bridge.ts).
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

const TOUCH_ACTION = "src/modal.actions.ts#touch";
async function touch(): Promise<void> {}

const Deferred = createLoader(async () => ({ value: "deferred" }));

const errors: string[] = [];
/** What the modal's handler pushes on this request; null pushes nothing. */
let modalPush: string | null = "modal";
/** The modal handlers' runs. */
let modalRuns = 0;

function modal(ctx: HandlerContext) {
  modalRuns++;
  if (modalPush !== null) ctx.use(Crumbs)(modalPush);
  return <dialog>modal</dialog>;
}

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, intercept, loader }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("layout");
        return <main>shell</main>;
      },
      () => [
        path("/list", () => <ul>list</ul>, { name: "list" }),
        path("/item/:id", () => <article>item</article>, { name: "item" }),
        intercept("@modal", ".item", modal),
        // A modal with a loader a prefetch defers: its fill keeps the slot.
        path("/photo/:id", () => <article>photo</article>, { name: "photo" }),
        intercept("@modal", ".photo", modal, () => [
          loader(Deferred, { prefetch: false }),
        ]),
      ],
    ),
  ]),
);

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  segments: { id: string; deferred?: boolean }[];
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

/** The page after a response: its handles, mounted ids and crumbs. */
interface Page {
  handles: HandleData;
  matched: string[];
  crumbs: string[];
  answer: Answer;
}

const serve = (
  url: string,
  options: Omit<ServeShellRequestOptions, "cacheStore">,
) =>
  serveShellRequest(router, url, {
    cacheStore: new MemorySegmentCacheStore(),
    ...options,
  });

/** `current` after a partial response, merged as the browser merges. */
async function after(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<Page> {
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
    answer,
  };
}

/** The /list document, then the modal at `url` opened from it. */
async function openModal(url: string): Promise<Page> {
  const { answer, handles } = await readAnswer(await serve("/list", {}));
  modalPush = "modal";
  modalRuns = 0;
  const opened = await after(
    handles,
    await serve(url, { partial: { from: "/list", segments: answer.matched } }),
  );
  expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
  expect(opened.crumbs).toEqual(["layout", "modal"]);
  return opened;
}

beforeEach(async () => {
  errors.length = 0;
  modalPush = "modal";
  modalRuns = 0;
  await resetShellTestState();
});

describe("a modal that re-runs and pushes nothing clears its handle values", () => {
  it("a navigation inside the open modal", async () => {
    const opened = await openModal("/item/1");
    modalPush = null;
    modalRuns = 0;
    const next = await after(
      opened.handles,
      await serve("/item/2", {
        partial: {
          from: "/item/1",
          segments: opened.matched,
          interceptSource: "/list",
        },
      }),
    );
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
    expect(next.crumbs).toEqual(["layout"]);
  });

  it("a server action from the open modal", async () => {
    const opened = await openModal("/item/1");
    modalPush = null;
    modalRuns = 0;
    const answered = await after(
      opened.handles,
      await serve("/item/1", {
        headers: { "X-RSC-Router-Intercept-Source": "/list" },
        action: { ref: touch, id: TOUCH_ACTION, segments: opened.matched },
      }),
    );
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
    expect(answered.crumbs).toEqual(["layout"]);
  });

  it("control: a modal that re-runs and pushes again replaces its value", async () => {
    const opened = await openModal("/item/1");
    modalPush = "modal 2";
    const next = await after(
      opened.handles,
      await serve("/item/2", {
        partial: {
          from: "/item/1",
          segments: opened.matched,
          interceptSource: "/list",
        },
      }),
    );
    expect(next.crumbs).toEqual(["layout", "modal 2"]);
  });
});

describe("a fill that keeps the modal's slot keeps its handle values", () => {
  it("the fill of a prefetched modal runs no handler and keeps the modal's push", async () => {
    const { answer, handles } = await readAnswer(await serve("/list", {}));
    const prefetched = await after(
      handles,
      await serve("/photo/1", {
        partial: { from: "/list", segments: answer.matched, prefetch: true },
      }),
    );
    expect(prefetched.crumbs).toEqual(["layout", "modal"]);
    const deferred = prefetched.answer.segments
      .filter((s) => s.deferred)
      .map((s) => s.id);
    expect(deferred).toHaveLength(1);
    modalPush = null;
    modalRuns = 0;
    const filled = await after(
      prefetched.handles,
      await serve("/photo/1", {
        partial: {
          from: "/list",
          interceptSource: "/list",
          segments: prefetched.matched.filter((id) => !deferred.includes(id)),
          fill: true,
        },
      }),
    );
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 0 });
    expect(filled.answer.segments.map((s) => s.id)).toEqual(deferred);
    expect(filled.crumbs).toEqual(["layout", "modal"]);
  });
});
