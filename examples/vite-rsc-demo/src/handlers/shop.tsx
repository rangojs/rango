import { map, layout, parallel, revalidateRoute, revalidateLayout, revalidateParallel, middleware } from "rsc-router";
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
  [revalidateRoute("*", "global")]: globalRevalidation,

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
  "products.detail.index": ProductsDetailRoute,
  [revalidateRoute("products.detail.index", "demo")]: productDetailRevalidation,
  [parallel("products.detail.index", "related")]: {
    "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
  },

  // ===================
  // PRODUCTS - DETAIL - REVIEWS (Deeply nested - test param inference)
  // ===================
  "products.detail.reviews.index": (ctx) => {
    // TypeScript should infer: ctx.params: { slug: string }
    return (
      <div>
        <h2>Reviews for {ctx.params.slug}</h2>
        <p>All reviews for this product</p>
      </div>
    );
  },

  "products.detail.reviews.detail": (ctx) => {
    // TypeScript should infer: ctx.params: { slug: string; reviewId: string }
    return (
      <div>
        <h2>Review {ctx.params.reviewId}</h2>
        <p>For product: {ctx.params.slug}</p>
      </div>
    );
  },

  "products.detail.reviews.edit.index": (ctx) => {
    // TypeScript should infer: ctx.params: { slug: string; reviewId: string }
    return (
      <div>
        <h2>Edit Review {ctx.params.reviewId}</h2>
        <p>For product: {ctx.params.slug}</p>
        <p>This is 4 levels deep! (products.detail.reviews.edit.index)</p>
      </div>
    );
  },

  // ===================
  // CART
  // ===================
  cart: CartRoute,
  [revalidateRoute("cart")]: cartRevalidation,
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
  [revalidateRoute("checkout.confirm")]: checkoutConfirmRevalidation,

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
  [revalidateRoute("account.orderDetail")]: orderDetailRevalidation,
});
