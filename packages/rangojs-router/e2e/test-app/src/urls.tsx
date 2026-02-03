import { urls } from "@rangojs/router";
import { Meta } from "@rangojs/router/server";
import { Link } from "@rangojs/router/client";
import { RootLayout } from "./components/layouts/index.js";
import { blogPatterns } from "./urls/blog.js";
import { slowPatternsWithoutDetail } from "./urls/slow.js";
import { errorsPatterns } from "./urls/errors.js";
import {
  metaTemplatePatterns,
  metaUnsetPatterns,
  metaMergePatterns,
  handlePatterns,
  hydrationPatterns,
  trailingSlashPatterns,
} from "./urls/meta.js";
import { hooksPatterns } from "./urls/hooks.js";
import { middlewarePatterns } from "./urls/middleware.js";
import { cachePatterns } from "./urls/cache.js";
import { themePatterns } from "./urls/theme.js";
import { hrefPatterns } from "./urls/href.js";
import {
  ProductsLoader,
  ProductDetailLoader,
  CartQuantityLoader,
  SlowProductDetailLoader,
} from "./loaders.js";
import { SlowProductLocationState } from "./location-states.js";
import { Breadcrumbs } from "./handles.js";
import { Modal } from "./components/Modal.js";
import { QuantityControl } from "./components/QuantityControl.js";
import { SlowModalSkeleton } from "./components/SlowModalSkeleton.js";
import {
  StreamingActionButton,
  StreamingActionStatus,
} from "./components/StreamingActionButton.js";
import { AddToCartButton } from "./components/AddToCartButton.js";
import { LinkPendingBadge } from "./components/LinkStatusDisplay.js";
import { RevalidateButton } from "./components/RevalidateButton.js";

/**
 * Main URL patterns - Django-style routing API
 *
 * Core routes (index, product) and slow-product route are defined inline
 * because they have intercepts that need to share the same parent context.
 * Other routes are included from separate modules.
 */
