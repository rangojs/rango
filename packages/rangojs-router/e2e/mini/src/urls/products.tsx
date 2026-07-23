// A real route MODULE in its own urls/*.tsx file, included into the router via
// include("/products", productsPatterns). Living in its own module is what lets
// the rango Vite plugin emit a per-module routes map (products.gen.ts) — which
// useReverse imports. An inline include() group (defined directly in router.tsx)
// gets global named routes (ctx.reverse/href/Link) but NO client reverse map, so
// useReverse specifically requires extracting the group into a module like this.
//
// Exercises: route params, a parallel @cart slot (independent loader + loading),
// an intercept() modal gated by when(), transition() content-hold, mount-aware
// link hooks (useMount/useHref via MountInfo), useReverse (ProductsReverse), and
// a server-only loader consumed via ctx.use().

import { urls, createLoader, Meta, Breadcrumbs } from "@rangojs/router";
import { Outlet, ParallelOutlet, Link } from "@rangojs/router/client";

import { CartLoader } from "../shared.js";
import { addToCart } from "../actions.js";
import {
  CartSlot,
  AddToCartButton,
  MountInfo,
  ParamReadout,
  DetailCounter,
  ModalClose,
  ProductsReverse,
} from "../client.js";

// Product catalog (server-only; read only by the handlers below).
interface Product {
  id: string;
  name: string;
  price: number;
}
const PRODUCTS: Product[] = [
  { id: "1", name: "Widget", price: 19 },
  { id: "2", name: "Gadget", price: 29 },
  { id: "3", name: "Gizmo", price: 39 },
];
const listProducts = (): Product[] => PRODUCTS;
const getProduct = (id: string): Product | undefined =>
  PRODUCTS.find((p) => p.id === id);

// Server-only loader consumed via ctx.use() in the index handler. Must be
// exported so the exposeInternalIds transform injects its stable $$id.
export const ProductsLoader = createLoader(async () => {
  return { products: listProducts() };
});

export const productsPatterns = urls(
  ({
    path,
    layout,
    parallel,
    intercept,
    loader,
    loading,
    transition,
    revalidate,
  }) => [
    layout(
      (ctx) => {
        const crumb = ctx.use(Breadcrumbs);
        crumb({ label: "Products", href: "/products" });
        return (
          <div data-testid="products-layout">
            <h2>Products</h2>
            <nav data-testid="products-nav">
              <Link to="/products" data-testid="products-index-link">
                All
              </Link>
              {" | "}
              <Link to="/products/1" data-testid="products-link-1">
                Widget
              </Link>
              {" | "}
              <Link to="/products/2" data-testid="products-link-2">
                Gadget
              </Link>
            </nav>
            <MountInfo />
            <ProductsReverse />
            <aside data-testid="cart-aside">
              <ParallelOutlet name="@cart" />
            </aside>
            <div data-testid="products-outlet">
              <Outlet />
            </div>
            {/* Intercept modal renders into this named slot on soft nav. */}
            <Outlet name="@modal" />
          </div>
        );
      },
      () => [
        // Independent streaming parallel slot: own loader + loading fallback.
        // Revalidates only after an addToCart action.
        parallel({ "@cart": () => <CartSlot /> }, () => [
          loader(CartLoader, () => [
            revalidate(({ isAction }) => isAction(addToCart) || undefined),
          ]),
          loading(<div data-testid="cart-skeleton">Loading cart…</div>),
        ]),

        path(
          "/",
          async (ctx) => {
            // Server-side loader consumption: ctx.use() runs the loader and
            // returns its data, passed straight into the markup.
            const { products } = await ctx.use(ProductsLoader);
            return (
              <div data-testid="products-index">
                <ul>
                  {products.map((p) => (
                    <li key={p.id} data-testid={`product-row-${p.id}`}>
                      <Link
                        to={`/products/${p.id}`}
                        data-testid={`product-open-${p.id}`}
                      >
                        {p.name} — ${p.price}
                      </Link>
                      <AddToCartButton productId={p.id} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          },
          { name: "index" },
        ),

        path(
          "/:id",
          (ctx) => {
            const product = getProduct(ctx.params.id);
            const meta = ctx.use(Meta);
            meta({ title: product ? product.name : "Unknown product" });
            const crumb = ctx.use(Breadcrumbs);
            crumb({
              label: product?.name ?? ctx.params.id,
              href: `/products/${ctx.params.id}`,
            });
            return (
              <div data-testid="product-detail">
                <h3 data-testid="product-detail-name">
                  {product?.name ?? "Unknown"}
                </h3>
                <ParamReadout />
                {/* Survives same-route /products/1 -> /products/2 thanks to
                    transition() content-hold (instance is not remounted). */}
                <DetailCounter />
              </div>
            );
          },
          { name: "detail" },
          () => [
            loading(<div data-testid="detail-skeleton">Loading…</div>),
            transition({}),
          ],
        ),

        // Modal only when soft-navigating from the index (not detail->detail,
        // which stays a full same-route navigation so transition() can hold).
        intercept(
          "@modal",
          ".detail",
          (ctx) => {
            const product = getProduct(ctx.params.id);
            return (
              <div data-testid="product-modal">
                <span data-testid="product-modal-name">
                  {product?.name ?? "Unknown"}
                </span>
                <ModalClose />
              </div>
            );
          },
          { when: ({ from }) => from.pathname === "/products" },
        ),
      ],
    ),
  ],
);
