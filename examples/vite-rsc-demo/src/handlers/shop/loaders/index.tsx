/**
 * Shop Loaders
 *
 * Re-exports all loaders for convenient importing.
 * Each loader can also be imported directly from its own file.
 */

export { UserLoader, type User } from "./user.js";
export { CartLoader, type Cart } from "./cart.js";
export { CategoriesLoader } from "./categories.js";
export { ProductLoader, type Product } from "./product.js";
export { RelatedProductsLoader } from "./related-products.js";
export { OrdersLoader, type Order } from "./orders.js";
export {
  FeaturedProductsLoader,
  type FeaturedProductsData,
} from "./featured-products.js";
