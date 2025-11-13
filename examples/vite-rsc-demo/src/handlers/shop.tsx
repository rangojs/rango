import { map, layout, parallel, revalidate, middleware } from "rsc-router";
import type { shopRoutes } from "../routes.js";
import { RootLayout } from "../layouts/RootLayout.js";
import { ShopLayout } from "../layouts/ShopLayout.js";
import { CheckoutLayout } from "../layouts/CheckoutLayout.js";
import { AccountLayout } from "../layouts/AccountLayout.js";
import { SegmentTimer } from "../components/SegmentTimer.js";
import { CurrentURL } from "../components/CurrentURL.js";

// Mock product data
const products = [
  { id: 1, slug: "wireless-headphones", name: "Wireless Headphones", category: "electronics", price: 99.99 },
  { id: 2, slug: "running-shoes", name: "Running Shoes", category: "sports", price: 79.99 },
  { id: 3, slug: "coffee-maker", name: "Coffee Maker", category: "home", price: 149.99 },
  { id: 4, slug: "laptop-stand", name: "Laptop Stand", category: "electronics", price: 49.99 },
  { id: 5, slug: "yoga-mat", name: "Yoga Mat", category: "sports", price: 29.99 },
  { id: 6, slug: "desk-lamp", name: "Desk Lamp", category: "home", price: 39.99 },
];

const categories = ["electronics", "sports", "home"];

const orders = [
  { id: "ORD-001", date: "2024-01-15", total: 249.97, status: "Delivered" },
  { id: "ORD-002", date: "2024-01-20", total: 79.99, status: "Shipped" },
  { id: "ORD-003", date: "2024-01-25", total: 149.99, status: "Processing" },
];

/**
 * Shop handlers - comprehensive ecommerce example
 * Tests all routing features: nested routes, dynamic segments, layout composition, parallel routes
 *
 * NOTE: TypeScript errors on nested route keys (products.category, etc) are a known limitation.
 * RouteKeys<T> type utility needs improvement to handle flattened nested routes.
 * Works correctly at runtime.
 */
