/**
 * #1331: a prefetch whose answer held a segment because a revalidate() read
 * the source page (currentParams, currentUrl, fromRouteName) is that page's
 * answer only, through the public serveShellRequest primitive and the
 * browser's own reconcile step.
 *
 * The shape is the reporter's: a server layout above a clientUrls() group
 * (PLPs, a product page, /cart) renders a category hero on category pages,
 * and its revalidate() re-renders it when the category changes. A prefetch
 * of /cart sent from a product page holds the layout. The browser keeps a
 * prefetch shared between source pages unless the response says
 * `x-rsc-prefetch-scope: source` (browser/prefetch/fetch.ts), and a page
 * that adopts it keeps ITS copy of every segment the answer held
 * (browser/segment-reconciler.ts): clicked from a category page, the cart
 * rendered under that page's hero.
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
  createLoader,
  createRouter,
  Prerender,
  urls,
} from "../../index.rsc.js";
import { MemorySegmentCacheStore } from "../../cache/index.js";
import { deserializeResult } from "../../cache/segment-codec.js";
import { reconcileSegments } from "../../browser/segment-reconciler.js";
import type { ResolvedSegment, ShouldRevalidateFn } from "../../types.js";
import group from "./fixtures/kept-layout-source.js";

const BasketLoader = createLoader(async () => ({ items: 0 }));

const categoryOf = (params: Record<string, string | undefined>) =>
  params.category ?? null;

const revalidateTemplate: ShouldRevalidateFn = ({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  if (isAction()) return false;
  return categoryOf(currentParams) !== categoryOf(nextParams)
    ? true
    : defaultShouldRevalidate;
};

/** Runs of the prerendered cart's handler: its bake's only. */
const bakedCartRuns = { count: 0 };

const BakedCart = Prerender(() => {
  bakedCartRuns.count += 1;
  return <article>cart</article>;
});

const BakedItem = Prerender<{ id: string }>(
  async () => [{ id: "1" }, { id: "2" }],
  (ctx) => <article>{`item:${ctx.params.id}`}</article>,
);

/** The template's render: the hero on a category page only. */
function Template({ category }: { category: string | null }) {
  return <section>{category === null ? "outlet" : `hero:${category}`}</section>;
}

const router = createRouter({}).routes(
  urls(({ layout, include, loader, path, revalidate }) => [
    layout(
      () => <main>chrome</main>,
      () => [
        // Reads no source field: the basket's answer is the same from every page.
        loader(BasketLoader, () => [revalidate(({ isAction }) => isAction())]),
        layout(
          (ctx) => <Template category={categoryOf(ctx.params)} />,
          () => [
            revalidate(revalidateTemplate),
            include("/", group, { name: "shop" }),
          ],
        ),
        // The same template above server routes, the cart prerendered: its
        // stored entry asks the template's revalidate() only when the params
        // changed (cache-lookup.ts storedEntrySends).
        layout(
          (ctx) => <Template category={categoryOf(ctx.params)} />,
          () => [
            revalidate(revalidateTemplate),
            path("/baked/c/:category", () => <ul>plp</ul>, {
              name: "bakedPlp",
            }),
            path("/baked/wishlist", () => <ul>wishlist</ul>, {
              name: "bakedWishlist",
            }),
            path("/baked/cart", BakedCart, { name: "bakedCart" }),
          ],
        ),
        // A prerendered route under no revalidate(): its stored entry keeps
        // the route's own segment on equal params, whatever the search.
        path("/baked/item/:id", BakedItem, { name: "bakedItem" }),
        // The same template held by the layout default (no revalidate()).
        layout(
          (ctx) => <Template category={categoryOf(ctx.params)} />,
          () => [include("/plain", group, { name: "plain" })],
        ),
      ],
    ),
  ]),
);

interface Metadata {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
}

async function metadataOf(result: ServeShellRequestResult): Promise<Metadata> {
  const { metadata } = await deserializeResult<{ metadata: Metadata }>(
    result.flight!,
  );
  return metadata;
}

const cacheStore = new MemorySegmentCacheStore();
const serve = (
  url: string,
  extra: Omit<ServeShellRequestOptions, "cacheStore">,
) => serveShellRequest(router, url, { cacheStore, ...extra });

/** The page `at` once a navigation to it committed: its segments. */
async function standingOn(at: string): Promise<Metadata> {
  return metadataOf(await serve(at, { partial: { from: "/elsewhere" } }));
}

/** A `<Link>` prefetch of `to` sent from `from`, which holds `held`. */
const prefetch = (from: string, held: Metadata, to: string) =>
  serve(to, { partial: { from, segments: held.matched, prefetch: true } });

const scopeOf = (result: ServeShellRequestResult) =>
  result.response.headers.get("x-rsc-prefetch-scope");

/** The template's segment: the layout right above the group's route. */
const templateOf = (page: Metadata): ResolvedSegment =>
  page.segments.filter((s) => s.type === "layout").at(-1)!;

