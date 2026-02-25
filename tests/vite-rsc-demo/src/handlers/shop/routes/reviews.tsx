import type { Handler } from "@rangojs/router";

/**
 * Reviews index page - shows all reviews for a product
 */
export const ReviewsIndexRoute: Handler<"/product/:slug/reviews"> = (ctx) => (
  <div>
    <h2>Reviews for {ctx.params.slug}</h2>
    <p>All reviews for this product</p>
  </div>
);

/**
 * Single review detail page
 */
export const ReviewDetailRoute: Handler<"/product/:slug/reviews/:reviewId"> = (
  ctx,
) => (
  <div>
    <h2>Review {ctx.params.reviewId}</h2>
    <p>For product: {ctx.params.slug}</p>
  </div>
);

/**
 * Edit review page
 */
export const ReviewEditRoute: Handler<
  "/product/:slug/reviews/:reviewId/edit"
> = (ctx) => (
  <div>
    <h2>Edit Review {ctx.params.reviewId}</h2>
    <p>For product: {ctx.params.slug}</p>
    <p>4 levels deep!</p>
  </div>
);
