import { Meta, type Handler } from "@rangojs/router";
import { Breadcrumbs } from "@/handles/breadcrumbs.js";
import { ProductsCategoryRoute, ProductsDetailRoute } from "./product.js";

/**
 * Helper to convert slug to title case
 * e.g., "wireless-headphones" -> "Wireless Headphones"
 */
function slugToTitle(slug: string): string {
  return slug
    .split("-")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Category route with breadcrumb support
 * Adds category breadcrumb then renders ProductsCategoryRoute
 */
export const CategoryRouteWithBreadcrumbs: Handler<"/products/:category"> = (
  ctx,
) => {
  const push = ctx.use(Breadcrumbs);
  const title = slugToTitle(ctx.params.category);
  push({
    label: title,
    href: `/shop/products/${ctx.params.category}`,
  });
  ctx.use(Meta)({ title });
  return ProductsCategoryRoute(ctx);
};

/**
 * Product detail route with breadcrumb support
 * Adds product breadcrumb then renders ProductsDetailRoute
 */
export const ProductDetailRouteWithBreadcrumbs: Handler<"/product/:slug"> = (
  ctx,
) => {
  const push = ctx.use(Breadcrumbs);
  const title = slugToTitle(ctx.params.slug);
  push({ label: title, href: `/shop/product/${ctx.params.slug}` });
  ctx.use(Meta)({ title });
  return ProductsDetailRoute(ctx);
};