/** The page's route segment. */
const routeOf = (page: Metadata): ResolvedSegment =>
  page.segments.find((s) => s.type === "route")!;

beforeEach(async () => {
  bakedCartRuns.count = 0;
  await resetShellTestState();
});

describe("a prefetch a revalidate() answered from the source page", () => {
  it("held the template from a product page: the answer is scoped to that page", async () => {
    const product = await standingOn("/p/1");
    const category = await standingOn("/c/audio");
    const template = templateOf(product).id;
    expect(templateOf(category).id).toBe(template);

    const fromProduct = await prefetch("/p/1", product, "/cart");
    const answer = await metadataOf(fromProduct);
    expect(answer.matched).toContain(template);
    expect(answer.diff).not.toContain(template);

    // What a category page that adopted it would render: its own copy, the
    // hero, above the cart.
    const adopted = reconcileSegments({
      actor: "navigation",
      matched: answer.matched,
      diff: answer.diff,
      serverSegments: answer.segments,
      cachedSegments: category.segments,
      insertMissingDiff: true,
    });
    expect(adopted.segments.find((s) => s.id === template)).toBe(
      templateOf(category),
    );

    expect(scopeOf(fromProduct)).toBe("source");
  });

  it("re-rendered the template from a category page: the answer is shared", async () => {
    const category = await standingOn("/c/audio");
    const template = templateOf(category).id;

    const fromCategory = await prefetch("/c/audio", category, "/cart");
    expect((await metadataOf(fromCategory)).diff).toContain(template);
    expect(scopeOf(fromCategory)).toBeNull();
  });

  it("a layout held by its default, under a predicate that reads no source field, is shared", async () => {
    const product = await standingOn("/plain/p/1");
    const template = templateOf(product).id;

    const fromProduct = await prefetch("/plain/p/1", product, "/plain/cart");
    expect((await metadataOf(fromProduct)).diff).not.toContain(template);
    expect(scopeOf(fromProduct)).toBeNull();
  });
});

describe("a prefetch of a prerendered target served from its stored entry", () => {
  it("held the template from a page with the same params, its revalidate() not asked: the answer is scoped to that page", async () => {
    const wishlist = await standingOn("/baked/wishlist");
    const category = await standingOn("/baked/c/audio");
    const template = templateOf(wishlist).id;
    expect(templateOf(category).id).toBe(template);
    // Bake the cart; the prefetch is served from the bake.
    await serve("/baked/cart", {});
    const bakes = bakedCartRuns.count;

    const fromWishlist = await prefetch(
      "/baked/wishlist",
      wishlist,
      "/baked/cart",
    );
    expect(bakedCartRuns.count).toBe(bakes);
    const answer = await metadataOf(fromWishlist);
    expect(answer.matched).toContain(template);
    expect(answer.diff).not.toContain(template);
    expect(scopeOf(fromWishlist)).toBe("source");
  });

  it("re-rendered the template from a category page: the answer is shared", async () => {
    const category = await standingOn("/baked/c/audio");
    const template = templateOf(category).id;
    await serve("/baked/cart", {});

    const fromCategory = await prefetch(
      "/baked/c/audio",
      category,
      "/baked/cart",
    );
    expect((await metadataOf(fromCategory)).diff).toContain(template);
    expect(scopeOf(fromCategory)).toBeNull();
  });

  it("kept the route's own segment on a search-only change: the answer is scoped to that page", async () => {
    const tabA = await standingOn("/baked/item/1?tab=a");
    const item2 = await standingOn("/baked/item/2");
    const route = routeOf(tabA).id;
    expect(routeOf(item2).id).toBe(route);

    const fromTabA = await prefetch(
      "/baked/item/1?tab=a",
      tabA,
      "/baked/item/1?tab=b",
    );
    const answer = await metadataOf(fromTabA);
    expect(answer.matched).toContain(route);
    expect(answer.diff).not.toContain(route);

    // What /baked/item/2 would render had it adopted it: item 2's route.
    const adopted = reconcileSegments({
      actor: "navigation",
      matched: answer.matched,
      diff: answer.diff,
      serverSegments: answer.segments,
      cachedSegments: item2.segments,
      insertMissingDiff: true,
    });
    expect(adopted.segments.find((s) => s.id === route)).toBe(routeOf(item2));

    expect(scopeOf(fromTabA)).toBe("source");
  });

  it("sent the route's own segment from a page with other params: the answer is shared", async () => {
    const item2 = await standingOn("/baked/item/2");
    const route = routeOf(item2).id;

    const fromItem2 = await prefetch(
      "/baked/item/2",
      item2,
      "/baked/item/1?tab=b",
    );
    expect((await metadataOf(fromItem2)).diff).toContain(route);
    expect(scopeOf(fromItem2)).toBeNull();
  });
});
