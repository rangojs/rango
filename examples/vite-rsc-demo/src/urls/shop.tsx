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
  ProductsCategoryRoute,
  ProductsDetailRoute,
  CartRoute,
  CheckoutIndexRoute,
  CheckoutPaymentRoute,
  CheckoutConfirmRoute,
  AccountIndexRoute,
  AccountOrdersRoute,
  AccountOrderDetailRoute,
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
    cache(() => [
      // Orphan layouts for testing
      layout(<><Outlet /></>, () => [revalidate(() => false)]),
      layout(<><Outlet /></>, () => [revalidate(() => false)]),

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
            "@promoBanner": () => (
              <div style={{ background: "#d1e7dd", padding: "0.5rem", textAlign: "center" }}>
                <p>🔥 Summer Sale! Up to 50% off on selected items! 🔥</p>
              </div>
            ),
            "@notification": () => <CartNotification />,
          }),

          // Intercept product detail - shows modal during soft navigation
          // Note: Use local route name (without "shop." prefix) since include() adds it
          intercept(
            "@modal",
            "products.detail.view",
            <ProductModalContent />,
            () => [
              when(({ from }) => {
                const shouldIntercept = !from.pathname.startsWith("/shop/products/") && !from.pathname.startsWith("/shop/product/");
                console.log(`[Intercept when] from: ${from.pathname}, shouldIntercept: ${shouldIntercept}`);
                return shouldIntercept;
              }),
              layout(<ModalWrapper />),
              loading(<ProductModalContentSkeleton />),
              loader(ProductLoader, () => [cache()]),
              loader(ProductCartLoader, () => [revalidate(() => true)]),
              loader(ModalRecommendationsLoader, () => [
                revalidate(({ actionId }) => actionId?.includes("addToCart") ?? false),
              ]),
            ]
          ),

          // Shop index
          path("/", ShopIndexRoute, { name: "index" }, () => [
            parallel({ "@sidebar": () => <CategorySidebar /> }, () => [revalidate(() => false)]),
          ]),

          // Category
          path("/products/:category", (ctx) => {
            const push = ctx.use(Breadcrumbs);
            const title = ctx.params.category
              .split("-")
              .map((w: string) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
            push({ label: title, href: `/shop/products/${ctx.params.category}` });
            return ProductsCategoryRoute(ctx);
          }, { name: "products.category" }),

          // Product detail
          path("/product/:slug", (ctx) => {
            const push = ctx.use(Breadcrumbs);
            const title = ctx.params.slug
              .split("-")
              .map((w: string) => w[0].toUpperCase() + w.slice(1))
              .join(" ");
            push({ label: title, href: `/shop/product/${ctx.params.slug}` });
            return ProductsDetailRoute(ctx);
          }, { name: "products.detail.view" }, () => [
            loading(<ProductDetailSkeleton />, { ssr: true }),
            loader(ProductLoader, () => [revalidate(() => false), cache()]),
            loader(RelatedProductsLoader, () => [revalidate(() => false)]),
            revalidate(productDetailRevalidation),
            parallel({ "@related": (ctx) => <RelatedProducts slug={ctx.params.slug} /> }),
          ]),

          // Reviews routes
          path("/product/:slug/reviews", (ctx) => (
            <div>
              <h2>Reviews for {ctx.params.slug}</h2>
              <p>All reviews for this product</p>
            </div>
          ), { name: "products.detail.reviews.index" }),

          path("/product/:slug/reviews/:reviewId", (ctx) => (
            <div>
              <h2>Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
            </div>
          ), { name: "products.detail.reviews.detail" }),

          path("/product/:slug/reviews/:reviewId/edit", (ctx) => (
            <div>
              <h2>Edit Review {ctx.params.reviewId}</h2>
              <p>For product: {ctx.params.slug}</p>
              <p>4 levels deep!</p>
            </div>
          ), { name: "products.detail.reviews.edit.index" }),

          // Cart
          path("/cart", CartRoute, { name: "cart" }, () => [
            loading(<CartSkeleton />),
            revalidate(cartRevalidation),
            parallel({ "@summary": () => <OrderSummary variant="cart" /> }),
          ]),
        ]
      ),

      // Checkout routes with dedicated cache store
      cache({ store: checkoutCacheStore }, () => [
        layout(<CheckoutLayout />, () => [
          loading(<CheckoutSkeleton />),
          middleware(...requireAuthMiddleware),

          path("/checkout", CheckoutIndexRoute, { name: "checkout.index" }, () => [
            parallel({ "@summary": () => <OrderSummary variant="checkout" /> }),
          ]),

          path("/checkout/payment", CheckoutPaymentRoute, { name: "checkout.payment" }, () => [
            parallel({ "@summary": () => <OrderSummary variant="payment" /> }),
          ]),

          path("/checkout/confirm", CheckoutConfirmRoute, { name: "checkout.confirm" }, () => [
            revalidate(checkoutConfirmRevalidation),
          ]),
        ]),
      ]),

      // Account routes
      layout(<AccountLayout />, () => [
        loader(OrdersLoader),

        path("/account", AccountIndexRoute, { name: "account.index" }, () => [
          parallel({ "@orders": () => <RecentOrders /> }),
        ]),

        path("/account/orders", AccountOrdersRoute, { name: "account.orders" }, () => [
          middleware(...permissionsMiddleware),
        ]),

        path("/account/orders/:id", AccountOrderDetailRoute, { name: "account.orderDetail" }, () => [
          revalidate(orderDetailRevalidation),
        ]),
      ]),
    ]),
  ]
);
