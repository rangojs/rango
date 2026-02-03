import type { MiddlewareFn, GenericParams, HandlerContext } from "@rangojs/router";
import { Outlet, Link } from "@rangojs/router/client";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

export function MiddlewareDemoLayout() {
  return (
    <DebugSegmentWrapper type="layout" name="Middleware Demo">
      <div style={{ maxWidth: "900px", margin: "0 auto", padding: "2rem" }}>
        <header
          style={{
            background: "linear-gradient(135deg, #059669 0%, #0d9488 100%)",
            color: "white",
            padding: "2rem",
            borderRadius: "12px",
            marginBottom: "2rem",
          }}
        >
          <h1 style={{ margin: "0 0 0.5rem 0", color: "white" }}>
            Middleware API Demo
          </h1>
          <p style={{ margin: 0, opacity: 0.9 }}>
            Demonstrates global, pattern-based, route-level, and loader
            middleware
          </p>
        </header>

        <nav
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "0.75rem",
            marginBottom: "2rem",
            padding: "1rem",
            background: "#f9fafb",
            borderRadius: "8px",
          }}
        >
          <Link
            to="/middleware"
            style={{
              padding: "0.5rem 1rem",
              background: "#059669",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Index
          </Link>
          <Link
            to="/middleware/dashboard"
            style={{
              padding: "0.5rem 1rem",
              background: "#0d9488",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Dashboard (Auth)
          </Link>
          <Link
            to="/middleware/timed"
            style={{
              padding: "0.5rem 1rem",
              background: "#0891b2",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Timed (Route-level)
          </Link>
          <Link
            to="/middleware/user/123"
            style={{
              padding: "0.5rem 1rem",
              background: "#6366f1",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            User (Variables)
          </Link>
          <Link
            to="/middleware/api/data"
            style={{
              padding: "0.5rem 1rem",
              background: "#8b5cf6",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            API (Loader MW)
          </Link>
        </nav>

        <Outlet />
      </div>
    </DebugSegmentWrapper>
  );
}

export function MiddlewareIndexPage(ctx: HandlerContext<{}, RSCRouter.Env>) {
  const requestId = ctx.get("requestId");
  return (
    <DebugSegmentWrapper type="route" name="Middleware Index">
      <div>
        <h2>Middleware Types Overview</h2>

        {requestId && (
          <div
            style={{
              background: "#d1fae5",
              border: "1px solid #6ee7b7",
              borderRadius: "8px",
              padding: "1rem",
              marginBottom: "1.5rem",
            }}
          >
            <strong>Request ID from global middleware:</strong>{" "}
            <code>{requestId}</code>
          </div>
        )}

        <div style={{ display: "grid", gap: "1rem" }}>
          <div
            style={{
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: "8px",
              padding: "1rem",
            }}
          >
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#166534" }}>
              1. Global Middleware
            </h3>
            <p style={{ margin: 0, color: "#166534" }}>
              Runs for all routes in this handler. Used for logging, request
              IDs, or shared setup.
            </p>
          </div>

          <div
            style={{
              background: "#f0fdfa",
              border: "1px solid #5eead4",
              borderRadius: "8px",
              padding: "1rem",
            }}
          >
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#134e4a" }}>
              2. Pattern-Based Middleware
            </h3>
            <p style={{ margin: 0, color: "#134e4a" }}>
              Runs only for routes matching a pattern. Used for auth protection
              on route groups.
            </p>
          </div>

          <div
            style={{
              background: "#f0f9ff",
              border: "1px solid #7dd3fc",
              borderRadius: "8px",
              padding: "1rem",
            }}
          >
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#0c4a6e" }}>
              3. Route-Level Middleware
            </h3>
            <p style={{ margin: 0, color: "#0c4a6e" }}>
              Runs only for a specific route. Defined inside the route's
              children function.
            </p>
          </div>

          <div
            style={{
              background: "#faf5ff",
              border: "1px solid #c4b5fd",
              borderRadius: "8px",
              padding: "1rem",
            }}
          >
            <h3 style={{ margin: "0 0 0.5rem 0", color: "#581c87" }}>
              4. Loader Middleware
            </h3>
            <p style={{ margin: 0, color: "#581c87" }}>
              Runs when a fetchable loader is called via GET or server action.
            </p>
          </div>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

export function MiddlewareDashboardPage(ctx: HandlerContext<{}, RSCRouter.Env>) {
  const user = ctx.get("user");
  return (
    <DebugSegmentWrapper type="route" name="Dashboard (Protected)">
      <div>
        <h2>Protected Dashboard</h2>

        <div
          style={{
            background: "#f0fdfa",
            border: "1px solid #5eead4",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <p style={{ margin: 0, color: "#134e4a" }}>
            Add <code>?auth=true</code> to the URL to simulate authentication.
          </p>
        </div>

        {user ? (
          <div
            style={{
              background: "#d1fae5",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
            <p style={{ margin: 0 }}>
              <strong>Authenticated as:</strong> {user.name} (ID: {user.id})
            </p>
          </div>
        ) : (
          <div
            style={{
              background: "#fee2e2",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
            <p style={{ margin: 0 }}>
              Not authenticated. Add <code>?auth=true</code> to the URL.
            </p>
          </div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <Link
            to="/middleware/dashboard?auth=true"
            style={{
              display: "inline-block",
              padding: "0.5rem 1rem",
              background: "#059669",
              color: "white",
              borderRadius: "6px",
              textDecoration: "none",
            }}
          >
            Login (add ?auth=true)
          </Link>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

export function MiddlewareTimedPage(ctx: HandlerContext<{}, RSCRouter.Env>) {
  const elapsed = ctx.get("responseTime");
  return (
    <DebugSegmentWrapper type="route" name="Timed (Route-Level MW)">
      <div>
        <h2>Route-Level Middleware</h2>

        <div
          style={{
            background: "#f0f9ff",
            border: "1px solid #7dd3fc",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <p style={{ margin: 0, color: "#0c4a6e" }}>
            This route has middleware that measures response time.
          </p>
        </div>

        {elapsed && (
          <div
            style={{
              background: "#dbeafe",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
            <p style={{ margin: 0 }}>
              <strong>Handler execution time:</strong> {elapsed}
            </p>
          </div>
        )}
      </div>
    </DebugSegmentWrapper>
  );
}

export function MiddlewareUserPage(ctx: HandlerContext<{ userId: string }, RSCRouter.Env>) {
  const enrichedUser = ctx.get("enrichedUser");
  return (
    <DebugSegmentWrapper type="route" name="User (Variable Sharing)">
      <div>
        <h2>Variable Sharing with ctx.set/ctx.get</h2>

        <div
          style={{
            display: "grid",
            gap: "1rem",
            gridTemplateColumns: "1fr 1fr",
          }}
        >
          <div
            style={{
              background: "#f3f4f6",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem 0" }}>From URL Params</h4>
            <p style={{ margin: 0 }}>
              <code>ctx.params.userId</code>: {ctx.params.userId}
            </p>
          </div>

          <div
            style={{
              background: "#c7d2fe",
              padding: "1rem",
              borderRadius: "8px",
            }}
          >
            <h4 style={{ margin: "0 0 0.5rem 0" }}>From Middleware</h4>
            {enrichedUser ? (
              <>
                <p style={{ margin: 0 }}>
                  <strong>Name:</strong> {enrichedUser.name}
                </p>
                <p style={{ margin: "0.25rem 0 0 0" }}>
                  <strong>Role:</strong> {enrichedUser.role}
                </p>
              </>
            ) : (
              <p style={{ margin: 0 }}>No enriched data</p>
            )}
          </div>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

export function MiddlewareApiPage() {
  return (
    <DebugSegmentWrapper type="route" name="API (Loader Middleware)">
      <div>
        <h2>Loader Middleware</h2>

        <div
          style={{
            background: "#faf5ff",
            border: "1px solid #c4b5fd",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <p style={{ margin: 0, color: "#581c87" }}>
            This route has a fetchable loader with its own middleware chain.
          </p>
        </div>

        <p style={{ marginTop: "1rem", color: "#6b7280" }}>
          Check the server console to see the middleware logging when this page loads.
        </p>
      </div>
    </DebugSegmentWrapper>
  );
}

// Global middleware
export const globalMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  async (ctx, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    ctx.set("requestId", requestId);
    console.log(`[Middleware Demo] Request ${requestId} started`);

    const start = performance.now();
    await next();
    const elapsed = performance.now() - start;

    ctx.header("X-Request-Id", requestId);
    console.log(`[Middleware Demo] Request ${requestId} completed in ${elapsed.toFixed(2)}ms`);
  },
];

// Dashboard middleware
export const dashboardMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  async (ctx, next) => {
    const isAuth = ctx.searchParams.get("auth") === "true";
    console.log(`[Auth Middleware] Checking auth for ${ctx.pathname}: ${isAuth}`);

    if (isAuth) {
      ctx.set("user", { id: "user-123", name: "Demo User" });
    }

    await next();
  },
];

// Timed middleware
export const timedMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  async (ctx, next) => {
    const start = performance.now();
    await next();
    const elapsed = `${(performance.now() - start).toFixed(2)}ms`;
    ctx.set("responseTime", elapsed);
    ctx.header("X-Response-Time", elapsed);
    console.log(`[Timed Route] Response time: ${elapsed}`);
  },
];

// User middleware
export const userMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  async (ctx, next) => {
    const userId = ctx.params.userId as string;
    ctx.set("enrichedUser", {
      id: userId,
      name: `User ${userId}`,
      role: userId === "admin" ? "Administrator" : "Member",
    });
    ctx.header("X-User-Id", userId);
    await next();
  },
];

// API middleware
export const apiMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  async (ctx, next) => {
    console.log("[API Middleware] Running");
    ctx.header("X-API-Middleware", "executed");
    await next();
  },
];
