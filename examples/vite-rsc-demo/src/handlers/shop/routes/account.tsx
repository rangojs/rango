import type { RouteHandler } from "@ivogt/rsc-router/server";
import type { shopRoutes } from "@/routes.js";
import { orders } from "@/handlers/shop/data.js";
import { SegmentTimer } from "@/components/SegmentTimer.js";

export const AccountIndexRoute: RouteHandler<
  typeof shopRoutes,
  "account.index"
> = (ctx) => {
  // Type-safe context access!
  const user = ctx.get("user") || {
    id: "guest",
    name: "Guest",
    email: "guest@example.com",
  };

  return (
    <div>
      <h2>My Account</h2>
      <p className="segment-id">Segment: Account Index</p>

      <div
        style={{
          padding: "1rem",
          background: "#f9f9f9",
          border: "1px solid #ddd",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      >
        <h3>Account Information</h3>
        <p>
          <strong>Name:</strong> {user.name}
        </p>
        <p>
          <strong>Email:</strong> {user.email}
        </p>
        <p>
          <strong>Member since:</strong> January 2024
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "1rem" }}>
        <a
          href="/shop/account/orders"
          style={{
            padding: "1.5rem",
            background: "white",
            border: "1px solid #ddd",
            borderRadius: "4px",
            textDecoration: "none",
            color: "inherit",
            display: "block",
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem 0" }}>Order History</h3>
          <p style={{ margin: 0, color: "#666" }}>View your past orders</p>
        </a>

        <div
          style={{
            padding: "1.5rem",
            background: "white",
            border: "1px solid #ddd",
            borderRadius: "4px",
          }}
        >
          <h3 style={{ margin: "0 0 0.5rem 0" }}>Settings</h3>
          <p style={{ margin: 0, color: "#666" }}>Manage your account</p>
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
        <h4>Nested Route Group</h4>
        <p>
          All <code>account.*</code> routes share the same AccountLayout
        </p>
        <SegmentTimer />
      </div>
    </div>
  );
};

export const AccountOrdersRoute: RouteHandler<
  typeof shopRoutes,
  "account.orders"
> = () => (
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
            padding: "1rem",
            background: "white",
            border: "1px solid #ddd",
            borderRadius: "4px",
            marginBottom: "0.5rem",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <strong>Order #{order.id}</strong>
              <p style={{ margin: "0.25rem 0 0 0", color: "#666" }}>
                {order.date}
              </p>
            </div>
            <div style={{ textAlign: "right" }}>
              <strong>${order.total}</strong>
              <p
                style={{
                  margin: "0.25rem 0 0 0",
                  color: order.status === "Delivered" ? "#28a745" : "#ffc107",
                }}
              >
                {order.status}
              </p>
            </div>
          </div>
        </a>
      ))}
    </div>

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
        This route uses <code>[middleware("account.orders", "permissions")]</code>
      </p>
      <SegmentTimer />
    </div>
  </div>
);

export const AccountOrderDetailRoute: RouteHandler<
  typeof shopRoutes,
  "account.orderDetail"
> = (ctx) => {
  const order = orders.find((o) => o.id === ctx.params.id);

  if (!order) {
    return (
      <div>
        <h2>Order Not Found</h2>
        <p className="segment-id">Segment: Account Order Detail</p>
        <p>Order #{ctx.params.id} not found</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Order #{order.id}</h2>
      <p className="segment-id">Segment: Account Order Detail</p>

      <div
        style={{
          padding: "1rem",
          background: "#f9f9f9",
          border: "1px solid #ddd",
          borderRadius: "4px",
          marginBottom: "1rem",
        }}
      >
        <h3>Order Information</h3>
        <p>
          <strong>Order Date:</strong> {order.date}
        </p>
        <p>
          <strong>Status:</strong>{" "}
          <span
            style={{
              color: order.status === "Delivered" ? "#28a745" : "#ffc107",
            }}
          >
            {order.status}
          </span>
        </p>
        <p>
          <strong>Total:</strong> ${order.total}
        </p>
      </div>

      <div
        style={{
          padding: "1rem",
          background: "white",
          border: "1px solid #ddd",
          borderRadius: "4px",
        }}
      >
        <h3>Items</h3>
        {order.items.map((item, idx) => (
          <div
            key={idx}
            style={{
              padding: "0.5rem 0",
              borderBottom:
                idx < order.items.length - 1 ? "1px solid #eee" : "none",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{item}</span>
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          marginTop: "2rem",
          padding: "1rem",
          background: "#f5f5f5",
          borderRadius: "4px",
        }}
      >
        <h4>Dynamic Segment Revalidation</h4>
        <p>
          This route uses{" "}
          <code>[revalidate("account.orderDetail")]</code>
        </p>
        <p>
          Revalidates only when order ID changes (params-aware revalidation)
        </p>
        <p>
          <strong>Current Order ID:</strong> {ctx.params.id}
        </p>
        <SegmentTimer />
      </div>

      <div style={{ marginTop: "1rem" }}>
        <a
          href="/shop/account/orders"
          style={{
            display: "inline-block",
            background: "#007bff",
            color: "white",
            padding: "0.5rem 1rem",
            borderRadius: "4px",
            textDecoration: "none",
          }}
        >
          ← Back to Orders
        </a>
      </div>
    </div>
  );
};
