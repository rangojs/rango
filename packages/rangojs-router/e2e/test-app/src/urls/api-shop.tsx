import { urls } from "@rangojs/router";
import {
  CatalogHandler,
  ProductHandler,
  CartHandler,
  CartItemHandler,
  HealthHandler,
} from "./api-shop.handlers.js";

/**
 * Shop API URL patterns
 * Routes: catalog, product, cart, cartItem, health
 */
export const apiShopPatterns = urls(({ path }) => [
  path.json("/catalog", CatalogHandler, { name: "catalog" }),
  path.json("/catalog/:productId", ProductHandler, { name: "product" }),
  path.json("/cart", CartHandler, { name: "cart" }),
  path.json("/cart/:itemId", CartItemHandler, { name: "cartItem" }),
  path.json("/health", HealthHandler, { name: "health" }),
]);
