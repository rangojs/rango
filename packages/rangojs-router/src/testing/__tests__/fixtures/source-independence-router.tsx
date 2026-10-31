/**
 * The router of source-independence.rsc-test.tsx: every way the server
 * decides to keep a segment the client holds, under held layouts, each
 * keyed on something a page renders.
 *
 * - shop: the #1331 reporter's app. A chrome layout holds the basket
 *   loader; under it the category template (a hero on category routes)
 *   re-renders when the category changes, above a clientUrls() group (PLP,
 *   product page, /cart, /search). The template has a loading() and a
 *   filters slot with its own loading(), shown on category pages, and a
 *   deal loader in it, each held by a predicate reading currentParams and
 *   keyed apart from the template's, so each can be the only segment a
 *   prefetch keeps for its source (revalidateFilters, revalidateDeal).
 * - baked: the same template above server routes, the product pages and
 *   /cart prerendered, so their stored entry decides (cache-lookup.ts
 *   storedEntrySends); its deal loader on the default rule (templateItems);
 *   a prerendered item under no revalidate() on a search-only change.
 * - cached: the same template and routes inside cache(), decided from the
 *   stored segments (cachedSegmentSends).
 * - In shop, baked and cached the product pages carry a route loader of the
 *   product, on the default rule; its `?ref=` re-run on a search-only change
 *   runs only in cached (`/cached/p1.html?ref=x`). The baked item has no
 *   loader: one would turn a keep of the item into a missing segment, which
 *   the property skips, so it would stop seeing storedEntrySends' marking. A
 *   predicate reading the source on any of these would mark the whole match
 *   source-held by itself and hide that marking too.
 * - field: one layout per source field a predicate reads (currentUrl,
 *   fromRouteName), one whose predicate reads only the destination, one held
 *   by its default, a parallel slot and a layout loader whose predicates
 *   read currentParams, and an intercept. The currentUrl layout and its
 *   route render a var its middleware sets from the destination, the route
 *   one from its own middleware; the held-by-default layout and the
 *   destination-only route have a loading().
 * - locale: the documented locale rule above two routes, so a prefetch the
 *   rule keeps the layout for is shared by the pages of one locale
 *   (`x-rsc-prefetch-scope: params`, rango-t242).
 */
import React from "react";
import {
  createLoader,
  createRouter,
  createVar,
  Prerender,
  type Middleware,
  type Rango,
  urls,
  type HandlerContext,
} from "../../../index.rsc.js";
import type { ShouldRevalidateFn } from "../../../types.js";
import {
  DealLoader,
  filtersOf,
  ProductLoader,
  revalidateCategoryTemplate,
  revalidateDeal,
  revalidateFilters,
  templateCategoryId,
} from "./source-independence-data.js";
import shop from "./source-independence-shop.js";

const BasketLoader = createLoader(async () => ({ items: 0 }));

/** A hero on a category route, only the outlet elsewhere. */
function CategoryTemplate(ctx: HandlerContext): React.ReactNode {
  const category = templateCategoryId(ctx.params);
  return (
    <section>
      {category === null ? "template" : <h1>{`hero:${category}`}</h1>}
    </section>
  );
}

