import type { ReactNode } from "react";
import { Prerender, urls, type Revalidate } from "@rangojs/router";
import { Link, Outlet } from "@rangojs/router/client";
import keptLayoutSourceGroup from "../kept-layout-source/urls.js";

// #1331: a server layout above a clientUrls() group renders a category hero
// on category pages only, and its revalidate() compares the source page's
// category with the destination's. A prefetch of /cart sent from a product
// page holds the layout; clicked from a category page, that answer must not
// keep the category page's copy. One mount per template shape: the hero
// beside a moving <Outlet /> (the reporter's), and a fixed shape.
// Body: tests/shared-e2e/src/kept-layout-source-scenario.ts.

const categoryOf = (params: Record<string, string | undefined>) =>
  params.category ?? null;

const revalidateKeptTemplate: Revalidate = ({
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

function KeptChrome({ base }: { base: string }): ReactNode {
  return (
    <section data-testid="kls-chrome">
      <nav>
        <Link to={`${base}/c/audio`} prefetch="hover" data-testid="kls-to-c">
          Audio
        </Link>
        <Link to={`${base}/p/1`} prefetch="hover" data-testid="kls-to-p1">
          Product 1
        </Link>
        <Link to={`${base}/p/2`} prefetch="hover" data-testid="kls-to-p2">
          Product 2
        </Link>
        <Link to={`${base}/cart`} prefetch="hover" data-testid="kls-to-cart">
          Cart
        </Link>
      </nav>
      <Outlet />
    </section>
  );
}

const hero = (category: string) => (
  <p data-testid="kls-hero">{`hero:${category}`}</p>
);

/** <Outlet /> alone without a category; hero, <Outlet />, footer with one. */
function TwoShapeTemplate({ category }: { category: string | null }) {
  if (category === null) return <Outlet />;
  return (
    <>
      {hero(category)}
      <Outlet />
      <p data-testid="kls-footer">footer</p>
    </>
  );
}

/** The same render with <Outlet /> at one position. */
function OneShapeTemplate({ category }: { category: string | null }) {
  return (
    <>
      {category !== null && hero(category)}
      <Outlet />
    </>
  );
}

export const keptLayoutSourceTwoShapePatterns = urls(
  ({ layout, include, revalidate }) => [
    layout(
      () => <KeptChrome base="/kept-layout-source/two" />,
      () => [
        layout(
          (ctx) => <TwoShapeTemplate category={categoryOf(ctx.params)} />,
          () => [
            revalidate(revalidateKeptTemplate),
            include("/", keptLayoutSourceGroup),
          ],
        ),
      ],
    ),
  ],
);

export const keptLayoutSourceOneShapePatterns = urls(
  ({ layout, include, revalidate }) => [
    layout(
      () => <KeptChrome base="/kept-layout-source/one" />,
      () => [
        layout(
          (ctx) => <OneShapeTemplate category={categoryOf(ctx.params)} />,
          () => [
            revalidate(revalidateKeptTemplate),
            include("/", keptLayoutSourceGroup),
          ],
        ),
      ],
    ),
  ],
);

// The template above server pages, /cart and /item/:id prerendered. In
// production a stored entry asks the template's revalidate() only when the
// params change (/wishlist -> /cart: both {}), and keeps the route's own
// segment on a search-only change (/item/1?tab=a -> /item/1?tab=b); either
// keep is right for its source only. Dev renders them live.
const KeptBakedCart = Prerender(() => <p data-testid="kls-page">cart</p>);

const KeptBakedItem = Prerender<{ id: string }>(
  async () => [{ id: "1" }, { id: "2" }],
  (ctx) => <p data-testid="kls-page">{`item:${ctx.params.id}`}</p>,
);

const BAKED_BASE = "/kept-layout-source/baked";

function KeptBakedChrome(): ReactNode {
  return (
    <section data-testid="kls-chrome">
      <nav>
        <Link
          to={`${BAKED_BASE}/c/audio`}
          prefetch="hover"
          data-testid="kls-to-c"
        >
          Audio
        </Link>
        <Link
          to={`${BAKED_BASE}/wishlist`}
          prefetch="hover"
          data-testid="kls-to-wishlist"
        >
          Wishlist
        </Link>
        <Link
          to={`${BAKED_BASE}/cart`}
          prefetch="hover"
          data-testid="kls-to-cart"
        >
          Cart
        </Link>
        <Link
          to={`${BAKED_BASE}/item/1?tab=b`}
          prefetch="hover"
          data-testid="kls-to-item1b"
        >
          Item 1, tab b
        </Link>
        <Link
          to={`${BAKED_BASE}/item/2`}
          prefetch="hover"
          data-testid="kls-to-item2"
        >
          Item 2
        </Link>
      </nav>
      <Outlet />
    </section>
  );
}

export const keptLayoutSourceBakedPatterns = urls(
  ({ layout, path, revalidate }) => [
    layout(<KeptBakedChrome />, () => [
      layout(
        (ctx) => <TwoShapeTemplate category={categoryOf(ctx.params)} />,
        () => [
          revalidate(revalidateKeptTemplate),
          path(
            "/c/:category",
            (ctx) => (
              <p data-testid="kls-page">{`plp:${ctx.params.category}`}</p>
            ),
            { name: "plp" },
          ),
          path("/wishlist", () => <p data-testid="kls-page">wishlist</p>, {
            name: "wishlist",
          }),
          path("/cart", KeptBakedCart, { name: "cart" }),
        ],
      ),
      // Under no revalidate(): only the route's own segment decides.
      path("/item/:id", KeptBakedItem, { name: "item" }),
    ]),
  ],
);
