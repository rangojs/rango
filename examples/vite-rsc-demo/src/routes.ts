import { route } from "@rangojs/router";

/**
 * Shop routes - comprehensive ecommerce example
 * Tests nested routes, dynamic segments, layout composition, and parallel routes
 *
 * Note: This is the only route set still using the legacy routes().map() pattern.
 * All other routes have been migrated to the Django-style urls() API in urls.tsx.
 */
export const shopRoutes = route({
  "shop.index": "/",
  "shop.products.category": "/products/:category",
  "shop.products.detail.view": "/product/:slug",
  "shop.products.detail.reviews.index": "/product/:slug/reviews",
  "shop.products.detail.reviews.detail": "/product/:slug/reviews/:reviewId",
  "shop.products.detail.reviews.edit.index": "/product/:slug/reviews/:reviewId/edit",
  "shop.cart": "/cart",
  "shop.checkout.index": "/checkout",
  "shop.checkout.payment": "/checkout/payment",
  "shop.checkout.confirm": "/checkout/confirm",
  "shop.account.index": "/account",
  "shop.account.orders": "/account/orders",
  "shop.account.orderDetail": "/account/orders/:id",
});
