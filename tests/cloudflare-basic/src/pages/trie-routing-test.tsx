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

// Prefixed wildcard page — tests the C1 bare-prefix-wildcard match. Hitting the
// bare prefix "/files" must resolve "/files/*" with an EMPTY splat (""), not
// regex-fallback to a corrupt "/file" redirect. Rendered in brackets so an
// empty splat is observable as "[]" vs "[a/b]" for a deeper path.
export function FilesWildcardPage(ctx: HandlerContext) {
  const splat = (ctx.params as Record<string, string>)["*"];
  return (
    <div data-testid="files-wildcard-page">
      <h1 data-testid="files-splat-value">Files splat: [{splat}]</h1>
    </div>
  );
}
