import { map, Meta } from "rsc-router/server";
import { Outlet, Link } from "rsc-router/client";
import type { testRoutes } from "./routes.js";
import {
  ProductsLoader,
  ProductDetailLoader,
  CartQuantityLoader,
  SlowLoader,
  SlowProductDetailLoader,
} from "./loaders.js";
import { Breadcrumbs } from "./handles.js";
import { AddToCartButton } from "./components/AddToCartButton.js";
import { QuantityControl } from "./components/QuantityControl.js";
import {
  StreamingActionButton,
  ActionStatus,
  StreamingActionStatus,
} from "./components/StreamingActionButton.js";
import { Modal } from "./components/Modal.js";
import { RevalidateButton } from "./components/RevalidateButton.js";
import {
  NavigationStatus,
  NavigationStateOnly,
  NavigationStreamingOnly,
} from "./components/NavigationStatus.js";
import { HydrationMismatch } from "./components/HydrationMismatch.js";
import { BreadcrumbNav } from "./components/BreadcrumbNav.js";
import { ClientErrorThrower } from "./components/ClientErrorThrower.js";

export default map<typeof testRoutes>(
  ({ route, layout, intercept, loader, loading }) => [
    // Root layout with HTML structure
    layout(
      (ctx) => {
        // Push "Home" breadcrumb for all routes
        const pushBreadcrumb = ctx.use(Breadcrumbs);
        pushBreadcrumb({ label: "Home", href: "/" });

        // Set default meta tags for the app
        const meta = ctx.use(Meta);
        meta({ title: "RSC Router Test App" });
        meta({ name: "description", content: "E2E test application for RSC Router" });

        return (
          <div data-testid="app-root">
            <nav data-testid="nav">
              <Link to="/" data-testid="nav-home">
                Home
              </Link>
              <NavigationStatus testId="nav-status" />
            </nav>
            <BreadcrumbNav testId="breadcrumbs" />
            <main data-testid="main-content">
              <Outlet />
            </main>
            <Outlet name="@modal" />
          </div>
        );
      },
      () => [
        // Index route - product list
        route(
          "index",
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
                      </Link>
                    </div>
                  ))}
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
                        data-testid="slow-product-link"
                      >
                        /slow-product - Intercept with streaming loader
                      </Link>
                    </li>
                  </ul>
                </div>
              </div>
            );
          },
          () => [loader(ProductsLoader)]
        ),

        // Product detail route (direct navigation)
        route(
          "product.detail",
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
          () => [loader(ProductDetailLoader), loader(CartQuantityLoader)]
        ),

        // Intercept for modal (soft navigation)
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
          () => [loader(ProductDetailLoader), loader(CartQuantityLoader)]
        ),

        // Slow product detail route (direct navigation)
        route(
          "slowProduct.detail",
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
          () => [loader(SlowProductDetailLoader)]
        ),

        // Intercept for slow product modal (soft navigation) with loading state
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
            loading(
              <Modal testId="slow-product-modal">
                <div data-testid="slow-modal-loading">
                  <p>Loading product details...</p>
                  <div data-testid="slow-modal-skeleton">
                    <div style={{ width: "200px", height: "24px", background: "#e0e0e0", marginBottom: "8px" }} />
                    <div style={{ width: "100px", height: "20px", background: "#e0e0e0", marginBottom: "8px" }} />
                    <div style={{ width: "250px", height: "16px", background: "#e0e0e0" }} />
                  </div>
                </div>
              </Modal>
            ),
          ]
        ),

        // Slow route WITHOUT loading - loader should be awaited (blocking)
        route(
          "slow",
          async (ctx) => {
            const { message, count, loadedAt } = await ctx.use(SlowLoader);
            return (
              <div data-testid="slow-page">
                <Link to="/" data-testid="back-link">
                  ← Back to Home
                </Link>
                <h1 data-testid="slow-title">Slow Route (No Loading)</h1>
                <p data-testid="slow-message">{message}</p>
                <p data-testid="slow-count">Load count: {count}</p>
                <p data-testid="slow-loaded-at">Loaded: {loadedAt}</p>
                <div data-testid="slow-actions">
                  <RevalidateButton testId="slow-revalidate-btn" />
                </div>
              </div>
            );
          },
          () => [loader(SlowLoader)]
        ),

        // Slow route WITH loading - loader should stream (non-blocking)
        route(
          "slowStreaming",
          async (ctx) => {
            const { message, count, loadedAt } = await ctx.use(SlowLoader);
            return (
              <div data-testid="slow-streaming-page">
                <Link to="/" data-testid="back-link">
                  ← Back to Home
                </Link>
                <h1 data-testid="slow-streaming-title">
                  Slow Route (With Loading)
                </h1>
                <p data-testid="slow-streaming-message">{message}</p>
                <p data-testid="slow-streaming-count">Load count: {count}</p>
                <p data-testid="slow-streaming-loaded-at">Loaded: {loadedAt}</p>
                <div data-testid="slow-streaming-actions">
                  <RevalidateButton testId="slow-streaming-revalidate-btn" />
                </div>
              </div>
            );
          },
          () => [
            loader(SlowLoader),
            loading(
              <div data-testid="slow-streaming-loading">
                <p>Loading slow data...</p>
              </div>
            ),
          ]
        ),

        // Slow route WITH loading skipSSR - awaited on SSR, streams on navigation
        route(
          "slowStreamingSkipSsr",
          async (ctx) => {
            const { message, count, loadedAt } = await ctx.use(SlowLoader);
            return (
              <div data-testid="slow-skip-ssr-page">
                <Link to="/" data-testid="back-link">
                  ← Back to Home
                </Link>
                <h1 data-testid="slow-skip-ssr-title">
                  Slow Route (Skip SSR Loading)
                </h1>
                <p data-testid="slow-skip-ssr-message">{message}</p>
                <p data-testid="slow-skip-ssr-count">Load count: {count}</p>
                <p data-testid="slow-skip-ssr-loaded-at">Loaded: {loadedAt}</p>
                <div data-testid="slow-skip-ssr-actions">
                  <RevalidateButton testId="slow-skip-ssr-revalidate-btn" />
                </div>
              </div>
            );
          },
          () => [
            loader(SlowLoader),
            loading(
              <div data-testid="slow-skip-ssr-loading">
                <p>Loading slow data...</p>
              </div>,
              true // skipSSR = true
            ),
          ]
        ),

        // Blog routes for testing route resolution and trailing slashes
        route(
          "blog.index",
          (ctx) => {
            const pushBreadcrumb = ctx.use(Breadcrumbs);
            const meta = ctx.use(Meta);
            pushBreadcrumb({ label: "Blog", href: "/blog" });
            meta({ title: "Blog - RSC Router Test App" });
            meta({ name: "description", content: "Blog posts from RSC Router" });
            return (
              <div data-testid="blog-index-page">
                <Link to="/" data-testid="back-link">
                  ← Back to Home
                </Link>
                <h1 data-testid="blog-title">Blog</h1>
                <p data-testid="blog-description">Welcome to the blog</p>
                <ul data-testid="blog-posts">
                  <li>
                    <Link to="/blog/post-1" data-testid="blog-post-link-1">
                      Post 1
                    </Link>
                  </li>
                  <li>
                    <Link to="/blog/post-2" data-testid="blog-post-link-2">
                      Post 2
                    </Link>
                  </li>
                </ul>
              </div>
            );
          }
        ),

        route("blog.post", (ctx) => {
          const pushBreadcrumb = ctx.use(Breadcrumbs);
          const meta = ctx.use(Meta);
          pushBreadcrumb({ label: "Blog", href: "/blog" });
          pushBreadcrumb({ label: `Post ${ctx.params.postId}`, href: `/blog/${ctx.params.postId}` });
          meta({ title: `Post ${ctx.params.postId} - Blog - RSC Router Test App` });
          meta({ name: "description", content: `Content for post ${ctx.params.postId}` });

          // Test async meta - og:description streams in after 500ms
          meta(
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ property: "og:description", content: `Async meta for ${ctx.params.postId}` }),
                500
              )
            )
          );
          return (
            <div data-testid="blog-post-page">
              <Link to="/blog" data-testid="back-to-blog">
                ← Back to Blog
              </Link>
              <h1 data-testid="blog-post-title">Post: {ctx.params.postId}</h1>
              <p data-testid="blog-post-content">
                Content for post {ctx.params.postId}
              </p>
            </div>
          );
        }),

        // Route for testing hydration error detection
        route("hydrationTest", () => (
          <div data-testid="hydration-test-page">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="hydration-test-title">Hydration Test</h1>
            <HydrationMismatch testId="hydration-mismatch" />
          </div>
        )),

        // Error test routes
        route("errors.index", () => (
          <div data-testid="errors-index-page">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="errors-title">Error Boundary Tests</h1>
            <p data-testid="errors-description">
              Test error boundary behavior in different scenarios.
            </p>
            <ul data-testid="error-links">
              <li>
                <Link to="/errors/client-error" data-testid="client-error-link">
                  Client Component Error
                </Link>
              </li>
              <li>
                <Link to="/errors/server-error" data-testid="server-error-link">
                  Server Component Error
                </Link>
              </li>
              <li>
                <Link to="/errors/streaming-error" data-testid="streaming-error-link">
                  Streaming Error
                </Link>
              </li>
            </ul>
          </div>
        )),

        // Route that renders a client component which throws an error on button click
        route("errors.clientError", () => (
          <div data-testid="client-error-page">
            <Link to="/errors" data-testid="back-link">
              ← Back to Error Tests
            </Link>
            <h1 data-testid="client-error-title">Client Component Error Test</h1>
            <p data-testid="client-error-description">
              This page renders a client component that throws an error when triggered.
            </p>
            <ClientErrorThrower testId="client-error-thrower" />
          </div>
        )),

        // Route that throws a server error during render
        route("errors.serverError", () => {
          throw new Error("Server error: This error was thrown during server-side render");
          return (
            <div data-testid="server-error-page">
              This should never render
            </div>
          );
        }),

        // Route that throws an error during streaming (async render)
        route(
          "errors.streamingError",
          async () => {
            // Simulate async work then throw
            await new Promise((resolve) => setTimeout(resolve, 500));
            throw new Error("Streaming error: This error was thrown during async streaming");
            return (
              <div data-testid="streaming-error-page">
                This should never render
              </div>
            );
          },
          () => [
            loading(
              <div data-testid="streaming-error-loading">
                <p>Loading streaming content...</p>
              </div>
            ),
          ]
        ),
      ]
    ),
  ]
);
