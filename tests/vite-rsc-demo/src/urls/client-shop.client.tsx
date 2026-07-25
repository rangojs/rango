"use client";

import { Suspense } from "react";
import {
  clientUrls,
  Link,
  useLoader,
  useOutlet,
  useParams,
  useSearchParams,
} from "@rangojs/router/client";
import {
  ClientShopProductsLoader,
  ClientShopProductLoader,
} from "@/handlers/shop/loaders/client-shop-products.js";
import { RelatedProductsLoader } from "@/handlers/shop/loaders/related-products.js";
import { CartLoader } from "@/handlers/shop/loaders/cart.js";
import {
  addToCart,
  addToCartWithResult,
} from "@/handlers/shop/actions/shop.actions.js";
import { AddToCartForm } from "@/components/AddToCartForm.js";
import {
  StreamingActionForm,
  StreamingActionStatus,
} from "@/components/StreamingActionForm.js";

/**
 * The clientUrls() shop — the /shop product experience rebuilt in the shape
 * this branch converges on. The original shop consumes its loaders in the
 * HANDLER (`await ctx.use(ProductLoader)`), which is pipeline-blocking by
 * contract: no pending UI can ever cover that latency. clientUrls routes have
 * no handlers at all, so the migration is forced into the good shape by
 * construction: every read is useLoader AT the consumption site, waiting is
 * scoped by the inline Suspense above each read, and the per-loader
 * revalidate(() => false) predicates (client-run — only the decision crosses
 * the wire) make tab/search navigations instant instead of refetching the 2s
 * product loader.
 */

function CartBadge() {
  const { data: cart } = useLoader(CartLoader);
  return (
    <span data-testid="client-shop-cart-count">🛒 ({cart.itemCount})</span>
  );
}

function ClientShopLayout() {
  const { content, pending } = useOutlet();

  return (
    <section data-testid="client-shop" aria-busy={pending}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          padding: "1rem 1.5rem",
          background: "linear-gradient(135deg, #0f766e 0%, #115e59 100%)",
          color: "white",
          borderRadius: 8,
          marginBottom: "1.5rem",
          opacity: pending ? 0.7 : 1,
        }}
      >
        <h1 style={{ margin: 0, color: "white", fontSize: "1.25rem" }}>
          🛍️ Client Shop
        </h1>
        <Link to="/client-shop" style={{ color: "white" }}>
          Products
        </Link>
        <small style={{ marginLeft: "auto", opacity: 0.8 }}>
          clientUrls() · useLoader at read sites · no handlers
        </small>
        <Suspense fallback={<span>🛒 (…)</span>}>
          <CartBadge />
        </Suspense>
      </header>
      {content}
    </section>
  );
}

function GridSkeleton() {
  return (
    <div data-testid="client-shop-grid-skeleton" style={{ color: "#888" }}>
      Loading products…
    </div>
  );
}

function ClientShopGrid() {
  const { data: items } = useLoader(ClientShopProductsLoader);

  return (
    <div
      data-testid="client-shop-grid"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "1rem",
      }}
    >
      {items.map((p) => (
        <Link
          key={p.slug}
          to={`/client-shop/product/${p.slug}`}
          // Viewport prefetch: every visible card's partial payload (2s
          // product loader included) starts warming on scroll-in; a click on
          // a warmed card takes the fully-prefetched whole-commit path and
          // lands the complete product instantly.
          prefetch="viewport"
          data-testid={`client-shop-card-${p.slug}`}
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: "1rem",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <strong>{p.name}</strong>
          <div style={{ color: "#666" }}>{p.category}</div>
          <div style={{ color: "#0f766e", fontWeight: 600 }}>${p.price}</div>
        </Link>
      ))}
    </div>
  );
}

function ClientShopIndex() {
  return (
    <div data-testid="client-shop-index">
      <h2>All products</h2>
      {/* Inline boundary: the heading paints instantly, the grid fills when
          its loader streams in. */}
      <Suspense fallback={<GridSkeleton />}>
        <ClientShopGrid />
      </Suspense>
      <p style={{ marginTop: "1.5rem", color: "#888" }}>
        {/* Loader authority signals: the product loader throws notFound() for
            unknown slugs (404 UI swaps in, real 404 status on document loads)
            and redirect() for moved slugs. prefetch="none" keeps the nav-lane
            streaming path deterministic for these. */}
        <Link
          to="/client-shop/product/discontinued-widget"
          prefetch="none"
          data-testid="client-shop-missing-link"
        >
          Discontinued product
        </Link>
        {" · "}
        <Link
          to="/client-shop/product/headphones"
          prefetch="none"
          data-testid="client-shop-legacy-link"
        >
          Legacy headphones link
        </Link>
      </p>
    </div>
  );
}

function TabLink({
  slug,
  tab,
  active,
  children,
}: {
  slug: string;
  tab: string;
  active: boolean;
  children: string;
}) {
  return (
    <Link
      to={`/client-shop/product/${slug}?tab=${tab}`}
      // Tabs hold their data (revalidate predicates skip search-only navs) —
      // there is nothing worth prefetching for a tab switch.
      prefetch="none"
      data-testid={`client-shop-tab-${tab}`}
      style={{
        padding: "0.4rem 0.9rem",
        borderRadius: 6,
        textDecoration: "none",
        background: active ? "#0f766e" : "#e5e7eb",
        color: active ? "white" : "#111",
      }}
    >
      {children}
    </Link>
  );
}

function ProductInfoSkeleton() {
  return (
    <div data-testid="client-shop-info-skeleton" style={{ color: "#888" }}>
      Loading product…
    </div>
  );
}

