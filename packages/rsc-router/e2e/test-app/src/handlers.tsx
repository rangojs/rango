import { map } from "rsc-router/server";
import { Outlet } from "rsc-router/client";
import { Link } from "rsc-router/browser";
import type { testRoutes } from "./routes.js";
import { ProductsLoader, ProductDetailLoader, CartQuantityLoader } from "./loaders.js";
import { AddToCartButton } from "./components/AddToCartButton.js";
import { QuantityControl } from "./components/QuantityControl.js";
import { StreamingActionButton, ActionStatus } from "./components/StreamingActionButton.js";
import { Modal } from "./components/Modal.js";

export default map<typeof testRoutes>(
  ({ route, layout, intercept, loader }) => [
    // Root layout with HTML structure
    layout(
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>RSC Router Test App</title>
        </head>
        <body>
          <div data-testid="app-root">
            <nav data-testid="nav">
              <Link to="/" data-testid="nav-home">Home</Link>
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
        route("index", async (ctx) => {
          const { products, loadedAt } = await ctx.use(ProductsLoader);
          return (
            <div data-testid="index-page">
              <h1 data-testid="page-title">Products</h1>
              <p data-testid="loaded-at">Loaded: {loadedAt}</p>
              <div data-testid="product-list">
                {products.map((product) => (
                  <div key={product.id} data-testid={`product-card-${product.id}`}>
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
            </div>
          );
        }, () => [
          loader(ProductsLoader),
        ]),

        // Product detail route (direct navigation)
        route("product.detail", async (ctx) => {
          const { product, loadedAt } = await ctx.use(ProductDetailLoader);
          const { quantity } = await ctx.use(CartQuantityLoader);
          return (
            <div data-testid="product-detail-page">
              <Link to="/" data-testid="back-link">← Back to Products</Link>
              <h1 data-testid="product-name">{product.name}</h1>
              <p data-testid="product-price">${product.price}</p>
              <p data-testid="product-description">{product.description}</p>
              <p data-testid="product-loaded-at">Loaded: {loadedAt}</p>
              <div data-testid="actions-section">
                <h2>Actions</h2>
                <div data-testid="add-to-cart-section">
                  <h3>1. Add to Cart (with result)</h3>
                  <AddToCartButton productId={product.id} testId="add-to-cart-btn" />
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
                  <ActionStatus testId="action-status" />
                  <StreamingActionButton productId={product.id} testId="streaming-btn" />
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
        }, () => [
          loader(ProductDetailLoader),
          loader(CartQuantityLoader),
        ]),

        // Intercept for modal (soft navigation)
        intercept("@modal", "product.detail", async (ctx) => {
          const { product } = await ctx.use(ProductDetailLoader);
          const { quantity } = await ctx.use(CartQuantityLoader);
          return (
            <Modal testId="product-modal">
              <div data-testid="modal-header">
                <span data-testid="intercept-indicator">Intercepted</span>
                <h2 data-testid="modal-product-name">{product.name}</h2>
              </div>
              <p data-testid="modal-product-price">${product.price}</p>
              <p data-testid="modal-product-description">{product.description}</p>
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
        }, () => [
          loader(ProductDetailLoader),
          loader(CartQuantityLoader),
        ]),
      ]
    ),
  ]
);
