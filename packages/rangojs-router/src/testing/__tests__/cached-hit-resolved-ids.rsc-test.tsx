/**
 * A cache() or Prerender() HIT lists in `resolvedIds` what a live render of
 * the same navigation lists: every segment whose handler layer the response
 * replaces, so the browser replaces that run's handle values
 * (mergePartialHandleData, handles/pushed-by.ts).
 *
 * A stored record carries no `_handlerRan`: serializeSegments
 * (cache/segment-codec.ts) copies named fields, and the record is written by
 * another render (a proactive re-render runs every handler), so a persisted
 * flag would name every segment on every HIT. The serve path therefore marks
 * each segment it sends in place of a re-run handler (cache-lookup.ts), and a
 * HIT names the same ids its MISS named.
 *
 * The case below: a chain layout whose `revalidate()` re-runs it on every
 * navigation, pushing its breadcrumb crumb on the document and nothing after.
 * The MISS cleared the crumb; the HIT listed nothing, so the merge kept the
 * client's copy and the crumb came back.
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
  Prerender,
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

/** Whether the chain layout pushes its crumb on this request. */
let chainPushes = true;

/**
 * Where the target page's handler layer comes from: rendered for the request,
 * a cache() record, or a `Prerender()` bake. Every other part of the tree is
 * the same, so a segment id means the same segment in each.
 */
type Source = "live" | "cache" | "prerender";

/** The detail page's body, its crumb pushed by `push`. */
function itemPage(push: (crumb: string) => void, id: string): React.ReactNode {
  push(`item-${id}`);
  return <article>item {id}</article>;
}

function makeRouter(source: Source, withIntercept = false) {
  return createRouter({}).routes(
    urls(({ path, layout, cache, revalidate, intercept }) => {
      const item = (ctx: HandlerContext<{ id: string }>): React.ReactNode =>
        itemPage(ctx.use(Crumbs), ctx.params.id);
      const chain = () =>
        layout(
          (ctx: HandlerContext) => {
            if (chainPushes) ctx.use(Crumbs)("chain");
            return <section>chain</section>;
          },
          () => [
            // A chain layout: it re-runs on every navigation.
            revalidate(() => true),
            path(
              "/a",
              (ctx: HandlerContext) => {
                ctx.use(Crumbs)("a");
                return <p>a</p>;
              },
              { name: "a" },
            ),
            source === "prerender"
              ? path(
                  "/item/:id",
                  Prerender(
                    async () => [{ id: "1" }],
                    (ctx) => itemPage(ctx.use(Crumbs), ctx.params.id),
                  ),
                  { name: "item" },
                )
              : path("/item/:id", item, { name: "item" }),
            // Declared only where a test asks for it.
            ...(withIntercept
              ? [
                  intercept("@modal", ".item", (ctx: HandlerContext) => {
                    ctx.use(Crumbs)("modal");
                    return <dialog>modal</dialog>;
                  }),
                ]
              : []),
          ],
        );
      const root = () =>
        layout(
          (ctx: HandlerContext) => {
            ctx.use(Crumbs)("root");
            return <main>shell</main>;
          },
          () => [
            source === "cache" ? cache({ ttl: 600 }, () => [chain()]) : chain(),
          ],
        );
      return [root()];
    }),
  );
}

type Router = ReturnType<typeof makeRouter>;

interface Answer {
  matched: string[];
  resolvedIds?: string[];
  segments: { id: string; type: string; component: unknown }[];
}

async function answerOf(result: ServeShellRequestResult): Promise<Answer> {
  return (await deserializeResult<{ metadata: Answer }>(result.flight!))
    .metadata;
}

/** The last handle state a response streamed. */
async function handlesOf(result: ServeShellRequestResult): Promise<HandleData> {
  const { metadata } = await deserializeResult<{
    metadata: { handles?: AsyncIterable<HandleData> };
  }>(result.flight!);
  let last: HandleData = {};
  for await (const data of metadata.handles ?? []) last = data;
  return last;
}

/** The page's crumbs after a partial response, merged as the browser merges. */
async function crumbsAfter(
  current: HandleData,
  result: ServeShellRequestResult,
): Promise<string[]> {
  const answer = await answerOf(result);
  const order = filterSegmentOrder(answer.matched);
  return collectHandleData(
    Crumbs,
    mergePartialHandleData(
      current,
      await handlesOf(result),
      order,
      answer.matched,
      answer.resolvedIds,
    ),
    order,
  );
}

