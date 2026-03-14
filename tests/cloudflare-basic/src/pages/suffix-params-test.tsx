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
