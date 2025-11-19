import type { RouteHandler } from "rsc-router/server";
import type { shopRoutes } from "@/routes.js";
import { products } from "@/handlers/shop/data.js";
import { SegmentTimer } from "@/components/SegmentTimer.js";
import { DebugSegmentWrapper } from "@/components/DebugSegmentWrapper.js";
import { ParallelOutlet } from "rsc-router/client";

export const CartRoute: RouteHandler<typeof shopRoutes, "cart"> = () => (
  <DebugSegmentWrapper type="route" name="Cart">
    <div style={{ display: "flex", gap: "2rem" }}>
      <div style={{ flex: 1 }}>
        <h2>Shopping Cart</h2>
        <p className="segment-id">Segment: Cart</p>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        This route ALWAYS revalidates (fresh cart data)
      </p>

      <div style={{ border: "1px solid #ddd", borderRadius: "4px" }}>
        <div
          style={{
            padding: "1rem",
            borderBottom: "1px solid #ddd",
            background: "#f9f9f9",
          }}
        >
          <strong>Cart Items (Sample)</strong>
        </div>
        {products.slice(0, 2).map((product) => (
          <div
            key={product.id}
            style={{
              padding: "1rem",
              borderBottom: "1px solid #ddd",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <div>
              <strong>{product.name}</strong>
              <p style={{ margin: "0.25rem 0 0 0", color: "#666" }}>
                Quantity: 1
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <strong>${product.price}</strong>
            </div>
          </div>
        ))}
        <div
          style={{
            padding: "1rem",
            background: "#f9f9f9",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <strong>Total</strong>
          <strong>
            $
            {products
              .slice(0, 2)
              .reduce((sum, p) => sum + p.price, 0)
              .toFixed(2)}
          </strong>
        </div>
      </div>

      <div style={{ marginTop: "1rem" }}>
        <a
          href="/shop/checkout"
          style={{
            display: "inline-block",
            background: "#007bff",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            textDecoration: "none",
          }}
        >
          Proceed to Checkout
        </a>
      </div>

      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "#f5f5f5",
          borderRadius: "4px",
        }}
      >
        <h4>Revalidation Demo</h4>
        <p>
          This route uses <code>[revalidate("cart")]</code> to ALWAYS refresh
          cart data.
        </p>
        <p>Try navigating away and back - you'll see the segment re-renders.</p>
        <SegmentTimer />
      </div>
    </div>
      {/* Order summary - parallel route */}
      <aside style={{ width: "300px" }}>
        <ParallelOutlet name="@summary" />
      </aside>
    </div>
  </DebugSegmentWrapper>
);