export const urlpatterns = urls(({ layout, path, include, intercept, loader, loading, when, middleware }) => [
  layout(RootLayout, () => [
    // === CORE ROUTES (inline for intercept support) ===

    // Index route - product list
    path(
      "/",
      async (ctx) => {
        const { products, loadedAt } = await ctx.use(ProductsLoader);
        return (
          <div data-testid="index-page">
            <h1 data-testid="page-title">Products</h1>
            <p data-testid="loaded-at">Loaded: {loadedAt}</p>
            <div data-testid="product-list">
              {products.map((product) => (
                <div
                  key={product.id}
                  data-testid={`product-card-${product.id}`}
                >
                  <Link
                    to={`/product/${product.id}`}
                    data-testid={`product-link-${product.id}`}
                  >
                    <h3>{product.name}</h3>
                    <p>${product.price}</p>
                    <LinkPendingBadge />
                  </Link>
                </div>
              ))}
            </div>
            <div data-testid="link-status-test" style={{ marginTop: "2rem" }}>
              <h2>Link Status Tests (useLinkStatus)</h2>
              <p style={{ fontSize: "12px", color: "#666" }}>
                Click a link to see its pending badge change. Only the clicked link shows pending.
              </p>
              <ul>
                <li>
                  <Link to="/slow" data-testid="link-status-slow">
                    Slow Route <LinkPendingBadge />
                  </Link>
                </li>
                <li>
                  <Link to="/slow-streaming" data-testid="link-status-slow-streaming">
                    Slow Streaming <LinkPendingBadge />
                  </Link>
                </li>
                <li>
                  <Link to="/blog" data-testid="link-status-blog">
                    Blog <LinkPendingBadge />
                  </Link>
                </li>
              </ul>
            </div>
            <div data-testid="loader-test-links" style={{ marginTop: "2rem" }}>
              <h2>Loader Behavior Tests</h2>
              <ul>
                <li>
                  <Link to="/slow" data-testid="slow-link">
                    /slow - No loading (awaited)
                  </Link>
                </li>
                <li>
                  <Link to="/slow-streaming" data-testid="slow-streaming-link">
                    /slow-streaming - With loading (streaming)
                  </Link>
                </li>
                <li>
                  <Link
                    to="/slow-streaming-skip-ssr"
                    data-testid="slow-skip-ssr-link"
                  >
                    /slow-streaming-skip-ssr - Skip SSR loading
                  </Link>
                </li>
                <li>
                  <Link
                    to="/slow-product/slow-product-a"
                    state={[SlowProductLocationState({ productName: "Slow Product A", productPrice: 99 })]}
                    data-testid="slow-product-link"
                  >
                    /slow-product - Intercept with streaming loader (with state)
                  </Link>
                </li>
                <li>
                  <Link
                    to="/slow-product/slow-product-b"
                    data-testid="slow-product-link-no-state"
                  >
                    /slow-product - Intercept without state
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        );
      },
      { name: "index" },
      () => [loader(ProductsLoader)]
    ),

    // Product detail route (direct navigation)
    path(
      "/product/:productId",
      async (ctx) => {
        // Push product breadcrumb with async content
        const pushBreadcrumb = ctx.use(Breadcrumbs);
        const meta = ctx.use(Meta);
        const { product, loadedAt } = await ctx.use(ProductDetailLoader);
        const { quantity } = await ctx.use(CartQuantityLoader);

        // Set page-specific meta after awaiting product data (streaming metadata test)
        meta({ title: `${product.name} - RSC Router Test App` });
        meta({ name: "description", content: product.description });
        meta({ property: "og:title", content: product.name });
        // JSON-LD structured data for product
        meta({
          "script:ld+json": {
            "@context": "https://schema.org",
            "@type": "Product",
            name: product.name,
            description: product.description,
            offers: {
              "@type": "Offer",
              price: product.price,
              priceCurrency: "USD",
            },
          },
        });

        pushBreadcrumb({
          label: product.name,
          href: `/product/${product.id}`,
          content: new Promise((resolve) =>
            setTimeout(
              () => resolve(<span data-testid="breadcrumb-async">Loaded: {loadedAt}</span>),
              1000
            )
          ),
        });
        return (
          <div data-testid="product-detail-page">
            <Link to="/" data-testid="back-link">
              ← Back to Products
            </Link>
            <h1 data-testid="product-name">{product.name}</h1>
            <p data-testid="product-price">${product.price}</p>
            <p data-testid="product-description">{product.description}</p>
            <p data-testid="product-loaded-at">Loaded: {loadedAt}</p>
            <div data-testid="actions-section">
              <h2>Actions</h2>
              <div data-testid="add-to-cart-section">
                <h3>1. Add to Cart (with result)</h3>
                <AddToCartButton
                  productId={product.id}
                  testId="add-to-cart-btn"
                />
              </div>
              <div data-testid="quantity-section">
                <h3>2. Quantity Control (optimistic)</h3>
                <QuantityControl
                  productId={product.id}
                  initialQuantity={quantity}
                  testId="quantity-control"
                />
              </div>
              <div data-testid="streaming-section">
                <h3>3. Streaming Action (3s delay)</h3>
                <StreamingActionStatus />
                <StreamingActionButton
                  productId={product.id}
                  testId="streaming-btn"
                />
              </div>
            </div>
            <div data-testid="segment-metadata">
              <h3>Segment Metadata</h3>
              <ul>
                <li>Product ID: {product.id}</li>
                <li>Rendered: {new Date().toISOString()}</li>
              </ul>
            </div>
          </div>
        );
      },
      { name: "product.detail" },
      () => [loader(ProductDetailLoader), loader(CartQuantityLoader)]
    ),

    // Slow product detail route (direct navigation) - inline for intercept support
    path(
      "/slow-product/:productId",
      async (ctx) => {
        const { product, loadedAt } = await ctx.use(SlowProductDetailLoader);
        return (
          <div data-testid="slow-product-detail-page">
            <Link to="/" data-testid="back-link">
              ← Back to Products
            </Link>
            <h1 data-testid="slow-product-name">{product.name}</h1>
            <p data-testid="slow-product-price">${product.price}</p>
            <p data-testid="slow-product-description">
              {product.description}
            </p>
            <p data-testid="slow-product-loaded-at">Loaded: {loadedAt}</p>
            <div data-testid="slow-product-segment-metadata">
              <h3>Segment Metadata</h3>
              <ul>
                <li>Product ID: {product.id}</li>
                <li>Rendered: {new Date().toISOString()}</li>
              </ul>
            </div>
          </div>
        );
      },
      { name: "slowProduct.detail" },
      () => [loader(SlowProductDetailLoader)]
    ),

    // === INTERCEPTS ===
    // Defined after routes but in same layout callback for shared parent context

    // Product detail intercept - only when navigating from index page
    intercept(
      "@modal",
      "product.detail",
      async (ctx) => {
        const { product } = await ctx.use(ProductDetailLoader);
        const { quantity } = await ctx.use(CartQuantityLoader);
        return (
          <Modal testId="product-modal">
            <div data-testid="modal-header">
              <span data-testid="intercept-indicator">Intercepted</span>
              <h2 data-testid="modal-product-name">{product.name}</h2>
            </div>
            <p data-testid="modal-product-price">${product.price}</p>
            <p data-testid="modal-product-description">
              {product.description}
            </p>
            <div data-testid="modal-quantity">
              <QuantityControl
                productId={product.id}
                initialQuantity={quantity}
                testId="modal-quantity-control"
              />
            </div>
            <Link
              to={`/product/${product.id}`}
              data-testid="view-full-details"
              style={{
                display: "inline-block",
                marginTop: "16px",
                padding: "8px 16px",
                background: "#2196F3",
                color: "white",
                textDecoration: "none",
                borderRadius: "4px",
              }}
            >
              View Full Details
            </Link>
          </Modal>
        );
      },
      () => [
        when(({ from }) => from.pathname === "/"),
        loader(ProductDetailLoader),
        loader(CartQuantityLoader),
      ]
    ),

    // Slow product intercept - with loading state
    intercept(
      "@modal",
      "slowProduct.detail",
      async (ctx) => {
        const { product } = await ctx.use(SlowProductDetailLoader);
        return (
          <Modal testId="slow-product-modal">
            <div data-testid="slow-modal-header">
              <span data-testid="slow-intercept-indicator">Intercepted</span>
              <h2 data-testid="slow-modal-product-name">{product.name}</h2>
            </div>
            <p data-testid="slow-modal-product-price">${product.price}</p>
            <p data-testid="slow-modal-product-description">
              {product.description}
            </p>
            <div data-testid="slow-modal-streaming-section">
              <h3>Streaming Action (3s delay)</h3>
              <StreamingActionStatus />
              <StreamingActionButton
                productId={product.id}
                testId="slow-modal-streaming-btn"
              />
            </div>
            <Link
              to={`/slow-product/${product.id}`}
              data-testid="slow-view-full-details"
              style={{
                display: "inline-block",
                marginTop: "16px",
                padding: "8px 16px",
                background: "#2196F3",
                color: "white",
                textDecoration: "none",
                borderRadius: "4px",
              }}
            >
              View Full Details
            </Link>
          </Modal>
        );
      },
      () => [
        loader(SlowProductDetailLoader),
        loading(<SlowModalSkeleton />),
        middleware(async (ctx, next) => {
          await next();
          ctx.header("X-Intercept-Middleware", "applied");
          ctx.setCookie("intercept-visited", "true", { path: "/" });
        }),
      ]
    ),

    // === INCLUDED PATTERNS (no intercepts needed) ===

    // Blog patterns
    include("/blog", blogPatterns, { name: "blog" }),

    // Slow/streaming patterns (without slowProduct.detail which is inline above)
    include("/", slowPatternsWithoutDetail),

    // Error patterns - already has /errors prefix in paths
    include("/", errorsPatterns),

    // Meta patterns - already have their prefixes in paths
    include("/meta-template", metaTemplatePatterns, { name: "metaTemplate" }),
    include("/meta-unset", metaUnsetPatterns, { name: "metaUnset" }),
    include("/meta-merge", metaMergePatterns, { name: "metaMerge" }),

    // Handle passthrough and hydration patterns
    include("/", handlePatterns),
    include("/", hydrationPatterns),

    // Trailing slash patterns
    include("/", trailingSlashPatterns),

    // Hook test patterns - already have their prefixes in paths
    include("/", hooksPatterns),

    // Middleware test patterns
    include("/middleware-test", middlewarePatterns, { name: "middlewareTest" }),

    // Cache test patterns (includes intercepts with layouts)
    include("/", cachePatterns),

    // Theme patterns
    include("/theme", themePatterns, { name: "theme" }),

    // Href test patterns
    include("/href", hrefPatterns, { name: "href" }),
  ]),
]);
