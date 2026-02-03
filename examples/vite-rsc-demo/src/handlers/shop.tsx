//#region Imports
import { map } from "@rangojs/router/server";
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";
import type { shopRoutes } from "../routes.js";
import { ShopLayout } from "../layouts/ShopLayout.js";
import { CheckoutLayout } from "../layouts/CheckoutLayout.js";
import { AccountLayout } from "../layouts/AccountLayout.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

// Checkout-specific cache with shorter TTL (checkout data changes frequently)
const checkoutCacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 10 }, // 10 second TTL for checkout
});

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
import { Outlet, ParallelOutlet } from "@rangojs/router/client";
// Loaders - server-side data fetchers
import {
  UserLoader,
  CartLoader,
  CategoriesLoader,
  ProductLoader,
  RelatedProductsLoader,
  OrdersLoader,
  FeaturedProductsLoader,
  ModalRecommendationsLoader,
  ProductCartLoader,
} from "./shop/loaders/index.js";
// Loading skeletons for instant feedback during navigation
import {
  ProductDetailSkeleton,
  CartSkeleton,
  CheckoutSkeleton,
  ShopLayoutSkeleton,
} from "./shop/components/loading.js";
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
// Modal components for intercepted product route
import {
  ModalWrapper,
  ProductModalContent,
  ProductModalContentSkeleton,
} from "./shop/components/ProductModal.js";
import { CartNotification } from "./shop/components/CartNotification.js";

