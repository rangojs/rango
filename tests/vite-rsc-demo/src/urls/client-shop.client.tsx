"use client";

import React, { Suspense } from "react";
import {
  clientUrls,
  Link,
  useHandle,
  useLoader,
  useOutlet,
  useParams,
  useSearchParams,
  type ClientRevalidateArgs,
} from "@rangojs/router/client";
import { Meta } from "@/handles/meta.js";
import {
  ClientShopProductsLoader,
  ClientShopProductLoader,
} from "@/handlers/shop/loaders/client-shop-products.js";
import { RelatedProductsLoader } from "@/handlers/shop/loaders/related-products.js";
import {
  ClientShopSsrProductLoader,
  ClientShopSsrSidecarLoader,
} from "@/handlers/shop/loaders/client-shop-ssr.js";
import { CartLoader } from "@/handlers/shop/loaders/cart.js";
import * as ShopActions from "@/handlers/shop/actions/shop.actions.js";
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

const FILTER_CATEGORIES = ["electronics", "sports", "home"];

function FilterLink({
  category,
  active,
}: {
  category: string | null;
  active: boolean;
}) {
  return (
    <Link
      to={category ? `/client-shop?category=${category}` : "/client-shop"}
      // Filter combinations are unbounded in a real PLP — nothing to prefetch.
      prefetch="none"
      data-testid={`client-shop-filter-${category ?? "all"}`}
      style={{
        padding: "0.4rem 0.9rem",
        borderRadius: 6,
        textDecoration: "none",
        background: active ? "#0f766e" : "#e5e7eb",
        color: active ? "white" : "#111",
      }}
    >
      {category ?? "all"}
    </Link>
  );
}

function ClientShopIndex() {
  const [searchParams, setSearchParams] = useSearchParams();
  const category = searchParams.get("category");

  return (
    <div data-testid="client-shop-index">
      <h2>All products</h2>
      {/* Filters are SAME-ROUTE navigations (search change only): the list
          loader re-runs while the route — and this component — stay mounted. */}
      <nav
        data-testid="client-shop-filters"
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}
      >
        <FilterLink category={null} active={category === null} />
        {FILTER_CATEGORIES.map((c) => (
          <FilterLink key={c} category={c} active={category === c} />
        ))}
        {/* Programmatic write: setSearchParams replaces the whole search
            string (RR semantics) and navigates the same route — the commit
            holds content exactly like the Link filters. replace:true keeps
            "clear" from stacking a history entry. */}
        <button
          type="button"
          data-testid="client-shop-filter-clear"
          onClick={() => void setSearchParams({}, { replace: true })}
          style={{ padding: "0.4rem 0.9rem", borderRadius: 6 }}
        >
          clear
        </button>
      </nav>
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
      <p style={{ color: "#888" }}>
        {/* ssr: false fixtures: the awaited loader's data/meta/404
            are deterministic in the SSR'd document; on these client navs the
            same loader still streams. prefetch="none" keeps the nav-lane
            streaming path deterministic. */}
        <Link
          to="/client-shop/ssr/wireless-headphones"
          prefetch="none"
          data-testid="client-shop-ssr-link"
        >
          SSR-complete product
        </Link>
        {" · "}
        <Link
          to="/client-shop/ssr/desk-lamp"
          prefetch="none"
          data-testid="client-shop-ssr-link-alt"
        >
          SSR-complete product (alt)
        </Link>
        {" · "}
        <Link
          to="/client-shop/ppr/wireless-headphones"
          prefetch="none"
          data-testid="client-shop-ppr-link"
        >
          PPR product
        </Link>
        {" · "}
        <Link
          to="/client-shop/ppr/desk-lamp"
          prefetch="none"
          data-testid="client-shop-ppr-link-alt"
        >
          PPR product (alt)
        </Link>
      </p>
    </div>
  );
}

function SsrAwaitedSkeleton() {
  return (
    <div
      data-testid="client-shop-ssr-awaited-skeleton"
      style={{ color: "#888" }}
    >
      Loading SSR product…
    </div>
  );
}

function SsrSidecarSkeleton() {
  return (
    <div
      data-testid="client-shop-ssr-sidecar-skeleton"
      style={{ color: "#888" }}
    >
      Loading sidecar…
    </div>
  );
}

function SsrAwaitedSection() {
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  // Single template child: adjacent JSX text expressions SSR with <!-- -->
  // separators, and the e2e asserts this exact string in the raw HTML.
  return (
    <div data-testid="client-shop-ssr-name">
      {`${product.name} — $${product.price}`}
    </div>
  );
}