/** The template's filters slot. */
function FiltersSlot(ctx: HandlerContext): React.ReactNode {
  return <aside>{`filters:${filtersOf(ctx.params)}`}</aside>;
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

/** The section the url layout's middleware reads from the destination. */
const Section = createVar<string>();
/** The id the url route's middleware reads from the destination. */
const Visit = createVar<string>();

const sectionMiddleware: Middleware = async (ctx, next) => {
  ctx.set(Section, sectionOf(ctx.url));
  await next();
};
const visitMiddleware: Middleware = async (ctx, next) => {
  ctx.set(Visit, `visit:${ctx.params.id}`);
  await next();
};

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
      loading,
      middleware,
      parallel,
      path,
      revalidate,
    }) => {
      /**
       * The category template's items in every family: its predicate, a
       * loading(), and the filters slot with its deal loader.
       *
       * Under a prerendered target the deal loader keeps its default rule.
       * Loaders resolve live there, so a predicate reading the source would
       * mark every keep of it source-held, (search, cart) included, and hide
       * whether storedEntrySends marks the template it keeps on equal params.
       */
      const templateItems = (deal: "source" | "default") => [
        revalidate(revalidateCategoryTemplate),
        loading(<p>template-loading</p>),
        parallel({ "@filters": FiltersSlot }, () => [
          revalidate(revalidateFilters),
          deal === "source"
            ? loader(DealLoader, () => [revalidate(revalidateDeal)])
            : loader(DealLoader),
          loading(<p>filters-loading</p>),
        ]),
      ];
      return [
        layout(
          () => <main>chrome</main>,
          () => [
            loader(BasketLoader, () => [
              revalidate(({ isAction }) => isAction()),
            ]),
            layout(CategoryTemplate, () => [
              ...templateItems("source"),
              include("/", shop, { name: "shop" }),
            ]),
            layout(CategoryTemplate, () => [
              ...templateItems("default"),
              path(
                "/baked/c/:category",
                (ctx) => <ul>{`plp:${ctx.params.category}`}</ul>,
                { name: "bakedPlp" },
              ),
              path(
                "/baked/:productId.html",
                BakedProduct,
                { name: "bakedProduct" },
                () => [loader(ProductLoader)],
              ),
              path("/baked/cart", BakedCart, { name: "bakedCart" }),
              path(
                "/baked/search",
                (ctx) => (
                  <ul>{`search:${ctx.url.searchParams.get("text")}`}</ul>
                ),
                { name: "bakedSearch" },
              ),
            ]),
            path("/baked/item/:id", BakedItem, { name: "bakedItem" }),
            cache({ ttl: 600 }, () => [
              layout(CategoryTemplate, () => [
                ...templateItems("source"),
                path(
                  "/cached/c/:category",
                  (ctx) => <ul>{`plp:${ctx.params.category}`}</ul>,
                  { name: "cachedPlp" },
                ),
                path(
                  "/cached/:productId.html",
                  (ctx) => (
                    <article>{`product:${ctx.params.productId}`}</article>
                  ),
                  { name: "cachedProduct" },
                  () => [loader(ProductLoader)],
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
              (ctx) => <section>{`section:${ctx.get(Section)}`}</section>,
              () => [
                middleware(sectionMiddleware),
                revalidate(({ currentUrl, nextUrl, defaultShouldRevalidate }) =>
                  sectionOf(currentUrl) !== sectionOf(nextUrl)
                    ? true
                    : defaultShouldRevalidate,
                ),
                path(
                  "/f/url/:id",
                  (ctx) => (
                    <article>{`url:${ctx.params.id}:${ctx.get(Section)}:${ctx.get(Visit)}`}</article>
                  ),
                  { name: "fieldUrl" },
                  () => [middleware(visitMiddleware)],
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
                path("/f/name/a", () => <article>a</article>, {
                  name: "nameA",
                }),
                path("/f/name/b", () => <article>b</article>, {
                  name: "nameB",
                }),
                path("/f/name/c", () => <article>c</article>, {
                  name: "nameC",
                }),
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
                  () => [loading(<p>dest-loading</p>)],
                ),
              ],
            ),
            layout(
              (ctx) => <section>{`plain:${ctx.params.id}`}</section>,
              () => [
                loading(<p>plain-loading</p>),
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
            // The documented locale rule (guides/layouts.mdx): a prefetch
            // it keeps the layout for is shared by the pages of one locale
            // (`x-rsc-prefetch-scope: params`), of either route.
            layout(
              (ctx) => <section>{`locale:${ctx.params.locale}`}</section>,
              () => [
                revalidate(
                  ({ currentParams, nextParams }) =>
                    currentParams.locale !== nextParams.locale || undefined,
                ),
                path(
                  "/l/:locale/products",
                  (ctx) => (
                    <ul>{`products:${ctx.url.searchParams.get("page")}`}</ul>
                  ),
                  { name: "localeProducts" },
                ),
                path("/l/:locale/about", () => <article>about</article>, {
                  name: "localeAbout",
                }),
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
      ];
    },
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
  locale: [
    "/l/en/products?page=1",
    "/l/en/products?page=2",
    "/l/en/about",
    "/l/fr/products?page=1",
  ],
};
