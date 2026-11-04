/**
 * The prefetch a link inside an open intercept sends: the speculative prefetch
 * header plus `X-RSC-Router-Intercept-Source` naming the page under the
 * intercept (browser/prefetch/fetch.ts). The server answers it against that
 * page, so the answer is the intercept over the source page — the same answer
 * the click that follows is given, which is what lets the click adopt it. The
 * same prefetch without the source is the intercepted URL's full page: the
 * answer a prefetch made outside an intercept warms, and never the one an
 * intercept adopts.
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

const loaderRuns: string[] = [];
const ItemLoader = createLoader(async (ctx) => {
  loaderRuns.push(ctx.params.id!);
  return { id: ctx.params.id };
});

const ListLoader = createLoader(async (ctx) => ({
  list: `list data ${ctx.params.id}`,
}));

function makeRouter() {
  return createRouter({}).routes(
    urls(({ path, layout, intercept, loader }) => [
      layout(
        () => <main>shell</main>,
        () => [
          path("/list/:id", () => <ul>list</ul>, { name: "list" }, () => [
            loader(ListLoader),
          ]),
          path("/item/:id", () => <article>item page</article>, {
            name: "item",
          }),
          intercept(
            "@modal",
            ".item",
            (ctx) => <dialog>modal {ctx.params.id}</dialog>,
            () => [loader(ItemLoader)],
          ),
        ],
      ),
    ]),
  );
}

interface Metadata {
  matched: string[];
  segments: Array<{ id: string; namespace?: string }>;
}

function metadataOf(flight: string | undefined): Metadata {
  const row = flight?.split("\n").find((line) => line.startsWith("0:"));
  expect(row).toBeDefined();
  return JSON.parse(row!.slice(2)).metadata as Metadata;
}

function interceptIds(metadata: Metadata): string[] {
  return metadata.segments
    .filter((segment) => segment.namespace?.startsWith("intercept:"))
    .map((segment) => segment.id);
}

beforeEach(() => {
  resetShellTestState();
  loaderRuns.length = 0;
});

describe("a prefetch made inside an open intercept", () => {
  /**
   * Opens the /item/2 intercept over /list/1, then requests /item/1 twice
   * from inside it: once as a link's prefetch, once as the click.
   */
  async function prefetchThenClick(interceptSource?: string) {
    const router = makeRouter();
    const cacheStore = new MemorySegmentCacheStore();
    const serve = (url: string, partial: Record<string, unknown>) =>
      serveShellRequest(router, url, { cacheStore, partial });
    const list = metadataOf((await serve("/list/1", { from: "/" })).flight);
    const opened = metadataOf(
      (await serve("/item/2", { from: "/list/1", segments: list.matched }))
        .flight,
    );
    expect(interceptIds(opened).length).toBeGreaterThan(0);
    loaderRuns.length = 0;

    const source = interceptSource ? { interceptSource } : {};
    const prefetched = await serve("/item/1", {
      from: "/item/2",
      segments: opened.matched,
      prefetch: true,
      ...source,
    });
    const clicked = await serve("/item/1", {
      from: "/item/2",
      segments: opened.matched,
      ...source,
    });
    return {
      prefetched: metadataOf(prefetched.flight),
      clicked: metadataOf(clicked.flight),
      prefetchedFlight: prefetched.flight ?? "",
      clickedFlight: clicked.flight ?? "",
    };
  }

  it("is answered as the click that follows it is: the item in the intercept over the source page", async () => {
    const { prefetched, clicked, prefetchedFlight, clickedFlight } =
      await prefetchThenClick("/list/1");

    expect(interceptIds(prefetched).length).toBeGreaterThan(0);
    expect(prefetchedFlight).toContain("modal");
    expect(prefetchedFlight).not.toContain("item page");
    // The slot's loader ran for the prefetched item: the answer carries the
    // data the modal shows, not a placeholder the click would refetch.
    expect(loaderRuns).toEqual(["1", "1"]);
    // The client adopts a prefetch by committing its answer in place of the
    // click's: the two must be the same tree.
    expect(prefetched.matched).toEqual(clicked.matched);
    expect(prefetched.segments.map((s) => s.id)).toEqual(
      clicked.segments.map((s) => s.id),
    );
    expect(clickedFlight).toContain("modal");
  });

  it("control: without the source the same prefetch is the item's full page, as outside an intercept", async () => {
    const { prefetched, clicked, prefetchedFlight } = await prefetchThenClick();

    expect(interceptIds(prefetched)).toEqual([]);
    expect(prefetchedFlight).toContain("item page");
    expect(prefetchedFlight).not.toContain("modal");
    expect(loaderRuns).toEqual([]);
    expect(prefetched.matched).toEqual(clicked.matched);
  });
});