export default map<typeof shopRoutes>(
  ({
    route,
    layout,
    middleware,
    parallel,
    revalidate,
    loader,
    loading,
    intercept,
    when,
    cache,
  }) => [
    // Cache boundary wraps all shop routes - uses app-level defaults (ttl: 60)
    cache(() => [
      //#region Global Layout & Middleware
      // Orphan layouts for testing
      layout(DummyLayout, () => [revalidate(() => false)]),
      layout(DummyLayout, () => [revalidate(() => false)]),

      revalidate(globalRevalidation),

      // Global middleware
      middleware(...loggerMiddleware),
      middleware(...mockAuthMiddleware),

      // Global loaders - available throughout the shop (attached to cache boundary)
      // UserLoader: current user data for header, account, etc.
      loader(UserLoader),
      // CartLoader: cart data for header badge, cart page, checkout
      // Revalidates when cart actions are performed
      loader(CartLoader, () => [
        // Match actions from shop.actions.ts that contain "Cart" in export name
        // Full actionId format: "src/handlers/shop/actions/shop.actions.ts#addToCart"
        revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
      ]),
      // CategoriesLoader: product categories for navigation
      loader(CategoriesLoader),
      // FeaturedProductsLoader: demonstrates streaming with Promise
      // Returns { content: Promise<Product[]> } that streams to client
      loader(FeaturedProductsLoader),
      //#endregion

      //#region Shop Routes
      // Shop layout wraps shop routes
      layout(
        (ctx) => {
          // Push "Shop" breadcrumb for all shop routes
          const push = ctx.use(Breadcrumbs);
          push({ label: "Shop", href: "/shop" });
          return (
            <>
              <ParallelOutlet name="@promoBanner" />
              <ShopLayout />
            </>
          );
        },
        () => [
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
            // Cart notification - client component that tracks cart action state
            "@notification": () => <CartNotification />,
          }),

          // Intercept product detail - shows modal during soft navigation
          // Hard navigation (direct URL) shows the full ProductsDetailRoute
          // Only intercept when coming from /shop index, NOT from category pages
          // layout() wraps both content and loading skeleton with ModalWrapper
          intercept(
            "@modal",
            "shop.products.detail.view",
            <ProductModalContent />,
            () => [
              // Only show modal when navigating from shop index, not from category pages
              when(({ from }) => !from.pathname.startsWith("/shop/products/")),
              layout(<ModalWrapper />),
              loading(<ProductModalContentSkeleton />),
              loader(ProductLoader, () => [cache()]),
              // Cart quantity loader - always revalidate to show current cart state
              // Cart state can change any time (via actions in other tabs, etc.)
              loader(ProductCartLoader, () => [
                revalidate(() => true),
              ]),
              // Recommendations loader - revalidates on cart actions to demonstrate streaming
              loader(ModalRecommendationsLoader, () => [
                revalidate(
                  ({ actionId }) => actionId?.includes("addToCart") ?? false
                ),
              ]),
            ]
          ),

          // Homepage
          route("shop.index", IndexRoute, () => [
            parallel(
              {
                "@sidebar": () => <CategorySidebar />,
              },
              () => [revalidate(() => false)]
            ),
          ]),

          // Category
          route("shop.products.category", (ctx) => {
            // Push category breadcrumb
            const push = ctx.use(Breadcrumbs);
            const title = ctx.params.category
              .split("-")
              .map((w: string) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
            push({
              label: title,
              href: `/shop/products/${ctx.params.category}`,
            });
            return ProductsCategoryRoute(ctx);
          }),

          // Product detail
          // ProductLoader fetches the specific product by slug
          // RelatedProductsLoader depends on ProductLoader to get related items
          route(
            "shop.products.detail.view",
            (ctx) => {
              // Push product breadcrumb
              const push = ctx.use(Breadcrumbs);
              const title = ctx.params.slug
                .split("-")
                .map((w: string) => w[0].toUpperCase() + w.slice(1))
                .join(" ");
              push({ label: title, href: `/shop/product/${ctx.params.slug}` });
              return ProductsDetailRoute(ctx);
            },
            () => [
              loading(<ProductDetailSkeleton />, true),
              loader(ProductLoader, () => [revalidate(() => false), cache()]),
              loader(RelatedProductsLoader, () => [revalidate(() => false)]),
              revalidate(productDetailRevalidation),

              parallel({
                "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
              }),
            ]
          ),

          // Deeply nested reviews
          route("shop.products.detail.reviews.index", (ctx) => (
            <div>
              <h2>Reviews for {ctx.params.slug}</h2>
              <p>All reviews for this product</p>
            </div>
          )),

          route("shop.products.detail.reviews.detail", (ctx) => (
            <div>
              <h2>Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
            </div>
          )),

          route("shop.products.detail.reviews.edit.index", (ctx) => (
            <div>
              <h2>Edit Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
              <p>4 levels deep!</p>
            </div>
          )),

          // Cart
          route("shop.cart", CartRoute, () => [
            loading(<CartSkeleton />),
            revalidate(cartRevalidation),
            parallel({
              "@summary": () => <OrderSummary variant="cart" />,
            }),
          ]),
        ]
      ),
      //#endregion

      //#region Checkout Routes
      // Checkout uses dedicated cache store with shorter TTL (10s vs 60s default)
      // Demonstrates per-section cache configuration
      cache({ store: checkoutCacheStore }, () => [
        // Checkout layout
        layout(<CheckoutLayout />, () => [
          loading(<CheckoutSkeleton />),
          middleware(...requireAuthMiddleware),

          route("shop.checkout.index", CheckoutIndexRoute, () => [
            parallel({
              "@summary": () => <OrderSummary variant="checkout" />,
            }),
          ]),

          route("shop.checkout.payment", CheckoutPaymentRoute, () => [
            parallel({
              "@summary": () => <OrderSummary variant="payment" />,
            }),
          ]),

          route("shop.checkout.confirm", CheckoutConfirmRoute, () => [
            revalidate(checkoutConfirmRevalidation),
          ]),
        ]),
      ]),
      //#endregion

      //#region Account Routes
      // Account layout
      // OrdersLoader is scoped to account section - fetches user's orders
      layout(<AccountLayout />, () => [
        loader(OrdersLoader),

        route("shop.account.index", AccountIndexRoute, () => [
          parallel({
            "@orders": () => <RecentOrders />,
          }),
        ]),

        route("shop.account.orders", AccountOrdersRoute, () => [
          middleware(...permissionsMiddleware),
        ]),

        route("shop.account.orderDetail", AccountOrderDetailRoute, () => [
          revalidate(orderDetailRevalidation),
        ]),
      ]),
      //#endregion
    ]), // End cache boundary
  ]
);
//#endregion