/** The id of the segment that holds `crumb` in a document's handle data. */
async function segmentOf(
  result: ServeShellRequestResult,
  crumb: string,
): Promise<string> {
  const data = await handlesOf(result);
  const [id] = Object.entries(data[Crumbs.$$id] ?? {})
    .filter(([, values]) => (values as string[]).includes(crumb))
    .map(([segmentId]) => segmentId);
  return id!;
}

/**
 * The document the client shows, its handle data and mounted ids, and the
 * `resolvedIds` a partial response of `router` names.
 */
async function pageOf(
  router: Router,
  url: string,
  store = new MemorySegmentCacheStore(),
) {
  const result = await serveShellRequest(router, url, { cacheStore: store });
  const answer = await answerOf(result);
  return {
    handles: await handlesOf(result),
    matched: answer.matched,
    crumbs: await crumbsAfter({}, result),
    store,
  };
}

/** The response the client's navigation sends. */
function navigate(
  router: Router,
  url: string,
  partial: { from: string; segments: string[] },
  store: MemorySegmentCacheStore,
): Promise<ServeShellRequestResult> {
  return serveShellRequest(router, url, { cacheStore: store, partial });
}

beforeEach(async () => {
  chainPushes = true;
  await resetShellTestState();
});

describe("a stored HIT names the runs its MISS named in resolvedIds", () => {
  it("a cache() HIT clears the re-run chain layout's crumb as the MISS does", async () => {
    const router = makeRouter("cache");
    const page = await pageOf(router, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);
    const chainId = await segmentOf(
      await serveShellRequest(router, "/a", {
        cacheStore: new MemorySegmentCacheStore(),
      }),
      "chain",
    );

    chainPushes = false;
    const partial = { from: "/a", segments: page.matched };
    const miss = await navigate(router, "/item/1", partial, page.store);
    const missAnswer = await answerOf(miss);
    const hit = await navigate(router, "/item/1", partial, page.store);
    const hitAnswer = await answerOf(hit);

    // The chain layout re-ran on the MISS; the route is new to the page.
    expect(missAnswer.resolvedIds).toContain(chainId);
    // A held segment without rules is not named, on either.
    expect(missAnswer.resolvedIds).not.toContain(page.matched[0]);
    expect(hitAnswer.resolvedIds).toEqual(missAnswer.resolvedIds);
    // The HIT sends the same segments, so it names them all.
    expect(hitAnswer.segments.map((s) => s.id)).toEqual(
      missAnswer.segments.map((s) => s.id),
    );
    expect(await crumbsAfter(page.handles, miss)).toEqual(["root", "item-1"]);
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "item-1"]);
  });

  it("names the intercept slot without sending an internal field for it", async () => {
    const router = makeRouter("cache", true);
    const page = await pageOf(router, "/a");
    const partial = {
      from: "/a",
      segments: page.matched,
      interceptSource: "/a",
    };
    await navigate(router, "/item/1", partial, page.store);
    const hit = await navigate(router, "/item/1", partial, page.store);
    const answer = await answerOf(hit);
    const slot = answer.segments.find((s) => s.id.includes(".@"))!;
    expect(answer.resolvedIds).toContain(slot.id);
    // The slot's segments ride the payload's `slots` unstripped: no internal
    // marker may be written on one.
    expect(hit.flight).not.toContain("_handlerRan");
  });

  it("a Prerender() bake HIT clears it as a live render of the same navigation does", async () => {
    const live = makeRouter("live");
    const livePage = await pageOf(live, "/a");
    chainPushes = false;
    const liveNav = await navigate(
      live,
      "/item/1",
      { from: "/a", segments: livePage.matched },
      new MemorySegmentCacheStore(),
    );
    const liveAnswer = await answerOf(liveNav);

    chainPushes = true;
    const baked = makeRouter("prerender");
    const page = await pageOf(baked, "/a");
    expect(page.crumbs).toEqual(["root", "chain", "a"]);
    chainPushes = false;
    const partial = { from: "/a", segments: page.matched };
    // The first request bakes the page and serves it; the second is its HIT.
    const bake = await navigate(baked, "/item/1", partial, page.store);
    const hit = await navigate(baked, "/item/1", partial, page.store);

    for (const result of [bake, hit]) {
      const answer = await answerOf(result);
      expect(answer.resolvedIds).toEqual(liveAnswer.resolvedIds);
      expect(await crumbsAfter(page.handles, result)).toEqual(
        await crumbsAfter(livePage.handles, liveNav),
      );
    }
    expect(await crumbsAfter(page.handles, hit)).toEqual(["root", "item-1"]);
  });
});