function SsrSidecarSection() {
  const { data } = useLoader(ClientShopSsrSidecarLoader);
  return <div data-testid="client-shop-ssr-sidecar">{data.note}</div>;
}

/* Verbatim port of the consumer app's reduced repro: pure-HTML CategoryButton
 * (no Link, no icon, no img), gated CategoriesButtons parent, and the exact
 * consumption shape — useLoader read ABOVE the boundary, the nested category
 * object handed through as a prop, a bare-string fallback. */
function ReproCategoryButton({
  name,
  thumbnailUrl,
  productsCount,
}: {
  name: string;
  thumbnailUrl: string | null;
  productsCount: number | null;
}) {
  return (
    <div className="border-light-gray flex flex-shrink-0 cursor-pointer flex-col items-center rounded-lg border p-2 group-hover:border-brand-primary">
      <div className="h-[60px] w-[100px]">{!thumbnailUrl ? null : "img"}</div>
      <div className="max-w-[100px] pt-2 text-center">
        <p className="leading-lg line-clamp-2 h-[38px] overflow-hidden text-ellipsis whitespace-normal break-words text-sm">
          {name}
        </p>
      </div>
      <div className="pt-[5px]">
        <p className="leading-lg text-xs font-bold text-neutral-3">
          ({productsCount ?? 0})
        </p>
      </div>
    </div>
  );
}

