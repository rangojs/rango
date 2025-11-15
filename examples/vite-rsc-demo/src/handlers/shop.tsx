import { map, layout, parallel, revalidate, middleware } from "rsc-router";
import type { shopRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { ShopLayout } from "../layouts/ShopLayout.js";
import { CheckoutLayout } from "../layouts/CheckoutLayout.js";
import { AccountLayout } from "../layouts/AccountLayout.js";

// Import handlers and configuration from modular folders
import {
  IndexRoute,
  ProductsCategoryRoute,
  ProductsDetailRoute,
  CartRoute,
  CheckoutIndexRoute,
  CheckoutPaymentRoute,
  CheckoutConfirmRoute,
  AccountIndexRoute,
  AccountOrdersRoute,
  AccountOrderDetailRoute,
} from "./shop/routes/index.js";
import {
  CategorySidebar,
  RelatedProducts,
  OrderSummary,
  RecentOrders,
} from "./shop/components.js";
import {
  loggerMiddleware,
  mockAuthMiddleware,
  requireAuthMiddleware,
  permissionsMiddleware,
} from "./shop/middleware/index.js";
import {
  globalRevalidation,
  cartRevalidation,
  checkoutConfirmRevalidation,
  orderDetailRevalidation,
  productDetailRevalidation,
} from "./shop/revalidation/index.js";

/**
 * Shop handlers - comprehensive ecommerce example
 * Tests all routing features: nested routes, dynamic segments, layout composition, parallel routes
 *
 * TYPE SAFETY NOTE:
 * - Uses GLOBAL module augmentation for AppEnv (see router.tsx)
 * - No need to import AppEnv or pass second generic
 * - ctx.get('user'), ctx.set('user'), ctx.var.user all type-safe via global!
 * - Alternative: Explicit import (see blog.tsx)
 * - Revalidation handlers are now type-safe for nested routes!
 */
export default map<typeof shopRoutes>({
  // ← TEnv defaults to RSCRouter.Env (global)
  // ===================
  // GLOBAL - applies to all routes
  // ===================
  [layout("*", "root")]: <RootLayout />,
  [layout("*", "shop")]: <ShopLayout />,
  [middleware("*", "logger")]: loggerMiddleware,
  [middleware("*", "mockAuth")]: mockAuthMiddleware,
  [revalidate("*", "global")]: globalRevalidation,

  // ===================
  // SHOP HOMEPAGE
  // ===================
  index: IndexRoute,
  [parallel("index", "sidebar")]: {
    "@sidebar": () => <CategorySidebar />,
  },

  // ===================
  // PRODUCTS - CATEGORY
  // ===================
  "products.category": ProductsCategoryRoute,

  // ===================
  // PRODUCTS - DETAIL
  // ===================
  "products.detail": ProductsDetailRoute,
  [revalidate("products.detail", "demo")]: productDetailRevalidation,
  [parallel("products.detail", "related")]: {
    "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
  },

  // ===================
  // CART
  // ===================
  cart: CartRoute,
  [revalidate("cart")]: cartRevalidation,
  [parallel("cart", "summary")]: {
    "@summary": () => <OrderSummary variant="cart" />,
  },

  // ===================
  // CHECKOUT - INDEX
  // ===================
  "checkout.index": CheckoutIndexRoute,
  [layout("checkout.index", "checkout")]: <CheckoutLayout />,
  [middleware("checkout.index", "requireAuth")]: requireAuthMiddleware,
  [parallel("checkout.index", "summary")]: {
    "@summary": () => <OrderSummary variant="checkout" />,
  },

  // ===================
  // CHECKOUT - PAYMENT
  // ===================
  "checkout.payment": CheckoutPaymentRoute,
  [layout("checkout.payment", "checkout")]: <CheckoutLayout />,
  [middleware("checkout.payment", "requireAuth")]: requireAuthMiddleware,
  [parallel("checkout.payment", "summary")]: {
    "@summary": () => <OrderSummary variant="payment" />,
  },

  // ===================
  // CHECKOUT - CONFIRM
  // ===================
  "checkout.confirm": CheckoutConfirmRoute,
  [layout("checkout.confirm", "checkout")]: <CheckoutLayout />,
  [revalidate("checkout.confirm")]: checkoutConfirmRevalidation,

  // ===================
  // ACCOUNT - INDEX
  // ===================
  "account.index": AccountIndexRoute,
  [layout("account.index", "account")]: <AccountLayout />,
  [parallel("account.index", "orders")]: {
    "@orders": () => <RecentOrders />,
  },

  // ===================
  // ACCOUNT - ORDERS
  // ===================
  "account.orders": AccountOrdersRoute,
  [layout("account.orders", "account")]: <AccountLayout />,
  [middleware("account.orders", "permissions")]: permissionsMiddleware,

  // ===================
  // ACCOUNT - ORDER DETAIL
  // ===================
  "account.orderDetail": AccountOrderDetailRoute,
  [layout("account.orderDetail", "account")]: <AccountLayout />,
  [revalidate("account.orderDetail")]: orderDetailRevalidation,
});
