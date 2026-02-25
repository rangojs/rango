import type { HandlerContext } from "@rangojs/router";

// Locale info page — tests constrained param routing (Bug 1)
export function LocaleInfoPage(ctx: HandlerContext<{ locale: "en" | "fr" }>) {
  return (
    <div data-testid="locale-info-page">
      <h1 data-testid="locale-value">Locale: {ctx.params.locale}</h1>
    </div>
  );
}

// Item detail page — tests param name at shared depth (Bug 2)
export function ItemDetailPage(ctx: HandlerContext<{ itemId: string }>) {
  return (
    <div data-testid="item-detail-page">
      <h1 data-testid="item-id-value">Item ID: {ctx.params.itemId}</h1>
    </div>
  );
}

// Product reviews page — tests different param name at same depth (Bug 2)
export function ProductReviewsPage(ctx: HandlerContext<{ productId: string }>) {
  return (
    <div data-testid="product-reviews-page">
      <h1 data-testid="product-id-value">Product ID: {ctx.params.productId}</h1>
    </div>
  );
}

// Catch-all wildcard page
export function CatchAllPage(ctx: HandlerContext) {
  return (
    <div data-testid="catch-all-page">
      <h1 data-testid="wildcard-value">
        Wildcard: {(ctx.params as Record<string, string>)["*"]}
      </h1>
    </div>
  );
}
