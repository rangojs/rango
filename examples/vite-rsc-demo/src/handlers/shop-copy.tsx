//@ts-nocheck
//#region Imports
import { map } from "@ivogt/rsc-router/server";
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
import { Outlet, ParallelOutlet } from "@ivogt/rsc-router/client";
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
  ({ route, layout, middleware, parallel, revalidate }) => [
    revalidate(globalRevalidation),

    // Global middleware
    middleware(...loggerMiddleware),
    middleware(...mockAuthMiddleware),
    //#endregion
    // Global root layout wraps everything
    // #1 $layoute.0
    layout(
      <>
        <ParallelOutlet name="@promoBanner" />
        <RootLayout />
      </>,
      () => [revalidate(() => false)]
    ),

    // Orphan layout $layout.0.$layout.0 and $layout.0.$layout.1

    layout(<ShopLayout />, () => []),

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

    // Homepage
    route("index", IndexRoute, () => [
      parallel(
        {
          "@sidebar": () => <CategorySidebar />,
        },
        () => [revalidate(() => false)]
      ),
    ]),

    ProductRoutes(),

    // Cart
    route("cart", CartRoute, () => [
      revalidate(cartRevalidation),
      parallel({
        "@summary": () => <OrderSummary variant="cart" />,
      }),
    ]),

    //#region Shop Routes
    // Shop layout wraps shop routes
    // #2 $layout.0.$layout.2
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
    layout(
      (ctx) => {
        const addresses = ctx.use(addresses);
        return <AccountLayout />;
      },
      () => [
        loader(cartLoader),
        // context(),
        route("account.index", AccountIndexRoute, () => [
          parallel({
            "@orders": async (ctx) => {
              const user = await ctx.use(currentUser);
              const order = await ctx.use(order);
              const addresses = await ctx.use(addresses);
              return <RecentOrders user={ctx.use(currentUser)} />;
            },
          }),
        ]),

        route("account.orders", AccountOrdersRoute, () => [
          middleware(...permissionsMiddleware),
        ]),

        route("account.orderDetail", AccountOrderDetailRoute, () => [
          //#endregion

          revalidate(orderDetailRevalidation),
        ]),
      ]
    ),
  ]
);

const ProductRoutes = map<typeof shopRoutes>(() => [
  layout(DummyLayout, () => [revalidate(() => false)]),
  layout(DummyLayout, () => [revalidate(() => false)]),
  // Category
  route("products.category", ProductsCategoryRoute),

  // Product detail
  route("products.detail.view", ProductsDetailRoute, () => [
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
]);
//#endregion
const createContext = (...args: any[]) => {
  return undefined;
};
const context = (...args: any[]) => {
  return undefined as any;
};
const loader = (...args: any[]) => {
  return undefined as any;
};
const useLoader = (...args: any[]) => {
  return undefined;
};
const createLoader = (...args: any[]) => {
  return undefined;
};
const currentUser = createContext(() => {
  /* load */
});
const addresses = createContext(() => {
  /* load */
});
const orders = createContext(() => {
  /* load */
});
const order = createContext(() => {
  /* load */
});

const cartLoader = createLoader(
  (ctx) => {
    return ctx.use(cart);
  },
  () => [tag(["cart"])]
);

const Cart = () => {
  const { data: cart } = useLoader(cartLoader);
  return <div>Cart</div>;
};
