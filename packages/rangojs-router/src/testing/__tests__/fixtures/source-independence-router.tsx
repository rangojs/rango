/**
 * The router of source-independence.rsc-test.tsx: every way the server
 * decides to keep a segment the client holds, under held layouts, each
 * keyed on something a page renders.
 *
 * - shop: the #1331 reporter's app. A chrome layout holds the basket
 *   loader; under it the category template (a hero on category routes)
 *   re-renders when the category changes, above a clientUrls() group (PLP,
 *   product page, /cart, /search).
 * - baked: the same template above server routes, the product pages and
 *   /cart prerendered, so their stored entry decides (cache-lookup.ts
 *   storedEntrySends); a prerendered item under no revalidate() on a
 *   search-only change.
 * - cached: the same template and routes inside cache(), decided from the
 *   stored segments (cachedSegmentSends).
 * - field: one layout per source field a predicate reads (currentUrl,
 *   fromRouteName), one whose predicate reads only the destination, one held
 *   by its default, a parallel slot and a layout loader whose predicates
 *   read currentParams, and an intercept.
 */
import React from "react";
import {
  createLoader,
  createRouter,
  Prerender,
  type Rango,
  urls,
  type HandlerContext,
} from "../../../index.rsc.js";
import type { ShouldRevalidateFn } from "../../../types.js";
import shop from "./source-independence-shop.js";

const BasketLoader = createLoader(async () => ({ items: 0 }));

const templateCategoryId = (
  params: Record<string, string | undefined>,
): string | null => params.category ?? null;

