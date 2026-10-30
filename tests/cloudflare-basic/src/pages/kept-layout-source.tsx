import type { ReactNode } from "react";
import { urls, type Revalidate } from "@rangojs/router";
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
