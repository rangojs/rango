import { Meta, type Handler } from "@rangojs/router";

function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Reviews index page - shows all reviews for a product
 */
export const ReviewsIndexRoute: Handler<"/product/:slug/reviews"> = (ctx) => {
  ctx.use(Meta)({ title: `Reviews — ${slugToTitle(ctx.params.slug)}` });
  return (
    <div>
      <h2>Reviews for {ctx.params.slug}</h2>
      <p>All reviews for this product</p>
    </div>
  );
};

/**
 * Single review detail page
 */
export const ReviewDetailRoute: Handler<"/product/:slug/reviews/:reviewId"> = (
  ctx,
) => {
  ctx.use(Meta)({ title: `Review #${ctx.params.reviewId}` });
  return (
    <div>
      <h2>Review {ctx.params.reviewId}</h2>
      <p>For product: {ctx.params.slug}</p>
    </div>
  );
};

/**
 * Edit review page
 */
export const ReviewEditRoute: Handler<
  "/product/:slug/reviews/:reviewId/edit"
> = (ctx) => {
  ctx.use(Meta)({ title: `Edit Review #${ctx.params.reviewId}` });
  return (
    <div>
      <h2>Edit Review {ctx.params.reviewId}</h2>
      <p>For product: {ctx.params.slug}</p>
      <p>4 levels deep!</p>
    </div>
  );
};
