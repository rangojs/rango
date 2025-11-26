//#region Imports
import { map } from "rsc-router/server";
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
import { Outlet, ParallelOutlet } from "rsc-router/client";
// Loaders - server-side data fetchers
import {
  UserLoader,
  CartLoader,
  CategoriesLoader,
  ProductLoader,
  RelatedProductsLoader,
  OrdersLoader,
  FeaturedProductsLoader,
} from "./shop/loaders/index.js";
//#endregion

const DummyLayout = (
  <>
    <Outlet />
  </>
);
//#region Handler Definition
/**
 * Shop handlers - comprehensive ecommerce example
 * Tests all routing features: nested routes, dynamic segments, layout composition, parallel routes
 *
 * **NEW API with use() pattern:**
 * - use() callbacks for configuration
 * - Orphan layouts (no child routes = extend parent)
 * - Multiple middleware/revalidate calls
 * - Parallel slots share config
 * - AsyncLocalStorage for implicit context
 * - Full type inference for inline handlers
 */
export default map<typeof shopRoutes>(
  ({ route, layout, middleware, parallel, revalidate, loader }) => [
    //#region Global Layout & Middleware
    // Global root layout wraps everything
    // #1 $layout.0
    layout(
      <>
        <ParallelOutlet name="@promoBanner" />
        <RootLayout />
      </>,
      () => [
        // Orphan layout $layout.0.$layout.0 and $layout.0.$layout.1
        layout(DummyLayout, () => [revalidate(() => false)]),
        layout(DummyLayout, () => [revalidate(() => false)]),

        revalidate(globalRevalidation),

        // Global loaders - available throughout the shop
        // UserLoader: current user data for header, account, etc.
        loader(UserLoader),
        // CartLoader: cart data for header badge, cart page, checkout
        // Revalidates when cart actions are performed
        loader(CartLoader, () => [
          revalidate(({ actionId }) => actionId?.startsWith("cart:") ?? false),
        ]),
        // CategoriesLoader: product categories for navigation
        loader(CategoriesLoader),
        // FeaturedProductsLoader: demonstrates streaming with Promise
        // Returns { content: Promise<Product[]> } that streams to client
        loader(FeaturedProductsLoader),

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
        middleware(...loggerMiddleware),
        middleware(...mockAuthMiddleware),
        //#endregion

        //#region Shop Routes
        // Shop layout wraps shop routes
        // #2 $layout.0.$layout.2
        layout(<ShopLayout />, () => [
          // Homepage
          route("index", IndexRoute, () => [
            parallel(
              {
                "@sidebar": () => <CategorySidebar />,
              },
              () => [revalidate(() => false)]
            ),
          ]),

          // Category
          route("products.category", ProductsCategoryRoute),

          // Product detail
          // ProductLoader fetches the specific product by slug
          // RelatedProductsLoader depends on ProductLoader to get related items
          route("products.detail.view", ProductsDetailRoute, () => [
            loader(ProductLoader, () => [revalidate(() => false)]),
            loader(RelatedProductsLoader, () => [revalidate(() => false)]),
            revalidate(productDetailRevalidation),

            parallel({
              "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
            }),
          ]),

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
          route("cart", CartRoute, () => [
            revalidate(cartRevalidation),
            parallel({
              "@summary": () => <OrderSummary variant="cart" />,
            }),
          ]),
        ]),
        //#endregion

        //#region Checkout Routes
        // Checkout layout
        layout(<CheckoutLayout />, () => [
          middleware(...requireAuthMiddleware),

          route("checkout.index", CheckoutIndexRoute, () => [
            parallel({
              "@summary": () => <OrderSummary variant="checkout" />,
            }),
          ]),

          route("checkout.payment", CheckoutPaymentRoute, () => [
            parallel({
              "@summary": () => <OrderSummary variant="payment" />,
            }),
          ]),

          route("checkout.confirm", CheckoutConfirmRoute, () => [
            revalidate(checkoutConfirmRevalidation),
          ]),
        ]),
        //#endregion

        //#region Account Routes
        // Account layout
        // OrdersLoader is scoped to account section - fetches user's orders
        layout(<AccountLayout />, () => [
          loader(OrdersLoader),

          route("account.index", AccountIndexRoute, () => [
            parallel({
              "@orders": () => <RecentOrders />,
            }),
          ]),

          route("account.orders", AccountOrdersRoute, () => [
            middleware(...permissionsMiddleware),
          ]),

          route("account.orderDetail", AccountOrderDetailRoute, () => [
            revalidate(orderDetailRevalidation),
          ]),
        ]),
        //#endregion
      ]
    ),
  ]
);
//#endregion