function ClientShopProductInfo() {
  const { data: product } = useLoader(ClientShopProductLoader);
  const tab = useSearchParams().get("tab") ?? "details";

  return (
    <article data-testid="client-shop-info">
      <h2 data-testid="client-shop-name" style={{ marginBottom: 0 }}>
        {product.name}
      </h2>
      <p data-testid="client-shop-price" style={{ color: "#0f766e" }}>
        ${product.price}
      </p>
      {tab === "reviews" ? (
        <div data-testid="client-shop-tab-panel-reviews">
          <h3>Reviews</h3>
          <p>“Instant tab switch — the loaders never re-ran.”</p>
          <p>
            The per-loader <code>revalidate()</code> predicates run in the
            browser; only their decision crossed the wire with this navigation.
          </p>
        </div>
      ) : (
        <div data-testid="client-shop-tab-panel-details">
          <h3>Details</h3>
          <p data-testid="client-shop-description">{product.description}</p>
          <p style={{ color: "#666" }}>Category: {product.category}</p>
        </div>
      )}
      <div
        style={{
          display: "grid",
          gap: "1rem",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          marginTop: "1rem",
        }}
      >
        {/* One action → three freshness outcomes: the cart badge refreshes
            (its predicate revalidates on actions), while product + related
            HOLD (their predicates skip actions) — per-loader decisions on
            the action POST itself. */}
        <div
          style={{ padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}
        >
          <h4 style={{ marginTop: 0 }}>Fire &amp; forget</h4>
          <AddToCartForm
            productId={product.slug}
            action={addToCart}
            buttonText="Add to Cart"
          />
        </div>
        <div
          style={{ padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}
        >
          <h4 style={{ marginTop: 0 }}>With result</h4>
          <AddToCartForm
            productId={product.slug}
            action={addToCartWithResult}
            buttonText="Add to Cart (result)"
            showResult
          />
        </div>
        <div
          style={{ padding: "1rem", border: "1px solid #ddd", borderRadius: 8 }}
        >
          <h4 style={{ marginTop: 0 }}>Streaming</h4>
          <StreamingActionStatus />
          <StreamingActionForm productId={product.slug}>
            Add product (streaming)
          </StreamingActionForm>
        </div>
      </div>
    </article>
  );
}

function RelatedSkeleton() {
  return (
    <div data-testid="client-shop-related-skeleton" style={{ color: "#888" }}>
      Loading related…
    </div>
  );
}

function ClientShopRelated() {
  const { data: related } = useLoader(RelatedProductsLoader);

  return (
    <aside
      data-testid="client-shop-related"
      style={{
        marginTop: "1.5rem",
        padding: "1rem",
        background: "#f0fdfa",
        borderRadius: 8,
      }}
    >
      <h3 style={{ marginTop: 0 }}>Related products</h3>
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {related.map((p) => (
          <li key={p.slug}>
            <Link to={`/client-shop/product/${p.slug}`} prefetch="hover">
              {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function ClientShopProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const tab = useSearchParams().get("tab") ?? "details";

  return (
    <div data-testid="client-shop-product">
      {/* Tabs render from the URL alone — instant, no data needed. */}
      <nav style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <TabLink slug={slug} tab="details" active={tab === "details"}>
          Details
        </TabLink>
        <TabLink slug={slug} tab="reviews" active={tab === "reviews"}>
          Reviews
        </TabLink>
      </nav>
      {/* Each read waits under its own boundary: the 2s product loader fills
          this section without gating the related list, and vice versa. */}
      <Suspense fallback={<ProductInfoSkeleton />}>
        <ClientShopProductInfo />
      </Suspense>
      <Suspense fallback={<RelatedSkeleton />}>
        <ClientShopRelated />
      </Suspense>
      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/client-shop" data-testid="client-shop-back">
          ← Back to products
        </Link>
      </p>
    </div>
  );
}

/**
 * Product data changes on slug changes, never on tab switches or cart
 * actions. A blunt `() => false` kept serving the OLD product's data on
 * product→product navs (same route, new param); the predicate must be
 * param-sensitive, exactly like the server shop's revalidation.
 */
function productData({
  isAction,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}: {
  isAction: boolean;
  currentParams: Record<string, string>;
  nextParams: Record<string, string>;
  defaultShouldRevalidate: boolean;
}) {
  if (isAction) return false;
  return currentParams.slug !== nextParams.slug
    ? defaultShouldRevalidate
    : false;
}

export default clientUrls(({ path, layout, loader, revalidate }) => [
  layout(ClientShopLayout, () => [
    // Cart state changes ONLY through actions: revalidate on the action
    // POST, skip on every navigation. One add-to-cart then produces three
    // freshness outcomes in a single commit — cart refreshes, product and
    // related hold.
    loader(CartLoader, () => [
      revalidate(({ isAction, defaultShouldRevalidate }) =>
        isAction ? defaultShouldRevalidate : false,
      ),
    ]),
    path("/", ClientShopIndex, { name: "index" }, () => [
      loader(ClientShopProductsLoader, () => [revalidate(productData)]),
    ]),
    path("/product/:slug", ClientShopProductPage, { name: "product" }, () => [
      // Cache-backed ("use cache" inside the fetch): a WARM document load has
      // this data at first-flush time, so the info section is fully SSR-ed
      // in the initial HTML while the uncached related list streams — the
      // static/dynamic split is declared per data source.
      loader(ClientShopProductLoader, () => [revalidate(productData)]),
      loader(RelatedProductsLoader, () => [revalidate(productData)]),
      // No loading(): the inline Suspense boundaries above each read are the
      // pending UI (they cover cross-route navs too — the canonical commit
      // lands in ~100ms and the skeletons take over). A route-level loading()
      // was measured re-flashing during same-route tab navs — the exact
      // pattern this demo exists to retire.
    ]),
  ]),
]);
