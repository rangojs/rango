import { map } from "rsc-router/server";
import { Outlet, Link } from "rsc-router/client";
import type { testRoutes } from "./routes.js";
import {
  ProductsLoader,
  ProductDetailLoader,
  CartQuantityLoader,
  SlowLoader,
} from "./loaders.js";
import { AddToCartButton } from "./components/AddToCartButton.js";
import { QuantityControl } from "./components/QuantityControl.js";
import {
  StreamingActionButton,
  ActionStatus,
  StreamingActionStatus,
} from "./components/StreamingActionButton.js";
import { Modal } from "./components/Modal.js";
import { RevalidateButton } from "./components/RevalidateButton.js";

export default map<typeof testRoutes>(
  ({ route, layout, intercept, loader, loading }) => [
    // Root layout with HTML structure
    layout(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>RSC Router Test App</title>
        </head>
        <body>
          <div data-testid="app-root">
            <nav data-testid="nav">
              <Link to="/" data-testid="nav-home">
                Home
              </Link>
            </nav>
            <main data-testid="main-content">
              <Outlet />
            </main>
            <Outlet name="@modal" />
          </div>
        </body>
      </html>,
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
            const { product, loadedAt } = await ctx.use(ProductDetailLoader);
            const { quantity } = await ctx.use(CartQuantityLoader);
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
        route("blog.index", () => (
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
        )),

        route("blog.post", (ctx) => (
          <div data-testid="blog-post-page">
            <Link to="/blog" data-testid="back-to-blog">
              ← Back to Blog
            </Link>
            <h1 data-testid="blog-post-title">Post: {ctx.params.postId}</h1>
            <p data-testid="blog-post-content">
              Content for post {ctx.params.postId}
            </p>
          </div>
        )),
      ]
    ),
  ]
);
