import type { HandlerContext } from "@rangojs/router";

// Product page — tests param with .html suffix (e.g. /shop/:productId.html)
export function ShopProductPage(ctx: HandlerContext<{ productId: string }>) {
  return (
    <div data-testid="shop-product-page">
      <h1 data-testid="shop-product-id">Product: {ctx.params.productId}</h1>
    </div>
  );
}

// Category page — tests plain param at same prefix (e.g. /shop/:categoryId)
export function ShopCategoryPage(ctx: HandlerContext<{ categoryId: string }>) {
  return (
    <div data-testid="shop-category-page">
      <h1 data-testid="shop-category-id">Category: {ctx.params.categoryId}</h1>
    </div>
  );
}

// Archive page — tests the LONGER overlapping suffix `.archive.html` against the
// shorter `.html`. /shop/x.archive.html must match here (slug "x"), not the
// .html product route (which would capture "x.archive"). Longest-suffix-wins.
export function ShopArchivePage(ctx: HandlerContext<{ slug: string }>) {
  return (
    <div data-testid="shop-archive-page">
      <h1 data-testid="shop-archive-slug">Archive: {ctx.params.slug}</h1>
    </div>
  );
}
