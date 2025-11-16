//#region Imports
import { map } from "rsc-router";
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
import { ParallelOutlet } from "rsc-router/client";
//#endregion

//#region Handler Definition
/**
 * Shop handlers - comprehensive ecommerce example
 * Tests all routing features: nested routes, dynamic segments, layout composition, parallel routes
 *
 * TYPE SAFETY NOTE:
 * - Array-based API with route-scoped helpers
 * - Full type inference for inline handlers - no explicit types needed!
 * - ctx.params automatically typed based on route pattern
 * - parallel() handlers get params from parent route
 */
export default map<typeof shopRoutes>(
  ({ route, layout, middleware, revalidate }) => [
    //#region Global Layout & Middleware
    // Global root layout wraps everything
    layout(
      <>
        <ParallelOutlet name="@promoBanner" />
        <RootLayout />
      </>,
      ({ parallel }) => [
        revalidate(globalRevalidation),
        parallel({
          "@promoBanner": () => (
            <div
              style={{
                background: "#d1e7dd",
                padding: "0.5rem",
                textAlign: "center",
              }}
            >
              <p>🔥 Summer Sale! Up to 50% off on selected items! 🔥</p>
            </div>
          ),
        }),

        // Global middleware
        middleware(...loggerMiddleware, ...mockAuthMiddleware),
        //#endregion

        //#region Shop Routes
        // Shop layout wraps shop routes
        layout(<ShopLayout />, [
          // Homepage
          route("index", IndexRoute, ({ parallel }) => [
            parallel({
              "@sidebar": () => <CategorySidebar />,
            }),
          ]),

          // Category
          route("products.category", ProductsCategoryRoute),

          // Product detail
          route(
            "products.detail.view",
            ProductsDetailRoute,
            ({ parallel, revalidate }) => [
              revalidate(productDetailRevalidation),

              parallel({
                "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
              }),
            ]
          ),

          // Deeply nested reviews
          route("products.detail.reviews.index", (ctx) => (
            <div>
              <h2>Reviews for {ctx.params.slug}</h2>
              <p>All reviews for this product</p>
            </div>
          )),

          route("products.detail.reviews.detail", (ctx) => (
            <div>
              <h2>Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
            </div>
          )),

          route("products.detail.reviews.edit.index", (ctx) => (
            <div>
              <h2>Edit Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
              <p>4 levels deep!</p>
            </div>
          )),

          // Cart
          route("cart", CartRoute, ({ parallel, revalidate }) => [
            revalidate(cartRevalidation),
            parallel({
              "@summary": () => <OrderSummary variant="cart" />,
            }),
          ]),
        ]),
        //#endregion

        //#region Checkout Routes
        // Checkout layout
        layout(<CheckoutLayout />, [
          middleware(...requireAuthMiddleware),

          route("checkout.index", CheckoutIndexRoute, ({ parallel }) => [
            parallel({
              "@summary": () => <OrderSummary variant="checkout" />,
            }),
          ]),

          route("checkout.payment", CheckoutPaymentRoute, ({ parallel }) => [
            parallel({
              "@summary": () => <OrderSummary variant="payment" />,
            }),
          ]),

          route("checkout.confirm", CheckoutConfirmRoute, ({ revalidate }) => [
            revalidate(checkoutConfirmRevalidation),
          ]),
        ]),
        //#endregion

        //#region Account Routes
        // Account layout
        layout(<AccountLayout />, [
          route("account.index", AccountIndexRoute, ({ parallel }) => [
            parallel({
              "@orders": () => <RecentOrders />,
            }),
          ]),

          route("account.orders", AccountOrdersRoute, ({ middleware }) => [
            middleware(...permissionsMiddleware),
          ]),

          route(
            "account.orderDetail",
            AccountOrderDetailRoute,
            ({ revalidate }) => [revalidate(orderDetailRevalidation)]
          ),
        ]),
        //#endregion
      ]
    ),
  ]
);
//#endregion
