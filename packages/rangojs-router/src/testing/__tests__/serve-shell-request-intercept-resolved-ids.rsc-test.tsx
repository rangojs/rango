/**
 * An intercept slot whose handler re-ran for a partial response replaces its
 * handle values in the browser, as a chain layout's does, even when it pushes
 * nothing this time.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. resolveInterceptEntry (router/intercept-resolution.ts) never
 * marked the slot's segment as run, so a modal that re-ran and pushed nothing
 * kept its previous push on the page (a stale breadcrumb) until it closed.
 *
 * The requests are the ones the browser sends from an open modal: the source
 * page's URL, the intercept source header, and the ids it holds
 * (browser/navigation-bridge.ts, browser/server-action-bridge.ts).
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

const TOUCH_ACTION = "src/modal.actions.ts#touch";
async function touch(): Promise<void> {}

const errors: string[] = [];
/** Whether the modal pushes on this request. */
let modalPushes = true;
/** The modal handler's runs. */
let modalRuns = 0;

/**
 * The modal pushes from its handler, or from the layout wrapping its content:
 * both run with `_currentSegmentId` pinned to the slot, so both file their
 * pushes in the slot's bucket.
 */
function makeRouter(push: "handler" | "layout") {
  const pusher = (ctx: HandlerContext) => {
    if (modalPushes) ctx.use(Crumbs)("modal");
    return null;
  };
  return createRouter({
    onError: ({ error }) => {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  }).routes(
    urls(({ path, layout, intercept }) => [
      layout(
        (ctx: HandlerContext) => {
          ctx.use(Crumbs)("layout");
          return <main>shell</main>;
        },
        () => [
          path("/list", () => <ul>list</ul>, { name: "list" }),
          path("/item/:id", () => <article>item</article>, { name: "item" }),
          intercept(
            "@modal",
            ".item",
            (ctx: HandlerContext) => {
              modalRuns++;
              if (push === "handler") pusher(ctx);
              return <dialog>modal</dialog>;
            },
            () => (push === "layout" ? [layout(pusher)] : []),
          ),
        ],
      ),
    ]),
  );
}

type Router = ReturnType<typeof makeRouter>;

interface Answer {
  matched: string[];
  resolvedIds?: string[];
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

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<{ crumbs: string[]; resolvedIds: string[] | undefined }> {
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
    crumbs: collectHandleData(Crumbs, merged, order),
    resolvedIds: answer.resolvedIds,
  };
}

/** The /list document, then the modal opened over it from /list. */
async function openModal(
  router: Router,
  cacheStore: MemorySegmentCacheStore,
): Promise<{
  handles: HandleData;
  matched: string[];
  crumbs: string[];
  slotId: string;
}> {
  await serveShellRequest(router, "/list", { cacheStore });
  modalPushes = true;
  const { answer, handles } = await readAnswer(
    await serveShellRequest(router, "/item/1", {
      cacheStore,
      partial: { from: "/list" },
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
    slotId: answer.matched.find((id) => id.endsWith(".@modal"))!,
  };
}

beforeEach(async () => {
  errors.length = 0;
  modalPushes = true;
  modalRuns = 0;
  await resetShellTestState();
});

describe("an intercept slot that re-runs and pushes nothing clears its handle values", () => {
  it("a navigation inside the modal", async () => {
    const router = makeRouter("handler");
    const cacheStore = new MemorySegmentCacheStore();
    const page = await openModal(router, cacheStore);
    expect(page.crumbs).toEqual(["layout", "modal"]);
    modalPushes = false;
    modalRuns = 0;
    const nav = await serveShellRequest(router, "/item/2", {
      cacheStore,
      headers: { "X-RSC-Router-Intercept-Source": "/list" },
      partial: {
        from: "/list",
        segments: page.matched,
        interceptSource: "/list",
      },
    });
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
    expect(await crumbsAfter(page.handles, nav)).toEqual({
      crumbs: ["layout"],
      resolvedIds: expect.arrayContaining([page.slotId]),
    });
  });

  it("an action from the modal", async () => {
    const router = makeRouter("handler");
    const cacheStore = new MemorySegmentCacheStore();
    const page = await openModal(router, cacheStore);
    modalPushes = false;
    modalRuns = 0;
    const action = await serveShellRequest(router, "/item/1", {
      cacheStore,
      headers: { "X-RSC-Router-Intercept-Source": "/list" },
      action: {
        ref: touch,
        id: TOUCH_ACTION,
        segments: page.matched,
      },
    });
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
    expect(await crumbsAfter(page.handles, action)).toEqual({
      crumbs: ["layout"],
      resolvedIds: expect.arrayContaining([page.slotId]),
    });
  });

  it("a push made by the slot's own layout", async () => {
    const router = makeRouter("layout");
    const cacheStore = new MemorySegmentCacheStore();
    const page = await openModal(router, cacheStore);
    expect(page.crumbs).toEqual(["layout", "modal"]);
    modalPushes = false;
    modalRuns = 0;
    const nav = await serveShellRequest(router, "/item/2", {
      cacheStore,
      headers: { "X-RSC-Router-Intercept-Source": "/list" },
      partial: {
        from: "/list",
        segments: page.matched,
        interceptSource: "/list",
      },
    });
    expect({ errors, modalRuns }).toEqual({ errors: [], modalRuns: 1 });
    expect(await crumbsAfter(page.handles, nav)).toEqual({
      crumbs: ["layout"],
      resolvedIds: expect.arrayContaining([page.slotId]),
    });
  });
});
