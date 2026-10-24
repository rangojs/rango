/**
 * An orphan layout (a layout with no routes: a sibling of its layout's
 * routes, or one a path() declares) whose handler re-ran for a partial
 * response replaces its handle values in the browser, as a chain layout's
 * does, even when it pushes nothing this time.
 *
 * The browser merges a partial response's handle data run by run
 * (mergePartialHandleData, handles/pushed-by.ts): a run's old values give way
 * only when the response delivers values of that run or lists it in
 * `resolvedIds`. resolveOrphanLayout (router/segment-resolution/revalidation.ts)
 * never marked the orphan's segment as run, so an orphan that re-ran and
 * pushed nothing kept its previous push on the page (a stale breadcrumb).
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

const TOUCH_ACTION = "src/orphan.actions.ts#touch";
async function touch(): Promise<void> {}

const errors: string[] = [];
/** Whether the orphans push on this request. */
let orphansPush = true;
/** The orphan handlers' runs. */
let orphanRuns = 0;

const router = createRouter({
  onError: ({ error }) => {
    errors.push(error instanceof Error ? error.message : String(error));
  },
}).routes(
  urls(({ path, layout, revalidate }) => [
    layout(
      (ctx: HandlerContext) => {
        ctx.use(Crumbs)("layout");
        return <main>shell</main>;
      },
      () => [
        layout(
          (ctx: HandlerContext) => {
            orphanRuns++;
            if (orphansPush) ctx.use(Crumbs)("orphan");
            return <aside>orphan</aside>;
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
          "/c",
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("c");
            return <p>c</p>;
          },
          { name: "c" },
          () => [
            layout(
              (ctx: HandlerContext) => {
                orphanRuns++;
                if (orphansPush) ctx.use(Crumbs)("c-orphan");
                return <nav>c orphan</nav>;
              },
              () => [revalidate(() => true)],
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

/** A document of `url` whose orphans push: its handles and mounted ids. */
async function documentOf(
  url: string,
): Promise<{ handles: HandleData; matched: string[]; crumbs: string[] }> {
  orphansPush = true;
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

beforeEach(async () => {
  errors.length = 0;
  orphansPush = true;
  await resetShellTestState();
});

describe("an orphan layout that re-runs and pushes nothing clears its handle values", () => {
  it("a layout's routeless sibling, on a navigation", async () => {
    const page = await documentOf("/a");
    expect(page.crumbs).toEqual(["layout", "orphan", "a"]);
    orphansPush = false;
    orphanRuns = 0;
    const nav = await serveShellRequest(router, "/b", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/a", segments: page.matched },
    });
    expect({ errors, orphanRuns }).toEqual({ errors: [], orphanRuns: 1 });
    expect(await crumbsAfter(page.handles, nav)).toEqual(["layout", "b"]);
  });

  it("a layout's routeless sibling, on an action", async () => {
    const page = await documentOf("/a");
    orphansPush = false;
    orphanRuns = 0;
    const action = await serveShellRequest(router, "/a", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: touch, id: TOUCH_ACTION, segments: page.matched },
    });
    expect({ errors, orphanRuns }).toEqual({ errors: [], orphanRuns: 1 });
    expect(await crumbsAfter(page.handles, action)).toEqual(["layout", "a"]);
  });

  it("a layout a path() declares, on a navigation", async () => {
    const page = await documentOf("/c");
    expect(page.crumbs).toEqual(["layout", "orphan", "c-orphan", "c"]);
    orphansPush = false;
    orphanRuns = 0;
    const nav = await serveShellRequest(router, "/c?v=2", {
      cacheStore: new MemorySegmentCacheStore(),
      partial: { from: "/c", segments: page.matched },
    });
    expect({ errors, orphanRuns }).toEqual({ errors: [], orphanRuns: 2 });
    expect(await crumbsAfter(page.handles, nav)).toEqual(["layout", "c"]);
  });

  it("a layout a path() declares, on an action", async () => {
    const page = await documentOf("/c");
    orphansPush = false;
    orphanRuns = 0;
    const action = await serveShellRequest(router, "/c", {
      cacheStore: new MemorySegmentCacheStore(),
      action: { ref: touch, id: TOUCH_ACTION, segments: page.matched },
    });
    expect({ errors, orphanRuns }).toEqual({ errors: [], orphanRuns: 2 });
    expect(await crumbsAfter(page.handles, action)).toEqual(["layout", "c"]);
  });
});
