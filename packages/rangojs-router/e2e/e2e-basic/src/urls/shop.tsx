import { urls } from "@rangojs/router";
import { ShopLayout } from "../components/layouts/index.js";
import {
  ShopIndexPage,
  ProductDetailPage,
  ProductModal,
  CartPage,
} from "../components/pages/index.js";

/**
 * Shop URL patterns with modal intercept
 * Routes: shop.index, shop.product, shop.cart
 */
export const shopPatterns = urls(({ path, layout, intercept, when }) => [
  layout(ShopLayout, () => [
    path("/", ShopIndexPage, { name: "index" }),
    path("/product/:productId", (ctx) => <ProductDetailPage params={ctx.params} />, { name: "product" }),
    intercept(
      "@modal",
      ".product",
      (ctx) => <ProductModal params={ctx.params} />,
      () => [when(({ from }) => from.pathname === "/shop")]
    ),
    path("/cart", CartPage, { name: "cart" }),
  ]),
]);