function ReproCategoriesButtons({
  category,
}: {
  category:
    | import("@/handlers/shop/loaders/client-shop-ssr.js").SsrCategory
    | null;
}) {
  if (!category?.showSubcategoriesOnPLP) return null;

  const subcategories = category.subcategories;
  if (subcategories.length === 0) return null;
  if (!subcategories.some((subcategory) => subcategory.showCategoryOnPLP)) {
    return null;
  }

  return (
    <div
      className="mx-6 overflow-hidden"
      data-testid="client-shop-ssr-catbuttons"
    >
      <div className="bapcor-scrollbar gap-x-3 overflow-x-auto pb-[12px] pt-3 sm:flex lg:grid lg:grid-cols-8 lg:gap-y-3">
        {subcategories.map((subcategory) =>
          subcategory.showCategoryOnPLP ? (
            <ReproCategoryButton
              key={subcategory.id}
              name={subcategory.name}
              thumbnailUrl={subcategory.thumbnailUrl}
              productsCount={subcategory.productsCount}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

/** The consumer shape: read above the boundary, category through props. */
function SsrCategoryProbe() {
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  return (
    <Suspense fallback={"CategoriesButtons"}>
      <ReproCategoriesButtons category={product.category} />
    </Suspense>
  );
}

/**
 * Containment for the probe's page-level read: a real consumer app always has
 * a boundary pair somewhere above its reader components. Without these, the
 * probe's useLoader (deliberately outside any Suspense) re-throws the
 * loader's notFound() at the page level where nothing handles it (404 -> 500)
 * and hoists nav-lane suspension past the per-section skeletons.
 */
class SsrProbeErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean }
> {
  state: { failed: boolean } = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function SsrCategoryProbeContained() {
  return (
    <Suspense fallback={null}>
      <SsrProbeErrorBoundary>
        <SsrCategoryProbe />
      </SsrProbeErrorBoundary>
    </Suspense>
  );
}

function SsrComplexSkeleton() {
  return (
    <div
      data-testid="client-shop-ssr-complex-skeleton"
      style={{ color: "#888" }}
    >
      Loading breadcrumbs…
    </div>
  );
}

/**
 * Deeper read-site tree for the SAME flagged loader: nested divs, a
 * breadcrumbs nav, and several <Link> elements whose targets derive from
 * loader data + params — the realistic PDP shape (breadcrumbs, badges, buy
 * panel). Pins that an awaited read's SSR-completeness does not degrade when
 * the subtree under the boundary is element-heavy rather than a bare text
 * node.
 */
function SsrComplexSection() {
  const { slug } = useParams<{ slug: string }>();
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  return (
    <div data-testid="client-shop-ssr-complex">
      <nav data-testid="client-shop-ssr-breadcrumbs" aria-label="Breadcrumb">
        <Link to="/client-shop" prefetch="none">
          Shop
        </Link>
        {" / "}
        <Link to={`/client-shop/ssr/${slug}`} prefetch="none">
          {product.name}
        </Link>
      </nav>
      <div>
        <div data-testid="client-shop-ssr-complex-name">{product.name}</div>
        <Link
          to={`/client-shop/product/${slug}`}
          prefetch="none"
          data-testid="client-shop-ssr-complex-link"
        >
          {`View product page — $${product.price}`}
        </Link>
      </div>
    </div>
  );
}

/**
 * SSR-visible Meta read: renders the handle value into the markup, so the raw
 * document HTML shows WHICH channel delivered the loader's push. In the SSR
 * snapshot (the flagged loader was awaited) the div carries the title text;
 * a late (handlesLate) push would leave it empty until hydration. TitleUpdater
 * can't pin this — document.title is set in an effect either way.
 */
function SsrMetaEcho() {
  const meta = useHandle(Meta);
  return <div data-testid="client-shop-ssr-title">{meta?.title ?? ""}</div>;
}

function SsrInlineGridSkeleton() {
  return (
    <div data-testid="client-shop-ssr-inline-grid-skeleton">Loading grid…</div>
  );
}

/* PLP-shaped block off the flagged loader, sized past BOTH Fizz outlining
 * gates on its own: >500 bytes (the hardcoded isEligibleForOutlining floor)
 * and >12800 bytes (the progressiveChunkSize default), so `flushedByteSize +
 * boundary.byteSize > progressiveChunkSize` holds regardless of shell size or
 * mode. Pins the ssr:false auto-raise: without it Fizz moves this COMPLETED
 * boundary to an end-of-stream <div hidden> + $RC reveal; with it the tiles
 * are in-place in the raw document (the smaller sections above stay under the
 * 500-byte floor and inline regardless). */
function SsrInlineGrid() {
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  return (
    <ul data-testid="client-shop-ssr-inline-grid">
      {Array.from({ length: 140 }, (_, i) => (
        <li key={i} data-testid={`client-shop-ssr-inline-tile-${i}`}>
          {product.name} tile {i} — in-place row above the outlining threshold
        </li>
      ))}
    </ul>
  );
}

/**
 * ssr: false showcase. The awaited section's loader is flagged, so a
 * DOCUMENT load carries its data (and its Meta title, and a real 404 for
 * unknown slugs) in the initial HTML — its skeleton never SSRs. The sidecar
 * has the same latency but no flag: it SSRs as its skeleton and streams in.
 * On client navigations both stream behind their boundaries.
 */
function ClientShopSsrPage() {
  return (
    <div data-testid="client-shop-ssr">
      <SsrMetaEcho />
      <Suspense fallback={<SsrAwaitedSkeleton />}>
        <SsrAwaitedSection />
      </Suspense>
      <Suspense fallback={<SsrComplexSkeleton />}>
        <SsrComplexSection />
      </Suspense>
      <Suspense fallback={<SsrInlineGridSkeleton />}>
        <SsrInlineGrid />
      </Suspense>
      <SsrCategoryProbeContained />
      {/* The consumer app's final reduction: literal object, zero loader
          involvement, pure-HTML children — nothing here can suspend. */}
      <Suspense fallback={"|CategoriesButtons fallback|"}>
        <ReproCategoriesButtons
          category={{
            showSubcategoriesOnPLP: true,
            subcategories: [
              {
                id: "1",
                name: "literal-probe",
                thumbnailUrl: null,
                productsCount: 1,
                showCategoryOnPLP: true,
              },
            ],
          }}
        />
      </Suspense>
      <Suspense fallback={<SsrSidecarSkeleton />}>
        <SsrSidecarSection />
      </Suspense>
      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/client-shop" data-testid="client-shop-ssr-back">
          ← Back to products
        </Link>
      </p>
    </div>
  );
}

function PprAwaitedSkeleton() {
  return (
    <div
      data-testid="client-shop-ppr-awaited-skeleton"
      style={{ color: "#888" }}
    >
      Loading PPR product…
    </div>
  );
}

function PprSidecarSkeleton() {
  return (
    <div
      data-testid="client-shop-ppr-sidecar-skeleton"
      style={{ color: "#888" }}
    >
      Loading PPR sidecar…
    </div>
  );
}

function PprAwaitedSection() {
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  return (
    <div data-testid="client-shop-ppr-name">
      {`${product.name} — $${product.price}`}
    </div>
  );
}

function PprSidecarSection() {
  const { data } = useLoader(ClientShopSsrSidecarLoader);
  return <div data-testid="client-shop-ppr-sidecar">{data.note}</div>;
}

function PprComplexSkeleton() {
  return (
    <div
      data-testid="client-shop-ppr-complex-skeleton"
      style={{ color: "#888" }}
    >
      Loading PPR breadcrumbs…
    </div>
  );
}

/** The element-heavy read-site shape on the ppr route — the baked loader's
 *  divs-and-Links subtree is shell material, byte-agreed on HIT hydration. */
function PprComplexSection() {
  const { slug } = useParams<{ slug: string }>();
  const { data: product } = useLoader(ClientShopSsrProductLoader);
  return (
    <div data-testid="client-shop-ppr-complex">
      <nav data-testid="client-shop-ppr-breadcrumbs" aria-label="Breadcrumb">
        <Link to="/client-shop" prefetch="none">
          Shop
        </Link>
        {" / "}
        <Link to={`/client-shop/ppr/${slug}`} prefetch="none">
          {product.name}
        </Link>
      </nav>
      <div>
        <div data-testid="client-shop-ppr-complex-name">{product.name}</div>
        <Link
          to={`/client-shop/product/${slug}`}
          prefetch="none"
          data-testid="client-shop-ppr-complex-link"
        >
          {`View product page — $${product.price}`}
        </Link>
      </div>
    </div>
  );
}

function PprMetaEcho() {
  const meta = useHandle(Meta);
  return <div data-testid="client-shop-ppr-title">{meta?.title ?? ""}</div>;
}

/**
 * The /ssr shape with a shell declaration (ppr path option). No loading():
 * that is the loader-container-bake composition — the route's loaders sit on
 * the BAKE lane, so at shell capture BOTH execute and their settled values
 * freeze into the stored shell (the sidecar included; contrast the test-app's
 * /ppr group route, where a loading() keeps its plain loader a live hole).
 * First document = MISS: behaves exactly like /ssr (flagged loader awaited,
 * sidecar streams) while capture runs in the background. Later documents =
 * HIT: the whole page — both sections and the baked Meta title in <head> —
 * serves from the shell with no skeletons and no loader execution.
 */
function ClientShopPprPage() {
  return (
    <div data-testid="client-shop-ppr">
      <PprMetaEcho />
      <Suspense fallback={<PprAwaitedSkeleton />}>
        <PprAwaitedSection />
      </Suspense>
      <Suspense fallback={<PprComplexSkeleton />}>
        <PprComplexSection />
      </Suspense>
      <Suspense fallback={<PprSidecarSkeleton />}>
        <PprSidecarSection />
      </Suspense>
      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/client-shop" data-testid="client-shop-ppr-back">
          ← Back to products
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
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? "details";

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
  const [searchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? "details";

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
}: Pick<
  ClientRevalidateArgs,
  "isAction" | "currentParams" | "nextParams" | "defaultShouldRevalidate"
>) {
  if (isAction()) return false;
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
      revalidate(({ isAction }) => isAction(ShopActions)),
    ]),
    path("/", ClientShopIndex, { name: "index" }, () => [
      // The list is search-driven (category filters): a search change must
      // refetch, an action (add-to-cart) must not, and slug-param logic from
      // productData does not apply here.
      loader(ClientShopProductsLoader, () => [
        revalidate(
          ({ isAction, currentUrl, nextUrl, defaultShouldRevalidate }) =>
            !isAction() && currentUrl.search !== nextUrl.search
              ? defaultShouldRevalidate
              : false,
        ),
      ]),
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
      // lands in ~100ms and the skeletons take over). Same-route SEARCH navs
      // hold previous content by default (isSameStructureNav transition
      // commit), so a route-level loading() could no longer re-flash on tab
      // navs — inline boundaries remain the finer-grained choice here.
    ]),
    path("/ssr/:slug", ClientShopSsrPage, { name: "ssr" }, () => [
      loader(ClientShopSsrProductLoader, { ssr: false }, () => [
        revalidate(productData),
      ]),
      loader(ClientShopSsrSidecarLoader, () => [revalidate(productData)]),
    ]),
    path(
      "/ppr/:slug",
      ClientShopPprPage,
      { name: "ppr", ppr: { ttl: 300, swr: 120 } },
      () => [
        loader(ClientShopSsrProductLoader, { ssr: false }, () => [
          revalidate(productData),
        ]),
        loader(ClientShopSsrSidecarLoader, () => [revalidate(productData)]),
      ],
    ),
  ]),
]);