/** The reporter's predicate (#1331). */
const revalidateCategoryTemplate: ShouldRevalidateFn = ({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) => {
  if (isAction()) return false;
  if (templateCategoryId(currentParams) !== templateCategoryId(nextParams)) {
    return true;
  }
  return defaultShouldRevalidate;
};

/** A hero on a category route, only the outlet elsewhere. */
function CategoryTemplate(ctx: HandlerContext): React.ReactNode {
  const category = templateCategoryId(ctx.params);
  return (
    <section>
      {category === null ? "template" : <h1>{`hero:${category}`}</h1>}
    </section>
  );
}

const BakedProduct = Prerender<{ productId: string }>(
  async () => [{ productId: "p1" }, { productId: "p2" }],
  (ctx) => <article>{`product:${ctx.params.productId}`}</article>,
);
const BakedCart = Prerender(() => <article>cart</article>);
const BakedItem = Prerender<{ id: string }>(
  async () => [{ id: "1" }, { id: "2" }],
  (ctx) => <article>{`item:${ctx.params.id}`}</article>,
);

/** `?s=` of a URL: the section the url layout renders. */
const sectionOf = (url: URL): string => url.searchParams.get("s") ?? "none";

/** The family of a route name the name layout renders. */
const kindOf = (name: string | undefined): string =>
  name === "nameC" ? "c" : "ab";

/** The band of an id the parallel slot and the loader render. */
const bandOf = (id: string | undefined): string =>
  Number(id) < 5 ? "low" : "high";

const BandLoader = createLoader(async (ctx) => ({
  band: bandOf(ctx.params.id),
}));

const bandChanged: ShouldRevalidateFn = ({
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}) =>
  bandOf(currentParams.id) !== bandOf(nextParams.id)
    ? true
    : defaultShouldRevalidate;

export const sourceIndependenceRouter: Rango<any, any> = createRouter(
  {},
).routes(
  urls(
    ({
      cache,
      include,
      intercept,
      layout,
      loader,
      parallel,
      path,
      revalidate,
    }) => [
      layout(
        () => <main>chrome</main>,
        () => [
          loader(BasketLoader, () => [
            revalidate(({ isAction }) => isAction()),
          ]),
          layout(CategoryTemplate, () => [
            revalidate(revalidateCategoryTemplate),
            include("/", shop, { name: "shop" }),
          ]),
          layout(CategoryTemplate, () => [
            revalidate(revalidateCategoryTemplate),
            path(
              "/baked/c/:category",
              (ctx) => <ul>{`plp:${ctx.params.category}`}</ul>,
              { name: "bakedPlp" },
            ),
            path("/baked/:productId.html", BakedProduct, {
              name: "bakedProduct",
            }),
            path("/baked/cart", BakedCart, { name: "bakedCart" }),
            path(
              "/baked/search",
              (ctx) => <ul>{`search:${ctx.url.searchParams.get("text")}`}</ul>,
              { name: "bakedSearch" },
            ),
          ]),
          path("/baked/item/:id", BakedItem, { name: "bakedItem" }),
          cache({ ttl: 600 }, () => [
            layout(CategoryTemplate, () => [
              revalidate(revalidateCategoryTemplate),
              path(
                "/cached/c/:category",
                (ctx) => <ul>{`plp:${ctx.params.category}`}</ul>,
                { name: "cachedPlp" },
              ),
              path(
                "/cached/:productId.html",
                (ctx) => <article>{`product:${ctx.params.productId}`}</article>,
                { name: "cachedProduct" },
              ),
              path("/cached/cart", () => <article>cart</article>, {
                name: "cachedCart",
              }),
              path(
                "/cached/search",
                (ctx) => (
                  <ul>{`search:${ctx.url.searchParams.get("text")}`}</ul>
                ),
                { name: "cachedSearch" },
              ),
            ]),
          ]),
          layout(
            (ctx) => <section>{`section:${sectionOf(ctx.url)}`}</section>,
            () => [
              revalidate(({ currentUrl, nextUrl, defaultShouldRevalidate }) =>
                sectionOf(currentUrl) !== sectionOf(nextUrl)
                  ? true
                  : defaultShouldRevalidate,
              ),
              path(
                "/f/url/:id",
                (ctx) => <article>{`url:${ctx.params.id}`}</article>,
                { name: "fieldUrl" },
              ),
            ],
          ),
          layout(
            (ctx) => <section>{`kind:${kindOf(ctx.routeName)}`}</section>,
            () => [
              revalidate(
                ({ fromRouteName, toRouteName, defaultShouldRevalidate }) =>
                  kindOf(fromRouteName) !== kindOf(toRouteName)
                    ? true
                    : defaultShouldRevalidate,
              ),
              path("/f/name/a", () => <article>a</article>, { name: "nameA" }),
              path("/f/name/b", () => <article>b</article>, { name: "nameB" }),
              path("/f/name/c", () => <article>c</article>, { name: "nameC" }),
            ],
          ),
          layout(
            (ctx) => <section>{`dest:${ctx.params.id}`}</section>,
            () => [
              revalidate(({ nextParams }) => nextParams.id === "9"),
              path(
                "/f/dest/:id",
                (ctx) => <article>{`dest:${ctx.params.id}`}</article>,
                { name: "fieldDest" },
              ),
            ],
          ),
          layout(
            (ctx) => <section>{`plain:${ctx.params.id}`}</section>,
            () => [
              path(
                "/f/plain/:id",
                (ctx) => <article>{`plain:${ctx.params.id}`}</article>,
                { name: "fieldPlain" },
              ),
            ],
          ),
          layout(
            () => <section>slots</section>,
            () => [
              parallel(
                {
                  "@side": (ctx: HandlerContext<{ id?: string }>) => (
                    <aside>{`side:${bandOf(ctx.params.id)}`}</aside>
                  ),
                },
                () => [revalidate(bandChanged)],
              ),
              path(
                "/f/par/:id",
                (ctx) => <article>{`par:${ctx.params.id}`}</article>,
                { name: "fieldPar" },
              ),
            ],
          ),
          layout(
            () => <section>loaded</section>,
            () => [
              loader(BandLoader, () => [revalidate(bandChanged)]),
              path(
                "/f/load/:id",
                (ctx) => <article>{`load:${ctx.params.id}`}</article>,
                { name: "fieldLoad" },
              ),
            ],
          ),
          layout(
            () => <section>boxes</section>,
            () => [
              path("/f/ix/list", () => <ul>list</ul>, { name: "ixList" }),
              path(
                "/f/ix/item/:id",
                (ctx) => <article>{`box:${ctx.params.id}`}</article>,
                { name: "ixItem" },
              ),
              intercept(
                "@modal",
                ".ixItem",
                (ctx: HandlerContext<{ id?: string }>) => (
                  <dialog>{`modal:${ctx.params.id}`}</dialog>
                ),
              ),
            ],
          ),
        ],
      ),
    ],
  ),
);

/** The fixture's pages, by family. */
export const SOURCE_INDEPENDENCE_URLS: Record<string, readonly string[]> = {
  shop: [
    "/search?text=kenwood",
    "/c/audio",
    "/c/speakers",
    "/p1.html",
    "/p2.html",
    "/cart",
  ],
  baked: [
    "/baked/search?text=kenwood",
    "/baked/c/audio",
    "/baked/c/speakers",
    "/baked/p1.html",
    "/baked/p2.html",
    "/baked/cart",
    "/baked/item/1?tab=a",
    "/baked/item/1?tab=b",
    "/baked/item/2",
  ],
  cached: [
    "/cached/search?text=kenwood",
    "/cached/c/audio",
    "/cached/c/speakers",
    "/cached/p1.html",
    "/cached/p1.html?ref=x",
    "/cached/cart",
  ],
  field: [
    "/f/url/1",
    "/f/url/1?s=x",
    "/f/url/2?s=x",
    "/f/url/2",
    "/f/name/a",
    "/f/name/b",
    "/f/name/c",
    "/f/dest/1",
    "/f/dest/2",
    "/f/dest/9",
    "/f/plain/1",
    "/f/plain/2",
    "/f/par/1",
    "/f/par/2",
    "/f/par/7",
    "/f/load/1",
    "/f/load/2",
    "/f/load/7",
    "/f/ix/list",
    "/f/ix/item/1",
    "/f/ix/item/2",
  ],
};
