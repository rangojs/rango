import { map, Meta } from "rsc-router/server";
import { Outlet, Link } from "rsc-router/client";
import type { testRoutes } from "./routes.js";
import { SlowProductLocationState } from "./location-states.js";
import {
  ProductsLoader,
  ProductDetailLoader,
  CartQuantityLoader,
  SlowLoader,
  SlowProductDetailLoader,
  FetchableTestLoader,
  HookTestLoader,
  HookTestLoaderB,
  UnregisteredLoader,
  ErrorLoader,
  ProtectedLoader,
  ComposingNonFetchableUsesNonFetchable,
  ComposingNonFetchableUsesFetchable,
  ComposingFetchableUsesFetchable,
  ComposingFetchableUsesNonFetchable,
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
import { SlowModalSkeleton } from "./components/SlowModalSkeleton.js";
import { RevalidateButton } from "./components/RevalidateButton.js";
import {
  NavigationStatus,
  NavigationStateOnly,
  NavigationStreamingOnly,
} from "./components/NavigationStatus.js";
import { HydrationMismatch } from "./components/HydrationMismatch.js";
import { BreadcrumbNav } from "./components/BreadcrumbNav.js";
import { ClientErrorThrower } from "./components/ClientErrorThrower.js";
import { ChildMetaSetter } from "./components/ChildMetaSetter.js";
import { AsyncChildMetaSetter } from "./components/AsyncChildMetaSetter.js";
import { SegmentsDisplay } from "./components/SegmentsDisplay.js";
import { LinkPendingBadge } from "./components/LinkStatusDisplay.js";
import { FetchLoaderTest } from "./components/FetchLoaderTest.js";
import {
  UseLoaderTest,
  UseFetchLoaderPreloadedTest,
  UseFetchLoaderUnregisteredTest,
  UseLoaderTestB,
  UseFetchLoaderTestB,
  ErrorLoaderTest,
  ProtectedLoaderTest,
  UnhandledErrorLoaderTest,
  UseLoaderThrowsTest,
  IsLoadingTest,
  FormActionTest,
  FormActionProgressiveTest,
} from "./components/HookTests.js";

export default map<typeof testRoutes>(
  ({ route, layout, intercept, loader, loading, when }) => [
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
            <SegmentsDisplay />
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
        // Only intercept when coming from the index page (/), not from other pages like /blog
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
            // Only intercept when navigating from the index page
            when(({ from }) => from.pathname === "/"),
            loader(ProductDetailLoader),
            loader(CartQuantityLoader),
          ]
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
            loading(<SlowModalSkeleton />),
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
                <div data-testid="blog-product-links" style={{ marginTop: "1rem" }}>
                  <h3>Featured Products</h3>
                  <Link to="/product/product-a" data-testid="blog-product-link">
                    View Product A
                  </Link>
                </div>
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

          // Test async meta with Promise - og:description streams in after 500ms
          meta(
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ property: "og:description", content: `Async meta for ${ctx.params.postId}` }),
                500
              )
            )
          );

          // Test async meta with IIFE pattern - og:author streams in after 300ms
          meta((async () => {
            await new Promise((r) => setTimeout(r, 300));
            return { name: "author", content: `Author of ${ctx.params.postId}` };
          })());
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

        // Trailing slash configuration test routes
        route("trailingSlash.ignore", () => (
          <div data-testid="ts-ignore-page">
            <Link to="/" data-testid="back-link">← Back to Home</Link>
            <h1 data-testid="ts-ignore-title">Trailing Slash: Ignore</h1>
            <p data-testid="ts-ignore-description">
              This route matches both /ts-ignore and /ts-ignore/ without redirect.
            </p>
          </div>
        )),

        route("trailingSlash.always", () => (
          <div data-testid="ts-always-page">
            <Link to="/" data-testid="back-link">← Back to Home</Link>
            <h1 data-testid="ts-always-title">Trailing Slash: Always</h1>
            <p data-testid="ts-always-description">
              This route redirects /ts-always to /ts-always/ (308).
            </p>
          </div>
        )),

        route("trailingSlash.never", () => (
          <div data-testid="ts-never-page">
            <Link to="/" data-testid="back-link">← Back to Home</Link>
            <h1 data-testid="ts-never-title">Trailing Slash: Never</h1>
            <p data-testid="ts-never-description">
              This route redirects /ts-never/ to /ts-never (308).
            </p>
          </div>
        )),

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

        // Route for testing handle passthrough to child RSC components
        route("handlePassthrough", (ctx) => {
          const pushBreadcrumb = ctx.use(Breadcrumbs);
          const meta = ctx.use(Meta);

          // Push breadcrumb from parent
          pushBreadcrumb({ label: "Handle Passthrough Test", href: "/handle-passthrough" });

          return (
            <div data-testid="handle-passthrough-page">
              <Link to="/" data-testid="back-link">
                ← Back to Home
              </Link>
              <h1 data-testid="passthrough-title">Handle Passthrough Test</h1>
              <p data-testid="passthrough-description">
                Testing meta handle passed to child RSC component
              </p>
              {/* Pass meta function to child RSC component */}
              <ChildMetaSetter
                meta={meta}
                title="Child Set Title - RSC Router"
                description="Meta set by child RSC component"
              />
            </div>
          );
        }),

        // Route for testing async handle passthrough (meta set after delay)
        route(
          "handlePassthroughAsync",
          (ctx) => {
            const pushBreadcrumb = ctx.use(Breadcrumbs);
            const meta = ctx.use(Meta);

            // Push breadcrumb from parent
            pushBreadcrumb({ label: "Async Handle Passthrough", href: "/handle-passthrough-async" });

            return (
              <div data-testid="handle-passthrough-async-page">
                <Link to="/" data-testid="back-link">
                  ← Back to Home
                </Link>
                <h1 data-testid="async-passthrough-title">Async Handle Passthrough Test</h1>
                <p data-testid="async-passthrough-description">
                  Testing meta handle passed to async child RSC (2s delay)
                </p>
                {/* Pass meta function to async child RSC component */}
                <AsyncChildMetaSetter
                  meta={meta}
                  title="Async Child Title - RSC Router"
                  description="Meta set by async child after 2s delay"
                  delayMs={2000}
                />
              </div>
            );
          },
          () => [
            loading(
              <div data-testid="async-passthrough-loading">
                <p>Loading async child...</p>
              </div>
            ),
          ]
        ),

        // =====================================================
        // META TEMPLATE TESTS
        // =====================================================

        // Layout with title template - sets template for child routes
        layout(
          (ctx) => {
            const meta = ctx.use(Meta);
            // Set title template - child routes will have their title wrapped
            meta({ title: { template: "%s | Test Site", default: "Test Site" } });
            meta({ name: "author", content: "Test Author" });

            return (
              <div data-testid="meta-template-layout">
                <nav data-testid="meta-template-nav">
                  <Link to="/meta-template" data-testid="meta-template-index-link">
                    Template Index
                  </Link>
                  <Link to="/meta-template/child" data-testid="meta-template-child-link">
                    Child
                  </Link>
                  <Link to="/meta-template/absolute" data-testid="meta-template-absolute-link">
                    Absolute
                  </Link>
                  <Link to="/meta-template/nested" data-testid="meta-template-nested-link">
                    Nested
                  </Link>
                </nav>
                <Outlet />
              </div>
            );
          },
          () => [
            // Index route - uses default title from template
            route("metaTemplate.index", () => (
              <div data-testid="meta-template-index-page">
                <h1 data-testid="meta-template-index-title">Template Index</h1>
                <p data-testid="meta-template-index-description">
                  This page uses the default title from the template.
                </p>
              </div>
            )),

            // Child route - string title gets template applied
            route("metaTemplate.child", (ctx) => {
              const meta = ctx.use(Meta);
              meta({ title: "Child Page" }); // Should become "Child Page | Test Site"
              meta({ name: "description", content: "Child page description" });

              return (
                <div data-testid="meta-template-child-page">
                  <h1 data-testid="meta-template-child-title">Template Child</h1>
                  <p data-testid="meta-template-child-description">
                    This page title should have template applied.
                  </p>
                </div>
              );
            }),

            // Absolute route - bypasses template
            route("metaTemplate.absolute", (ctx) => {
              const meta = ctx.use(Meta);
              meta({ title: { absolute: "Custom Absolute Title" } }); // No template
              meta({ name: "description", content: "Absolute page description" });

              return (
                <div data-testid="meta-template-absolute-page">
                  <h1 data-testid="meta-template-absolute-title">Absolute Title</h1>
                  <p data-testid="meta-template-absolute-description">
                    This page title bypasses the template.
                  </p>
                </div>
              );
            }),

            // Nested layout with its own template - overrides parent template
            layout(
              (ctx) => {
                const meta = ctx.use(Meta);
                // Override parent template with new one
                meta({ title: { template: "%s | Nested Section", default: "Nested Section" } });

                return (
                  <div data-testid="meta-template-nested-layout">
                    <Outlet />
                  </div>
                );
              },
              () => [
                // Nested index - uses nested default
                route("metaTemplate.nested", () => (
                  <div data-testid="meta-template-nested-page">
                    <h1 data-testid="meta-template-nested-title">Nested Index</h1>
                    <p data-testid="meta-template-nested-description">
                      Uses nested template default.
                    </p>
                  </div>
                )),

                // Nested child - uses nested template
                route("metaTemplate.nestedChild", (ctx) => {
                  const meta = ctx.use(Meta);
                  meta({ title: "Nested Child" }); // Should become "Nested Child | Nested Section"

                  return (
                    <div data-testid="meta-template-nested-child-page">
                      <h1 data-testid="meta-template-nested-child-title">Nested Child</h1>
                      <p data-testid="meta-template-nested-child-description">
                        Uses nested template.
                      </p>
                    </div>
                  );
                }),
              ]
            ),
          ]
        ),

        // =====================================================
        // META UNSET TESTS
        // =====================================================

        // Layout that sets meta to be unset by children
        layout(
          (ctx) => {
            const meta = ctx.use(Meta);
            meta({ title: "Parent Title" });
            meta({ name: "robots", content: "index, follow" });
            meta({ name: "description", content: "Parent description" });
            meta({ property: "og:image", content: "https://example.com/parent.jpg" });

            return (
              <div data-testid="meta-unset-layout">
                <nav data-testid="meta-unset-nav">
                  <Link to="/meta-unset" data-testid="meta-unset-index-link">
                    Unset Index
                  </Link>
                  <Link to="/meta-unset/child" data-testid="meta-unset-child-link">
                    Unset Child
                  </Link>
                  <Link to="/meta-unset/unset-then-set" data-testid="meta-unset-then-set-link">
                    Unset Then Set
                  </Link>
                </nav>
                <Outlet />
              </div>
            );
          },
          () => [
            // Index route - keeps all parent meta
            route("metaUnset.index", () => (
              <div data-testid="meta-unset-index-page">
                <h1 data-testid="meta-unset-index-title">Unset Index</h1>
                <p data-testid="meta-unset-index-description">
                  This page inherits all parent meta.
                </p>
              </div>
            )),

            // Child route - unsets some parent meta
            route("metaUnset.child", (ctx) => {
              const meta = ctx.use(Meta);
              // Unset various meta tags
              meta({ unset: "name:robots" });
              meta({ unset: "property:og:image" });

              return (
                <div data-testid="meta-unset-child-page">
                  <h1 data-testid="meta-unset-child-title">Unset Child</h1>
                  <p data-testid="meta-unset-child-description">
                    This page unsets robots and og:image meta.
                  </p>
                </div>
              );
            }),

            // Route that unsets then sets same meta
            route("metaUnset.unsetThenSet", (ctx) => {
              const meta = ctx.use(Meta);
              // Unset parent description, then set a new one
              meta({ unset: "name:description" });
              meta({ name: "description", content: "New description after unset" });
              // Unset title and set new one
              meta({ unset: "title" });
              meta({ title: "New Title After Unset" });

              return (
                <div data-testid="meta-unset-then-set-page">
                  <h1 data-testid="meta-unset-then-set-title">Unset Then Set</h1>
                  <p data-testid="meta-unset-then-set-description">
                    This page unsets meta then sets new values.
                  </p>
                </div>
              );
            }),
          ]
        ),

        // =====================================================
        // META MERGING TESTS
        // =====================================================

        // Layout for testing meta merging
        layout(
          (ctx) => {
            const meta = ctx.use(Meta);
            meta({ title: "Merge Root" });
            meta({ name: "author", content: "Root Author" });
            meta({ name: "keywords", content: "root, test" });
            meta({ property: "og:site_name", content: "Merge Test Site" });

            return (
              <div data-testid="meta-merge-layout">
                <nav data-testid="meta-merge-nav">
                  <Link to="/meta-merge" data-testid="meta-merge-index-link">
                    Merge Index
                  </Link>
                  <Link to="/meta-merge/child" data-testid="meta-merge-child-link">
                    Merge Child
                  </Link>
                  <Link to="/meta-merge/deep/nested" data-testid="meta-merge-deep-link">
                    Deep Nested
                  </Link>
                </nav>
                <Outlet />
              </div>
            );
          },
          () => [
            // Index - has all root meta
            route("metaMerge.index", () => (
              <div data-testid="meta-merge-index-page">
                <h1 data-testid="meta-merge-index-title">Merge Index</h1>
                <p data-testid="meta-merge-index-description">
                  Inherits all root meta.
                </p>
              </div>
            )),

            // Child - overrides some, adds new
            route("metaMerge.child", (ctx) => {
              const meta = ctx.use(Meta);
              // Override title
              meta({ title: "Merge Child" });
              // Add new description (not set by parent)
              meta({ name: "description", content: "Child description" });
              // Override keywords
              meta({ name: "keywords", content: "child, override" });
              // Keep author and og:site_name from parent (don't set them)

              return (
                <div data-testid="meta-merge-child-page">
                  <h1 data-testid="meta-merge-child-title">Merge Child</h1>
                  <p data-testid="meta-merge-child-description">
                    Overrides title and keywords, adds description, keeps author.
                  </p>
                </div>
              );
            }),

            // Deep nested - multiple levels of overrides
            layout(
              (ctx) => {
                const meta = ctx.use(Meta);
                // Middle layout overrides author
                meta({ name: "author", content: "Middle Author" });

                return (
                  <div data-testid="meta-merge-middle-layout">
                    <Outlet />
                  </div>
                );
              },
              () => [
                route("metaMerge.deep", (ctx) => {
                  const meta = ctx.use(Meta);
                  // Deep page overrides title only
                  meta({ title: "Deep Nested Page" });
                  // Add og:title
                  meta({ property: "og:title", content: "Deep OG Title" });
                  // Middle author should be kept, not root author

                  return (
                    <div data-testid="meta-merge-deep-page">
                      <h1 data-testid="meta-merge-deep-title">Deep Nested</h1>
                      <p data-testid="meta-merge-deep-description">
                        Has root keywords, middle author, own title and og:title.
                      </p>
                    </div>
                  );
                }),
              ]
            ),
          ]
        ),

        // =====================================================
        // FETCH LOADER TEST
        // =====================================================
        // Route for testing useFetchLoader hook (GET-based loader fetching)
        route("fetchLoader", () => (
          <div data-testid="fetch-loader-page">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="fetch-loader-title">useFetchLoader Test</h1>
            <p data-testid="fetch-loader-description">
              Test GET-based loader fetching with useFetchLoader hook
            </p>
            <FetchLoaderTest loader={FetchableTestLoader} />
          </div>
        )),

        // =====================================================
        // useLoader / useFetchLoader HOOK TESTS
        // =====================================================
        // Index route with links to test routes
        route("hookTests.index", () => (
          <div data-testid="hook-tests-index">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="hook-tests-title">useLoader / useFetchLoader Tests</h1>
            <nav data-testid="hook-tests-nav">
              <Link to="/hook-tests/route-a" data-testid="hook-tests-route-a-link">
                Route A (Pre-loaded)
              </Link>
              <br />
              <Link to="/hook-tests/route-b" data-testid="hook-tests-route-b-link">
                Route B (For Navigation)
              </Link>
            </nav>
          </div>
        )),

        // Route A - has HookTestLoader registered via loader()
        route(
          "hookTests.routeA",
          () => (
            <div data-testid="hook-tests-route-a">
              <Link to="/" data-testid="back-link">
                ← Back to Home
              </Link>
              <Link
                to="/hook-tests/route-b"
                data-testid="navigate-to-b-link"
                style={{ marginLeft: "1rem" }}
              >
                Navigate to Route B
              </Link>
              <h1 data-testid="route-a-title">Route A - Pre-loaded Loaders</h1>

              <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
                <UseLoaderTest loader={HookTestLoader} />
                <UseFetchLoaderPreloadedTest loader={HookTestLoader} />
                <UseFetchLoaderUnregisteredTest loader={UnregisteredLoader} />
              </div>

              <hr style={{ margin: "2rem 0" }} />
              <h2 data-testid="error-tests-title">Error Handling Tests</h2>
              <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
                <ErrorLoaderTest loader={ErrorLoader} />
                <UnhandledErrorLoaderTest loader={ErrorLoader} />
              </div>

              <hr style={{ margin: "2rem 0" }} />
              <h2 data-testid="middleware-tests-title">Middleware / Security Tests</h2>
              <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
                <ProtectedLoaderTest loader={ProtectedLoader} />
              </div>
            </div>
          ),
          () => [loader(HookTestLoader)]
        ),

        // Route B - has HookTestLoaderB registered via loader()
        route(
          "hookTests.routeB",
          () => (
            <div data-testid="hook-tests-route-b">
              <Link to="/" data-testid="back-link">
                ← Back to Home
              </Link>
              <Link
                to="/hook-tests/route-a"
                data-testid="navigate-to-a-link"
                style={{ marginLeft: "1rem" }}
              >
                Navigate to Route A
              </Link>
              <h1 data-testid="route-b-title">Route B - Navigation Target</h1>

              <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
                <UseLoaderTestB loader={HookTestLoaderB} />
                <UseFetchLoaderTestB loader={HookTestLoaderB} />
              </div>
            </div>
          ),
          () => [loader(HookTestLoaderB)]
        ),

        // Route WITHOUT loader registered - for testing useLoader throws
        route("hookTests.noLoader", () => (
          <div data-testid="hook-tests-no-loader">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="no-loader-title">No Loader Route</h1>
            <p>This route does NOT have HookTestLoader registered via loader()</p>

            <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
              <UseLoaderThrowsTest loader={HookTestLoader} />
            </div>
          </div>
        )),

        // Route for testing form action and isLoading state
        route("hookTests.formAction", () => (
          <div data-testid="hook-tests-form-action">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="form-action-title">Form Action Test Route</h1>

            <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
              <IsLoadingTest loader={UnregisteredLoader} />
              <FormActionTest loader={UnregisteredLoader} />
              <FormActionProgressiveTest loader={UnregisteredLoader} />
            </div>
          </div>
        )),
      ]
    ),

    // Route for testing inline actions (defined directly in RSC, not imported from "use server" module)
    // This tests that actions without a hash-to-file mapping still work correctly
    route("inlineAction", () => {
      // Inline action defined directly in the RSC component
      async function inlineTestAction(formData: FormData) {
        "use server";
        const value = formData.get("testValue") as string;
        return {
          success: true,
          receivedValue: value,
          timestamp: new Date().toISOString(),
        };
      }

      return (
        <div data-testid="inline-action-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="inline-action-title">Inline Action Test</h1>
          <p data-testid="inline-action-description">
            Tests an action defined directly in the RSC (not imported from a "use server" module).
          </p>
          <form action={inlineTestAction} data-testid="inline-action-form">
            <input
              type="text"
              name="testValue"
              defaultValue="test-inline"
              data-testid="inline-action-input"
            />
            <button type="submit" data-testid="inline-action-submit">
              Submit Inline Action
            </button>
          </form>
        </div>
      );
    }),

    // Route for testing ctx.use(loader) composition
    // Tests all combinations: fetchable/non-fetchable loaders using fetchable/non-fetchable dependencies
    // Also tests memoization - base loaders should only be invoked once per request
    route(
      "loaderComposition",
      async (ctx) => {
        // Load all four composition scenarios
        // Note: Two loaders use BaseNonFetchableLoader, two use BaseFetchableLoader
        // If memoization works, each base loader should only be invoked once
        const nfUsesNf = await ctx.use(ComposingNonFetchableUsesNonFetchable);
        const nfUsesF = await ctx.use(ComposingNonFetchableUsesFetchable);
        const fUsesF = await ctx.use(ComposingFetchableUsesFetchable);
        const fUsesNf = await ctx.use(ComposingFetchableUsesNonFetchable);

        return (
          <div data-testid="loader-composition-page">
            <Link to="/" data-testid="back-link">
              ← Back to Home
            </Link>
            <h1 data-testid="page-title">Loader Composition Test</h1>

            <div data-testid="nf-uses-nf" data-composer={nfUsesNf.composerType} data-dependency={nfUsesNf.dependencyType}>
              <h2>Non-Fetchable uses Non-Fetchable</h2>
              <p data-testid="nf-uses-nf-base">Base value: {nfUsesNf.baseValue}</p>
              <p data-testid="nf-uses-nf-computed">Computed: {nfUsesNf.computed}</p>
              <p data-testid="nf-uses-nf-invocations">Invocations: {nfUsesNf.baseInvocationCount}</p>
            </div>

            <div data-testid="nf-uses-f" data-composer={nfUsesF.composerType} data-dependency={nfUsesF.dependencyType}>
              <h2>Non-Fetchable uses Fetchable</h2>
              <p data-testid="nf-uses-f-base">Base value: {nfUsesF.baseValue}</p>
              <p data-testid="nf-uses-f-computed">Computed: {nfUsesF.computed}</p>
              <p data-testid="nf-uses-f-invocations">Invocations: {nfUsesF.baseInvocationCount}</p>
            </div>

            <div data-testid="f-uses-f" data-composer={fUsesF.composerType} data-dependency={fUsesF.dependencyType}>
              <h2>Fetchable uses Fetchable</h2>
              <p data-testid="f-uses-f-base">Base value: {fUsesF.baseValue}</p>
              <p data-testid="f-uses-f-computed">Computed: {fUsesF.computed}</p>
              <p data-testid="f-uses-f-invocations">Invocations: {fUsesF.baseInvocationCount}</p>
            </div>

            <div data-testid="f-uses-nf" data-composer={fUsesNf.composerType} data-dependency={fUsesNf.dependencyType}>
              <h2>Fetchable uses Non-Fetchable</h2>
              <p data-testid="f-uses-nf-base">Base value: {fUsesNf.baseValue}</p>
              <p data-testid="f-uses-nf-computed">Computed: {fUsesNf.computed}</p>
              <p data-testid="f-uses-nf-invocations">Invocations: {fUsesNf.baseInvocationCount}</p>
            </div>
          </div>
        );
      }
    ),

    // Route for testing progressive enhancement (no-JS form submissions)
    // When JS is disabled, form submissions should return full HTML, not RSC stream
    route("progressiveEnhancement", async (ctx) => {
      // Import the action dynamically to get the server function
      const { submitNameAction, getLastSubmittedName } = await import("./actions.js");
      const lastSubmitted = await getLastSubmittedName();

      return (
        <div data-testid="progressive-enhancement-page">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="page-title">Progressive Enhancement Test</h1>
          <p data-testid="page-description">
            This form should work without JavaScript enabled.
          </p>

          <form action={submitNameAction} method="post" data-testid="pe-form">
            <label htmlFor="name">Name:</label>
            <input
              type="text"
              id="name"
              name="name"
              defaultValue="test-name"
              data-testid="pe-input"
            />
            <button type="submit" data-testid="pe-submit">
              Submit
            </button>
          </form>

          {lastSubmitted && (
            <div data-testid="pe-result">
              <p>Last submitted name: <span data-testid="pe-result-name">{lastSubmitted}</span></p>
            </div>
          )}
        </div>
      );
    }),
  ]
);
