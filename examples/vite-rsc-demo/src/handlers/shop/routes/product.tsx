import type { RouteHandler } from "rsc-router/server";
import type { shopRoutes } from "@/routes.js";
import { products } from "@/handlers/shop/data.js";
import { SegmentTimer } from "@/components/SegmentTimer.js";
import { CurrentURL } from "@/components/CurrentURL.js";
import { AddToCartForm } from "@/components/AddToCartForm.js";
import { StreamingActionForm } from "@/components/StreamingActionForm.js";
import { DebugSegmentWrapper } from "@/components/DebugSegmentWrapper.js";
import { OutletProvider, ParallelOutlet } from "rsc-router/client";
import {
  addToCart,
  addToCartWithResult,
  getCartCount,
} from "@/handlers/shop/actions/shop.actions.js";
import { addToCartSlowly } from "@/actions/streaming.actions.js";
import {
  PDPNavbar,
  ProductCard,
  ProductCardSimple,
} from "@/handlers/shop/components.js";
import { ProductLoader, CartLoader } from "@/handlers/shop/loaders/index.js";
import { FeaturedProducts } from "@/components/FeaturedProducts.js";
import { LoadingSpinner } from "../components/loading";

// ==================== PRODUCT ROUTES ====================

export const IndexRoute: RouteHandler<typeof shopRoutes, "index"> = () => (
  <DebugSegmentWrapper type="route" name="Shop Index">
    <div style={{ display: "flex", gap: "2rem" }}>
      {/* Category sidebar - parallel route */}
      <ParallelOutlet name="@sidebar" />
      <div style={{ flex: 1 }}>
        <h2>All Products</h2>
        <p className="segment-id">Segment: Shop Index</p>

        {/* RSC Streaming Demo - Promise<ReactNode> streams via RSC, resolved on client */}
        <FeaturedProducts />

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(2, 1fr)",
            gap: "1rem",
            marginTop: "2rem",
          }}
        >
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      </div>
    </div>
  </DebugSegmentWrapper>
);

export const ProductsCategoryRoute: RouteHandler<
  typeof shopRoutes,
  "products.category"
> = (ctx) => {
  const categoryProducts = products.filter(
    (p) => p.category === ctx.params.category
  );

  return (
    <DebugSegmentWrapper type="route" name="Products Category">
      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 1 }}>
          <h2>Category: {ctx.params.category}</h2>
          <p className="segment-id">Segment: Products Category</p>
          <p>
            Showing {categoryProducts.length} products in {ctx.params.category}
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(2, 1fr)",
              gap: "1rem",
            }}
          >
            <LoadingSpinner />

            {categoryProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
};

export const ProductsDetailRoute: RouteHandler<
  typeof shopRoutes,
  "products.detail.view"
> = async (ctx) => {
  // Use the ProductLoader to get product data
  // ctx.use() returns a Promise since loaders run in parallel
  const product = await ctx.use(ProductLoader);
  console.log("ProductsDetailRoute product", product);

  // Also get cart data from the global CartLoader
  const cart = await ctx.use(CartLoader);
  const cartCount = cart.itemCount;

  const renderTime = new Date().toISOString();
  const queryParams: [string, string][] = Array.from(
    ctx.searchParams.entries()
  );

  return (
    <DebugSegmentWrapper type="route" name="Product Detail">
      <div style={{ display: "flex", gap: "2rem" }}>
        <div style={{ flex: 1 }}>
          <PDPNavbar cartCount={cartCount} {...product} />

          <div style={{ marginTop: "1rem" }}>
            <h2>{product.name}</h2>
            <p>${product.price}</p>
            <p>{product.description}</p>
            <LoadingSpinner />
            <div style={{ marginTop: "1rem" }}>
              <h3>Add to Cart - Tests multiple server action patterns</h3>

              <div
                style={{
                  display: "grid",
                  gap: "1rem",
                  gridTemplateColumns: "repeat(2, 1fr)",
                  marginTop: "1rem",
                }}
              >
                {/* Basic Action - Fire and forget */}
                <div style={{ padding: "1rem", border: "1px solid #ddd" }}>
                  <h4>1. Fire & Forget</h4>
                  <p style={{ fontSize: "0.9rem", color: "#666" }}>
                    No return value tracking
                  </p>
                  <AddToCartForm
                    productId={product.id}
                    action={addToCart}
                    buttonText="Add to Cart (Fire & Forget)"
                  />
                </div>

                {/* Action with Return Value */}
                <div style={{ padding: "1rem", border: "1px solid #ddd" }}>
                  <h4>2. With Return Value</h4>
                  <p style={{ fontSize: "0.9rem", color: "#666" }}>
                    Shows action result
                  </p>
                  <AddToCartForm
                    productId={product.id}
                    action={addToCartWithResult}
                    buttonText="Add to Cart (With Result)"
                    showResult
                  />
                </div>

                {/* Progressive Enhancement */}
                <div style={{ padding: "1rem", border: "1px solid #ddd" }}>
                  <h4>3. Progressive Enhancement</h4>
                  <p style={{ fontSize: "0.9rem", color: "#666" }}>
                    Works without JS (POST form)
                  </p>
                  <AddToCartForm
                    productId={product.id}
                    action={addToCart}
                    buttonText="Add to Cart (No JS)"
                    progressive
                  />
                </div>

                {/* Streaming Action */}
                <div style={{ padding: "1rem", border: "1px solid #ddd" }}>
                  <h4>4. Streaming Updates</h4>
                  <p style={{ fontSize: "0.9rem", color: "#666" }}>
                    Real-time progress (3s delay)
                  </p>
                  <LoadingSpinner />
                  <StreamingActionForm
                    productId={product.id}
                    action={addToCartSlowly}
                  >
                    Add product (Streaming)
                  </StreamingActionForm>
                </div>
              </div>
            </div>

            <div
              style={{
                marginTop: "2rem",
                padding: "1rem",
                background: "#f5f5f5",
                borderRadius: "4px",
              }}
            >
              <h4>Segment Metadata</h4>
              <ul>
                <li>
                  <strong>Route:</strong> /shop/product/{ctx.params.slug}
                </li>
                <li>
                  <strong>Product ID:</strong> {product.id}
                </li>
                <li>
                  <strong>Rendered:</strong> {renderTime}
                </li>
                {queryParams.length > 0 && (
                  <li>
                    <strong>Query Params:</strong>{" "}
                    {queryParams
                      .map(([key, value]) => `${key}=${value}`)
                      .join(", ")}
                  </li>
                )}
              </ul>
              <SegmentTimer />
            </div>

            <CurrentURL />
          </div>

          {/* Related products - parallel route */}
          <div style={{ marginTop: "2rem" }}>
            <ParallelOutlet name="@related" />
          </div>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
};
