import { categories, products, orders } from "./data.js";

// ==================== PARALLEL ROUTE COMPONENTS ====================

export function CategorySidebar() {
  return (
    <div
      style={{
        background: "#f8f9fa",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "200px",
      }}
    >
      <p className="segment-id">Segment: @sidebar</p>
      <h3 style={{ marginTop: 0 }}>Categories</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {categories.map((cat) => (
          <li key={cat} style={{ marginBottom: "0.5rem" }}>
            <a
              href={`/shop/products/${cat}`}
              style={{ textTransform: "capitalize" }}
            >
              {cat}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RelatedProducts({ slug }: { slug?: string }) {
  const currentProduct = slug ? products.find((p) => p.slug === slug) : undefined;
  const relatedProducts = currentProduct
    ? products
        .filter(
          (p) =>
            p.category === currentProduct.category && p.slug !== slug
        )
        .slice(0, 2)
    : [];

  return (
    <div
      style={{
        background: "#fff3cd",
        padding: "1.5rem",
        borderRadius: "8px",
        marginTop: "2rem",
      }}
    >
      <p className="segment-id">Segment: @related</p>
      <h3 style={{ marginTop: 0 }}>Related Products</h3>
      {relatedProducts.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {relatedProducts.map((p) => (
            <li key={p.id} style={{ marginBottom: "0.5rem" }}>
              <a href={`/shop/product/${p.slug}`}>{p.name}</a>
              <span style={{ color: "#666", marginLeft: "0.5rem" }}>
                ${p.price}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No related products found.</p>
      )}
    </div>
  );
}

export function OrderSummary({ variant = "cart" }: { variant?: "cart" | "checkout" | "payment" }) {
  const segmentLabel =
    variant === "cart" ? "@summary" :
    variant === "checkout" ? "@summary (checkout)" :
    "@summary (payment)";

  return (
    <div
      style={{
        background: "#e8f4f8",
        padding: "1.5rem",
        borderRadius: "8px",
        marginLeft: "2rem",
        width: "250px",
      }}
    >
      <p className="segment-id">Segment: {segmentLabel}</p>
      <h3 style={{ marginTop: 0 }}>Order Summary</h3>
      <div style={{ marginBottom: "1rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <span>Subtotal:</span>
          <span>$149.99</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <span>Shipping:</span>
          <span>$10.00</span>
        </div>
        <hr style={{ margin: "0.5rem 0" }} />
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontWeight: "bold",
          }}
        >
          <span>Total:</span>
          <span>$159.99</span>
        </div>
      </div>
    </div>
  );
}

export function RecentOrders() {
  return (
    <div
      style={{
        background: "#d1f2eb",
        padding: "1.5rem",
        borderRadius: "8px",
        marginTop: "2rem",
      }}
    >
      <p className="segment-id">Segment: @orders</p>
      <h3 style={{ marginTop: 0 }}>Recent Orders</h3>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {orders.slice(0, 2).map((order) => (
          <li key={order.id} style={{ marginBottom: "0.5rem" }}>
            <a href={`/shop/account/orders/${order.id}`}>{order.id}</a>
            <span style={{ color: "#666", marginLeft: "0.5rem" }}>
              ${order.total}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ==================== PRODUCT PAGE COMPONENTS ====================

export function PDPNavbar(product: {
  id: number;
  slug: string;
  name: string;
  category: string;
  price: number;
}) {
  return (
    <div
      style={{
        marginTop: "1rem",
        padding: "1rem",
        background: "#fff3cd",
        borderRadius: "4px",
      }}
    >
      <h4 style={{ marginTop: 0 }}>🧪 Test Revalidation Behavior:</h4>
      <ul style={{ margin: 0, paddingLeft: "1.5rem", fontSize: "0.9rem" }}>
        <li style={{ marginBottom: "0.5rem" }}>
          <a href="/shop/product/wireless-headphones">Wireless Headphones</a> →{" "}
          <strong>Slug changes = Timer resets</strong>
        </li>
        <li style={{ marginBottom: "0.5rem" }}>
          <a href="/shop/product/running-shoes">Running Shoes</a> →{" "}
          <strong>Slug changes = Timer resets</strong>
        </li>
        <li style={{ marginBottom: "0.5rem" }}>
          <a href={`/shop/product/${product.slug}?tab=details`}>
            Add ?tab=details
          </a>{" "}
          → <strong>Query only = Timer keeps running</strong>
        </li>
        <li style={{ marginBottom: "0.5rem" }}>
          <a href={`/shop/product/${product.slug}?tab=reviews`}>
            Change to ?tab=reviews
          </a>{" "}
          → <strong>Query change = Timer keeps running</strong>
        </li>
      </ul>
      <p
        style={{
          fontSize: "0.8rem",
          color: "#856404",
          marginTop: "0.75rem",
          marginBottom: 0,
        }}
      >
        <strong>Watch the timer and console logs!</strong>{" "}
        defaultShouldRevalidate is TRUE only when <code>:slug</code> changes.
      </p>
    </div>
  );
}

export function ProductCard({ product }: { product: { id: number; slug: string; name: string; category: string; price: number } }) {
  return (
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
      <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>
        {product.name}
      </h3>
      <p
        style={{
          margin: "0 0 0.5rem 0",
          fontSize: "0.85rem",
          color: "#6c757d",
          textTransform: "capitalize",
        }}
      >
        {product.category}
      </p>
      <p style={{ margin: 0, fontWeight: "bold", color: "#667eea" }}>
        ${product.price}
      </p>
    </a>
  );
}

export function ProductCardSimple({ product }: { product: { id: number; slug: string; name: string; price: number } }) {
  return (
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
      <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1rem" }}>
        {product.name}
      </h3>
      <p style={{ margin: 0, fontWeight: "bold", color: "#667eea" }}>
        ${product.price}
      </p>
    </a>
  );
}