export default map<typeof shopRoutes>({
  // ===================
  // LAYOUTS
  // ===================

  // Global RootLayout applies to all routes
  [layout("*", "root")]: <RootLayout />,

  // ShopLayout applies to all shop routes
  [layout("*", "shop")]: <ShopLayout />,

  // CheckoutLayout applies to checkout routes (demonstrates layout composition)
  [layout("checkout.index", "checkout")]: <CheckoutLayout />,
  [layout("checkout.payment", "checkout")]: <CheckoutLayout />,
  [layout("checkout.confirm", "checkout")]: <CheckoutLayout />,

  // AccountLayout applies to all account routes (nested route group)
  [layout("account.index", "account")]: <AccountLayout />,
  [layout("account.orders", "account")]: <AccountLayout />,
  [layout("account.orderDetail", "account")]: <AccountLayout />,

  // ===================
  // MIDDLEWARE
  // ===================

  // Global middleware - runs for ALL shop routes
  // Demonstrates logging and context modification
  [middleware("*", "logger")]: [
    (ctx: any, next) => {
      console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
      next();
    },
  ],

  [middleware("*", "mockAuth")]: [
    (ctx: any, next) => {
      // Simulate authentication - add mock user to context
      console.log("[Shop Middleware] Auth: Adding mock user to context");
      (ctx as any).user = {
        id: "user-123",
        name: "John Doe",
        email: "john@example.com",
      };
      next();
    },
  ],

  // Checkout routes - require auth check
  [middleware("checkout.index", "requireAuth")]: [
    (ctx: any, next) => {
      console.log("[Shop Middleware] Checkout auth check");
      if (!(ctx as any).user) {
        console.error("[Shop Middleware] No user - would redirect to login");
        // In real app: throw new Error('Unauthorized') or redirect
      }
      next();
    },
  ],

  [middleware("checkout.payment", "requireAuth")]: [
    (ctx: any, next) => {
      console.log("[Shop Middleware] Payment auth check");
      if (!(ctx as any).user) {
        console.error("[Shop Middleware] No user - would redirect to login");
      }
      next();
    },
  ],

  // Account routes - check permissions
  [middleware("account.orders", "permissions")]: [
    (ctx: any, next) => {
      console.log("[Shop Middleware] Checking order view permissions");
      const user = (ctx as any).user;
      if (user) {
        console.log(`[Shop Middleware] User ${user.name} can view orders`);
      }
      next();
    },
  ],

  // ===================
  // REVALIDATION
  // ===================

  // Global revalidation - applies to ALL shop routes
  // Demonstrates how to add custom logic that affects every route
  [revalidate("*", "global")]: ({ defaultShouldRevalidate }) => {
    console.log("[Shop] Global revalidation check - defaultShouldRevalidate:", defaultShouldRevalidate);
    // Defer to default behavior (params changed)
    return defaultShouldRevalidate;
  },

  // Product detail - multiple named revalidations with short-circuit
  // First one that returns true wins
  // IMPORTANT: Demonstrates route params vs query string difference
  [revalidate("products.detail", "demo")]: ({ currentParams, nextParams, currentUrl, nextUrl, defaultShouldRevalidate }) => {
    console.log("[Shop] Product detail revalidation demo:");
    console.log("  - Current slug:", currentParams.slug);
    console.log("  - Next slug:", nextParams.slug);
    console.log("  - Current query:", currentUrl.search);
    console.log("  - Next query:", nextUrl.search);
    console.log("  - defaultShouldRevalidate:", defaultShouldRevalidate);
    console.log("  ⮑ defaultShouldRevalidate is TRUE only when ROUTE PARAMS change (slug)");
    console.log("  ⮑ Query string changes (?tab=1) do NOT affect defaultShouldRevalidate");

    // Defer to default: true if slug changed, false if only query changed
    return defaultShouldRevalidate;
  },

  // Cart - always revalidate (fresh data)
  [revalidate("cart")]: () => {
    console.log("[Shop] Cart always revalidates (fresh data)");
    return true; // Always refresh cart
  },

  // Checkout confirmation - never revalidate (static once rendered)
  [revalidate("checkout.confirm")]: () => {
    console.log("[Shop] Checkout confirmation never revalidates");
    return false; // Static confirmation page
  },

  // Account order detail - only revalidate if order ID changed
  [revalidate("account.orderDetail")]: ({ currentParams, nextParams, defaultShouldRevalidate }) => {
    console.log(`[Shop] Order detail: ${currentParams.id} → ${nextParams.id}`);
    return defaultShouldRevalidate; // Revalidate when ID changes
  },

  // ===================
  // PARALLEL ROUTES
  // ===================

  // Sidebar on product listing (category filters)
  [parallel("index", "sidebar")]: {
    "@sidebar": () => (
      <div style={{
        background: "#f8f9fa",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "200px",
      }}>
        <p className="segment-id">Segment: @sidebar</p>
        <h3 style={{ marginTop: 0 }}>Categories</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {categories.map((cat) => (
            <li key={cat} style={{ marginBottom: "0.5rem" }}>
              <a href={`/shop/products/${cat}`} style={{ textTransform: "capitalize" }}>
                {cat}
              </a>
            </li>
          ))}
        </ul>
      </div>
    ),
  },

  // Related products on product detail page
  [parallel("products.detail", "related")]: {
    "@related": (ctx) => {
      const currentProduct = products.find((p) => p.slug === ctx.params.slug);
      const relatedProducts = currentProduct
        ? products.filter((p) => p.category === currentProduct.category && p.slug !== ctx.params.slug).slice(0, 2)
        : [];

      return (
        <div style={{
          background: "#fff3cd",
          padding: "1.5rem",
          borderRadius: "8px",
          marginTop: "2rem",
        }}>
          <p className="segment-id">Segment: @related</p>
          <h3 style={{ marginTop: 0 }}>Related Products</h3>
          {relatedProducts.length > 0 ? (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {relatedProducts.map((p) => (
                <li key={p.id} style={{ marginBottom: "0.5rem" }}>
                  <a href={`/shop/product/${p.slug}`}>{p.name}</a>
                  <span style={{ color: "#666", marginLeft: "0.5rem" }}>${p.price}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p>No related products found.</p>
          )}
        </div>
      );
    },
  },

  // Order summary on cart and checkout pages
  [parallel("cart", "summary")]: {
    "@summary": () => (
      <div style={{
        background: "#e8f4f8",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "250px",
      }}>
        <p className="segment-id">Segment: @summary</p>
        <h3 style={{ marginTop: 0 }}>Order Summary</h3>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Subtotal:</span>
            <span>$149.99</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Shipping:</span>
            <span>$10.00</span>
          </div>
          <hr style={{ margin: "0.5rem 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
            <span>Total:</span>
            <span>$159.99</span>
          </div>
        </div>
      </div>
    ),
  },

  [parallel("checkout.index", "summary")]: {
    "@summary": () => (
      <div style={{
        background: "#e8f4f8",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "250px",
      }}>
        <p className="segment-id">Segment: @summary (checkout)</p>
        <h3 style={{ marginTop: 0 }}>Order Summary</h3>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Subtotal:</span>
            <span>$149.99</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Shipping:</span>
            <span>$10.00</span>
          </div>
          <hr style={{ margin: "0.5rem 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
            <span>Total:</span>
            <span>$159.99</span>
          </div>
        </div>
      </div>
    ),
  },

  [parallel("checkout.payment", "summary")]: {
    "@summary": () => (
      <div style={{
        background: "#e8f4f8",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "250px",
      }}>
        <p className="segment-id">Segment: @summary (payment)</p>
        <h3 style={{ marginTop: 0 }}>Order Summary</h3>
        <div style={{ marginBottom: "1rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Subtotal:</span>
            <span>$149.99</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
            <span>Shipping:</span>
            <span>$10.00</span>
          </div>
          <hr style={{ margin: "0.5rem 0" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
            <span>Total:</span>
            <span>$159.99</span>
          </div>
        </div>
      </div>
    ),
  },

  // Recent orders widget on account dashboard
  [parallel("account.index", "orders")]: {
    "@orders": () => (
      <div style={{
        background: "#d1f2eb",
        padding: "1.5rem",
        borderRadius: "8px",
        marginTop: "2rem",
      }}>
        <p className="segment-id">Segment: @orders</p>
        <h3 style={{ marginTop: 0 }}>Recent Orders</h3>
        <ul style={{ listStyle: "none", padding: 0 }}>
          {orders.slice(0, 2).map((order) => (
            <li key={order.id} style={{ marginBottom: "0.5rem" }}>
              <a href={`/shop/account/orders/${order.id}`}>{order.id}</a>
              <span style={{ color: "#666", marginLeft: "0.5rem" }}>${order.total}</span>
            </li>
          ))}
        </ul>
      </div>
    ),
  },

  // ===================
  // ROUTE HANDLERS
  // ===================

  // Shop homepage - product listing
  index: () => (
    <div style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2>All Products</h2>
        <p className="segment-id">Segment: Shop Index</p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "1rem",
          marginTop: "1rem",
        }}>
          {products.map((product) => (
            <a
              key={product.id}
              href={`/shop/product/${product.slug}`}
              style={{
                display: "block",
                background: "#fff",
                border: "1px solid #e9ecef",
                borderRadius: "8px",
                padding: "1rem",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>{product.name}</h3>
              <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.85rem", color: "#6c757d", textTransform: "capitalize" }}>
                {product.category}
              </p>
              <p style={{ margin: 0, fontWeight: "bold", color: "#667eea" }}>${product.price}</p>
            </a>
          ))}
        </div>
      </div>
    </div>
  ),

  // Category browsing - demonstrates dynamic segment
  "products.category": (ctx: any) => {
    const categoryProducts = products.filter((p) => p.category === ctx.params.category);

    return (
      <div>
        <h2 style={{ textTransform: "capitalize" }}>{ctx.params.category}</h2>
        <p className="segment-id">Segment: Category ({ctx.params.category})</p>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          <a href="/shop">← Back to all products</a>
        </p>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "1rem",
        }}>
          {categoryProducts.map((product) => (
            <a
              key={product.id}
              href={`/shop/product/${product.slug}`}
              style={{
                display: "block",
                background: "#fff",
                border: "1px solid #e9ecef",
                borderRadius: "8px",
                padding: "1rem",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>{product.name}</h3>
              <p style={{ margin: 0, fontWeight: "bold", color: "#667eea" }}>${product.price}</p>
            </a>
          ))}
        </div>
      </div>
    );
  },

  // Product detail - demonstrates dynamic segment + parallel routes
  "products.detail": (ctx: any) => {
    const product = products.find((p) => p.slug === ctx.params.slug);
    const renderTime = new Date().toISOString();
    const queryParams: [string, string][] = Array.from(ctx.searchParams.entries());

    if (!product) {
      return (
        <div>
          <h2>Product Not Found</h2>
          <p><a href="/shop">← Back to shop</a></p>
        </div>
      );
    }

    return (
      <div>
        <h2>{product.name}</h2>
        <p className="segment-id">Segment: Product Detail ({product.slug})</p>
        <p>
          <strong>Slug (route param):</strong> <code>{product.slug}</code>
        </p>

        <CurrentURL />

        <div style={{
          background: '#fff3cd',
          padding: '0.75rem',
          borderRadius: '4px',
          marginTop: '0.5rem',
          border: '2px solid #856404',
        }}>
          <div style={{ marginBottom: '0.25rem', fontSize: '0.85rem', fontWeight: 'bold', color: '#856404' }}>
            📸 Server Snapshot (at render time)
          </div>
          <div style={{ fontSize: '0.8rem' }}>
            <strong>Query Params:</strong>{' '}
            {queryParams.length > 0 ? (
              <code>{queryParams.map(([k, v]) => `${k}=${v}`).join('&')}</code>
            ) : (
              <em style={{ color: '#666' }}>none</em>
            )}
          </div>
          <p style={{ fontSize: '0.7rem', color: '#856404', marginTop: '0.5rem', marginBottom: 0, fontStyle: 'italic' }}>
            ↑ Frozen from <code>ctx.searchParams</code>. Won't update if segment not revalidated!
          </p>
        </div>

        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "2rem",
          marginTop: "1rem",
        }}>
          <p style={{ fontSize: "0.85rem", color: "#6c757d", textTransform: "capitalize", marginBottom: "1rem" }}>
            Category: <a href={`/shop/products/${product.category}`}>{product.category}</a>
          </p>
          <p style={{ fontSize: "2rem", fontWeight: "bold", color: "#667eea", marginBottom: "1rem" }}>
            ${product.price}
          </p>
          <p style={{ marginBottom: "1rem" }}>
            This is a great {product.name.toLowerCase()} perfect for your needs.
          </p>
          <button style={{
            background: "#667eea",
            color: "white",
            border: "none",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            fontSize: "1rem",
            cursor: "pointer",
          }}>
            Add to Cart
          </button>
        </div>

        <SegmentTimer
          segmentId={`Product Detail (${product.slug})`}
          serverRenderTime={renderTime}
        />

        <div style={{ marginTop: '1rem', padding: '1rem', background: '#fff3cd', borderRadius: '4px' }}>
          <h4 style={{ marginTop: 0 }}>🧪 Test Revalidation Behavior:</h4>
          <ul style={{ margin: 0, paddingLeft: '1.5rem', fontSize: '0.9rem' }}>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href="/shop/product/wireless-headphones">Wireless Headphones</a> → <strong>Slug changes = Timer resets</strong>
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href="/shop/product/running-shoes">Running Shoes</a> → <strong>Slug changes = Timer resets</strong>
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href={`/shop/product/${product.slug}?tab=details`}>Add ?tab=details</a> → <strong>Query only = Timer keeps running</strong>
            </li>
            <li style={{ marginBottom: '0.5rem' }}>
              <a href={`/shop/product/${product.slug}?tab=reviews`}>Change to ?tab=reviews</a> → <strong>Query change = Timer keeps running</strong>
            </li>
          </ul>
          <p style={{ fontSize: '0.8rem', color: '#856404', marginTop: '0.75rem', marginBottom: 0 }}>
            <strong>Watch the timer and console logs!</strong> defaultShouldRevalidate is TRUE only when <code>:slug</code> changes.
          </p>
        </div>

        <p style={{ marginTop: "1rem", color: "#666" }}>
          <a href="/shop">← Back to shop</a>
        </p>
      </div>
    );
  },

  // Shopping cart
  cart: () => (
    <div style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2>Shopping Cart</h2>
        <p className="segment-id">Segment: Cart</p>
        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "1.5rem",
          marginTop: "1rem",
        }}>
          <div style={{ marginBottom: "1rem", paddingBottom: "1rem", borderBottom: "1px solid #e9ecef" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: "0 0 0.5rem 0" }}>Coffee Maker</h3>
                <p style={{ margin: 0, color: "#6c757d" }}>Quantity: 1</p>
              </div>
              <p style={{ margin: 0, fontWeight: "bold" }}>$149.99</p>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "1rem" }}>
            <a href="/shop" style={{ color: "#0066cc" }}>← Continue Shopping</a>
            <a href="/shop/checkout" style={{
              background: "#667eea",
              color: "white",
              padding: "0.75rem 1.5rem",
              borderRadius: "4px",
              textDecoration: "none",
            }}>
              Proceed to Checkout →
            </a>
          </div>
        </div>
      </div>
    </div>
  ),

  // Checkout - step 1 (demonstrates nested routes with layout)
  "checkout.index": () => (
    <div style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2>Checkout</h2>
        <p className="segment-id">Segment: Checkout Index</p>
        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "1.5rem",
          marginTop: "1rem",
        }}>
          <h3>Shipping Information</h3>
          <form style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <input type="text" placeholder="Full Name" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6" }} />
            <input type="text" placeholder="Address" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6" }} />
            <input type="text" placeholder="City" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6" }} />
            <div style={{ display: "flex", gap: "1rem" }}>
              <input type="text" placeholder="State" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6", flex: 1 }} />
              <input type="text" placeholder="ZIP" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6", flex: 1 }} />
            </div>
            <a href="/shop/checkout/payment" style={{
              background: "#667eea",
              color: "white",
              padding: "0.75rem",
              borderRadius: "4px",
              textDecoration: "none",
              textAlign: "center",
            }}>
              Continue to Payment →
            </a>
          </form>
        </div>
      </div>
    </div>
  ),

  // Checkout - step 2 payment (demonstrates multi-step flow)
  "checkout.payment": () => (
    <div style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2>Payment</h2>
        <p className="segment-id">Segment: Checkout Payment</p>
        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "1.5rem",
          marginTop: "1rem",
        }}>
          <h3>Payment Information</h3>
          <form style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <input type="text" placeholder="Card Number" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6" }} />
            <div style={{ display: "flex", gap: "1rem" }}>
              <input type="text" placeholder="MM/YY" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6", flex: 1 }} />
              <input type="text" placeholder="CVV" style={{ padding: "0.5rem", borderRadius: "4px", border: "1px solid #dee2e6", flex: 1 }} />
            </div>
            <div style={{ display: "flex", gap: "1rem" }}>
              <a href="/shop/checkout" style={{
                color: "#6c757d",
                padding: "0.75rem",
                textDecoration: "none",
                textAlign: "center",
              }}>
                ← Back
              </a>
              <a href="/shop/checkout/confirm" style={{
                background: "#667eea",
                color: "white",
                padding: "0.75rem",
                borderRadius: "4px",
                textDecoration: "none",
                textAlign: "center",
                flex: 1,
              }}>
                Place Order →
              </a>
            </div>
          </form>
        </div>
      </div>
    </div>
  ),

  // Checkout - confirmation
  "checkout.confirm": () => (
    <div>
      <div style={{
        background: "#d1f2eb",
        border: "1px solid #0f5132",
        borderRadius: "8px",
        padding: "2rem",
        textAlign: "center",
      }}>
        <h2 style={{ margin: "0 0 1rem 0", color: "#0f5132" }}>✓ Order Confirmed!</h2>
        <p className="segment-id">Segment: Checkout Confirm</p>
        <p>Your order has been successfully placed.</p>
        <p style={{ fontWeight: "bold", fontSize: "1.25rem", margin: "1rem 0" }}>Order #ORD-004</p>
        <div style={{ marginTop: "2rem", display: "flex", gap: "1rem", justifyContent: "center" }}>
          <a href="/shop" style={{
            background: "#667eea",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            textDecoration: "none",
          }}>
            Continue Shopping
          </a>
          <a href="/shop/account/orders" style={{
            border: "1px solid #667eea",
            color: "#667eea",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            textDecoration: "none",
          }}>
            View Orders
          </a>
        </div>
      </div>
    </div>
  ),

  // Account dashboard (nested route group)
  "account.index": (ctx: any) => {
    const user = ctx.user || { name: "Guest", email: "No user in context" };

    return (
      <div>
        <h2>Account Dashboard</h2>
        <p className="segment-id">Segment: Account Index</p>

        <div style={{
          background: "#d1f2eb",
          border: "2px solid #0f5132",
          padding: "1rem",
          borderRadius: "8px",
          marginTop: "1rem",
        }}>
          <h4 style={{ marginTop: 0 }}>🔐 User from Middleware Context</h4>
          <p style={{ fontSize: "0.9rem", margin: "0.5rem 0" }}>
            <strong>Name:</strong> {user.name}
          </p>
          <p style={{ fontSize: "0.9rem", margin: "0.5rem 0" }}>
            <strong>Email:</strong> {user.email}
          </p>
          <p style={{ fontSize: "0.9rem", margin: "0.5rem 0" }}>
            <strong>ID:</strong> <code>{user.id || 'N/A'}</code>
          </p>
          <p style={{ fontSize: "0.75rem", color: "#0f5132", marginTop: "0.75rem", marginBottom: 0, fontStyle: "italic" }}>
            ↑ This user object was added to <code>ctx.user</code> by the "mockAuth" middleware
          </p>
        </div>

        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "1.5rem",
          marginTop: "1rem",
        }}>
          <h3>Welcome back, {user.name}!</h3>
          <p>Manage your account and view your order history.</p>
          <div style={{ marginTop: "1rem" }}>
            <a href="/shop/account/orders" style={{
              background: "#667eea",
              color: "white",
              padding: "0.75rem 1.5rem",
              borderRadius: "4px",
              textDecoration: "none",
              display: "inline-block",
            }}>
              View All Orders
            </a>
          </div>
        </div>
      </div>
    );
  },

  // Order history (nested route)
  "account.orders": () => (
    <div>
      <h2>Order History</h2>
      <p className="segment-id">Segment: Account Orders</p>
      <div style={{ marginTop: "1rem" }}>
        {orders.map((order) => (
          <a
            key={order.id}
            href={`/shop/account/orders/${order.id}`}
            style={{
              display: "block",
              background: "#fff",
              border: "1px solid #e9ecef",
              borderRadius: "8px",
              padding: "1rem",
              marginBottom: "1rem",
              textDecoration: "none",
              color: "inherit",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h3 style={{ margin: "0 0 0.5rem 0" }}>{order.id}</h3>
                <p style={{ margin: 0, color: "#6c757d", fontSize: "0.85rem" }}>{order.date}</p>
              </div>
              <div style={{ textAlign: "right" }}>
                <p style={{ margin: "0 0 0.5rem 0", fontWeight: "bold" }}>${order.total}</p>
                <p style={{ margin: 0, color: "#667eea", fontSize: "0.85rem" }}>{order.status}</p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  ),

  // Order detail (nested + dynamic segment)
  "account.orderDetail": (ctx: any) => {
    const order = orders.find((o) => o.id === ctx.params.id);

    if (!order) {
      return (
        <div>
          <h2>Order Not Found</h2>
          <p><a href="/shop/account/orders">← Back to orders</a></p>
        </div>
      );
    }

    return (
      <div>
        <h2>Order {order.id}</h2>
        <p className="segment-id">Segment: Order Detail ({order.id})</p>
        <p style={{ color: "#666", marginBottom: "1rem" }}>
          <a href="/shop/account/orders">← Back to orders</a>
        </p>
        <div style={{
          background: "#fff",
          border: "1px solid #e9ecef",
          borderRadius: "8px",
          padding: "1.5rem",
        }}>
          <div style={{ marginBottom: "1rem" }}>
            <p><strong>Order Date:</strong> {order.date}</p>
            <p><strong>Status:</strong> <span style={{ color: "#667eea" }}>{order.status}</span></p>
            <p><strong>Total:</strong> ${order.total}</p>
          </div>
          <hr style={{ margin: "1rem 0" }} />
          <h3>Items</h3>
          <ul>
            <li>Coffee Maker - $149.99</li>
          </ul>
        </div>
      </div>
    );
  },
});
