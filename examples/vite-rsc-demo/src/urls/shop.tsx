import { urls } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";
import { Outlet, ParallelOutlet } from "@rangojs/router/client";

// Layouts
import { ShopLayout } from "../layouts/ShopLayout.js";
import { CheckoutLayout } from "../layouts/CheckoutLayout.js";
import { AccountLayout } from "../layouts/AccountLayout.js";
import { Breadcrumbs } from "../handles/breadcrumbs.js";

// Route components
import {
  IndexRoute as ShopIndexRoute,
  CartRoute,
  CheckoutIndexRoute,
  CheckoutPaymentRoute,
  CheckoutConfirmRoute,
  AccountIndexRoute,
  AccountOrdersRoute,
  AccountOrderDetailRoute,
  ReviewsIndexRoute,
  ReviewDetailRoute,
  ReviewEditRoute,
  CategoryRouteWithBreadcrumbs,
  ProductDetailRouteWithBreadcrumbs,
} from "../handlers/shop/routes/index.js";

// Components
import {
  CategorySidebar,
  RelatedProducts,
  OrderSummary,
  RecentOrders,
} from "../handlers/shop/components.js";
import {
  ProductDetailSkeleton,
  CartSkeleton,
  CheckoutSkeleton,
} from "../handlers/shop/components/loading.js";
import {
  ModalWrapper,
  ProductModalContent,
  ProductModalContentSkeleton,
} from "../handlers/shop/components/ProductModal.js";
import { CartNotification } from "../handlers/shop/components/CartNotification.js";
import { PromoBanner } from "../handlers/shop/components/PromoBanner.js";

// Conditions
import { shouldInterceptProductModal } from "../handlers/shop/conditions/index.js";

// Middleware
import {
  loggerMiddleware as shopLoggerMiddleware,
  mockAuthMiddleware,
  requireAuthMiddleware,
  permissionsMiddleware,
} from "../handlers/shop/middleware/index.js";

// Revalidation
import {
  globalRevalidation as shopGlobalRevalidation,
  cartRevalidation,
  checkoutConfirmRevalidation,
  orderDetailRevalidation,
  productDetailRevalidation,
} from "../handlers/shop/revalidation/index.js";

// Loaders
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
} from "../handlers/shop/loaders/index.js";

// Checkout-specific cache with shorter TTL
const checkoutCacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 10 },
});

export const shopPatterns = urls(
  ({
    path,
    layout,
    parallel,
    loader,
    loading,
    cache,
    middleware,
    revalidate,
    intercept,
    when,
  }) => [
    cache(),

    // Orphan layouts for testing
      layout(
        <>
          <Outlet />
        </>,
        () => [revalidate(() => false)],
      ),
      layout(
        <>
          <Outlet />
        </>,
        () => [revalidate(() => false)],
      ),

      revalidate(shopGlobalRevalidation),

      // Global middleware
      middleware(...shopLoggerMiddleware),
      middleware(...mockAuthMiddleware),

      // Global loaders
      loader(UserLoader),
      loader(CartLoader, () => [
        revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
      ]),
      loader(CategoriesLoader),
      loader(FeaturedProductsLoader),

      // Shop layout
      layout(
        (ctx) => {
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
            "@promoBanner": () => <PromoBanner />,
            "@notification": () => <CartNotification />,
          }),

          // Intercept product detail - shows modal during soft navigation
          // Note: Use local route name (without "shop." prefix) since include() adds it
          intercept(
            "@modal",
            ".products.detail.view",
            <ProductModalContent />,
            () => [
              when(shouldInterceptProductModal),
              layout(<ModalWrapper />),
              loading(<ProductModalContentSkeleton />),
              loader(ProductLoader, () => [cache()]),
              loader(ProductCartLoader, () => [revalidate(() => true)]),
              loader(ModalRecommendationsLoader, () => [
                revalidate(
                  ({ actionId }) => actionId?.includes("addToCart") ?? false,
                ),
              ]),
            ],
          ),

          // Shop index
          path("/", ShopIndexRoute, { name: "index" }, () => [
            parallel({ "@sidebar": () => <CategorySidebar /> }, () => [
              revalidate(() => false),
            ]),
          ]),

          // Category
          path(
            "/products/:category",
            CategoryRouteWithBreadcrumbs,
            { name: "products.category" },
          ),

          // Product detail
          path(
            "/product/:slug",
            ProductDetailRouteWithBreadcrumbs,
            { name: "products.detail.view" },
            () => [
              loading(<ProductDetailSkeleton />, { ssr: true }),
              loader(ProductLoader, () => [revalidate(() => false), cache()]),
              loader(RelatedProductsLoader, () => [revalidate(() => false)]),
              revalidate(productDetailRevalidation),
              parallel({
                "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} />,
              }),
            ],
          ),

          // Reviews routes
          path(
            "/product/:slug/reviews",
            ReviewsIndexRoute,
            { name: "products.detail.reviews.index" },
          ),

          path(
            "/product/:slug/reviews/:reviewId",
            ReviewDetailRoute,
            { name: "products.detail.reviews.detail" },
          ),

          path(
            "/product/:slug/reviews/:reviewId/edit",
            ReviewEditRoute,
            { name: "products.detail.reviews.edit.index" },
          ),

          // Cart
          path("/cart", CartRoute, { name: "cart" }, () => [
            loading(<CartSkeleton />),
            revalidate(cartRevalidation),
            parallel({ "@summary": () => <OrderSummary variant="cart" /> }),
          ]),
        ],
      ),

      // Checkout routes with dedicated cache store
      cache({ store: checkoutCacheStore }, () => [
        layout(<CheckoutLayout />, () => [
          loading(<CheckoutSkeleton />),
          middleware(...requireAuthMiddleware),

          path(
            "/checkout",
            CheckoutIndexRoute,
            { name: "checkout.index" },
            () => [
              parallel({
                "@summary": () => <OrderSummary variant="checkout" />,
              }),
            ],
          ),

          path(
            "/checkout/payment",
            CheckoutPaymentRoute,
            { name: "checkout.payment" },
            () => [
              parallel({
                "@summary": () => <OrderSummary variant="payment" />,
              }),
            ],
          ),

          path(
            "/checkout/confirm",
            CheckoutConfirmRoute,
            { name: "checkout.confirm" },
            () => [revalidate(checkoutConfirmRevalidation)],
          ),
        ]),
      ]),

      // Account routes
      layout(<AccountLayout />, () => [
        loader(OrdersLoader),

        path("/account", AccountIndexRoute, { name: "account.index" }, () => [
          parallel({ "@orders": () => <RecentOrders /> }),
        ]),

        path(
          "/account/orders",
          AccountOrdersRoute,
          { name: "account.orders" },
          () => [middleware(...permissionsMiddleware)],
        ),

        path(
          "/account/orders/:id",
          AccountOrderDetailRoute,
          { name: "account.orderDetail" },
          () => [revalidate(orderDetailRevalidation)],
        ),
      ]),
  ],
);
