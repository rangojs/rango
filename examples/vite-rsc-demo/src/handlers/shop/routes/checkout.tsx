import type { Handler } from "@rangojs/router/server";
import type { AppEnv } from "@/router.js";
import { SegmentTimer } from "@/components/SegmentTimer.js";

export const CheckoutIndexRoute: Handler<{}, AppEnv> = (ctx) => (
  <div style={{ display: "flex", gap: "2rem" }}>
    <div style={{ flex: 1 }}>
      <h2>Checkout</h2>
      <p className="segment-id">Segment: Checkout Index</p>
      <p style={{ color: "#666", marginBottom: "1rem" }}>
        Protected by <code>requireAuthMiddleware</code>
      </p>

      <div
        style={{
          padding: "1rem",
          background: "#e8f5e9",
          border: "1px solid #4caf50",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      >
        <p style={{ margin: 0 }}>
          ✓ Authenticated as: <strong>{ctx.get("user")?.name}</strong>
        </p>
      </div>

      <form style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            Full Name
          </label>
          <input
            type="text"
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
            defaultValue={ctx.get("user")?.name}
          />
        </div>

        <div>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            Email
          </label>
          <input
            type="email"
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
            defaultValue={ctx.get("user")?.email}
          />
        </div>

        <div>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            Shipping Address
          </label>
          <textarea
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
              minHeight: "80px",
            }}
            placeholder="123 Main St, City, State, ZIP"
          />
        </div>

        <a
          href="/shop/checkout/payment"
          style={{
            display: "inline-block",
            background: "#007bff",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            textDecoration: "none",
            textAlign: "center",
          }}
        >
          Continue to Payment
        </a>
      </form>

      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "#f5f5f5",
          borderRadius: "4px",
        }}
      >
        <h4>Middleware Demo</h4>
        <p>
          This route uses <code>[middleware("checkout.index", "requireAuth")]</code>
        </p>
        <SegmentTimer serverRenderTime={new Date().toISOString()} />
      </div>
    </div>
  </div>
);

export const CheckoutPaymentRoute: Handler = () => (
  <div style={{ display: "flex", gap: "2rem" }}>
    <div style={{ flex: 1 }}>
      <h2>Payment</h2>
      <p className="segment-id">Segment: Checkout Payment</p>

      <form style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <div>
          <label style={{ display: "block", marginBottom: "0.5rem" }}>
            Card Number
          </label>
          <input
            type="text"
            placeholder="1234 5678 9012 3456"
            style={{
              width: "100%",
              padding: "0.5rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
            }}
          />
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem" }}>
              Expiry Date
            </label>
            <input
              type="text"
              placeholder="MM/YY"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
            />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: "0.5rem" }}>
              CVV
            </label>
            <input
              type="text"
              placeholder="123"
              style={{
                width: "100%",
                padding: "0.5rem",
                border: "1px solid #ddd",
                borderRadius: "4px",
              }}
            />
          </div>
        </div>

        <a
          href="/shop/checkout/confirm"
          style={{
            display: "inline-block",
            background: "#28a745",
            color: "white",
            padding: "0.75rem 1.5rem",
            borderRadius: "4px",
            textDecoration: "none",
            textAlign: "center",
          }}
        >
          Place Order
        </a>
      </form>

      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "#f5f5f5",
          borderRadius: "4px",
        }}
      >
        <h4>Layout Composition</h4>
        <p>This route has 3 nested layouts:</p>
        <ol>
          <li>RootLayout (global)</li>
          <li>ShopLayout (shop routes)</li>
          <li>CheckoutLayout (checkout flow)</li>
        </ol>
        <SegmentTimer serverRenderTime={new Date().toISOString()} />
      </div>
    </div>
  </div>
);

export const CheckoutConfirmRoute: Handler = () => (
  <div>
    <div
      style={{
        background: "#d1f2eb",
        padding: "2rem",
        borderRadius: "4px",
        textAlign: "center",
        marginBottom: "1rem",
      }}
    >
      <h2 style={{ color: "#0c5c4c", margin: "0 0 0.5rem 0" }}>
        ✓ Order Confirmed!
      </h2>
      <p style={{ color: "#146c5b", margin: 0 }}>
        Thank you for your purchase. Order #12345
      </p>
    </div>

    <p className="segment-id">Segment: Checkout Confirm</p>

    <div
      style={{
        padding: "1rem",
        background: "#f9f9f9",
        border: "1px solid #ddd",
        borderRadius: "4px",
        marginBottom: "1rem",
      }}
    >
      <h3>Order Details</h3>
      <p>
        <strong>Order Number:</strong> #12345
      </p>
      <p>
        <strong>Total:</strong> $149.98
      </p>
      <p>
        <strong>Estimated Delivery:</strong> 3-5 business days
      </p>
    </div>

    <div
      style={{
        marginTop: "2rem",
        padding: "1rem",
        background: "#fff3cd",
        border: "1px solid #ffc107",
        borderRadius: "4px",
      }}
    >
      <h4>Revalidation Demo</h4>
      <p>
        This confirmation page uses{" "}
        <code>[revalidate("shop.checkout.confirm")]</code> with{" "}
        <code>return false</code>
      </p>
      <p>
        Navigate away and back - this segment will <strong>NOT</strong>{" "}
        re-render (static confirmation)
      </p>
      <SegmentTimer serverRenderTime={new Date().toISOString()} />
    </div>

    <div style={{ marginTop: "1rem" }}>
      <a
        href="/shop"
        style={{
          display: "inline-block",
          background: "#007bff",
          color: "white",
          padding: "0.75rem 1.5rem",
          borderRadius: "4px",
          textDecoration: "none",
        }}
      >
        Continue Shopping
      </a>
    </div>
  </div>
);
