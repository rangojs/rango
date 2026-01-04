import { map, createLoader } from "rsc-router/server";
import { Outlet, Link } from "rsc-router/client";
import type { middlewareRoutes } from "../routes.js";
import { DebugSegmentWrapper } from "../components/DebugSegmentWrapper.js";

/**
 * Middleware Demo Layout
 * Provides navigation and context for middleware examples
 */
function MiddlewareDemoLayout() {
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

/**
 * Index page - overview of middleware types
 */
function MiddlewareIndexPage({ requestId }: { requestId?: string }) {
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
              IDs, or shared setup. Added at the top of the handler array.
            </p>
            <pre
              style={{
                background: "#dcfce7",
                padding: "0.5rem",
                borderRadius: "4px",
                fontSize: "0.875rem",
                margin: "0.5rem 0 0 0",
              }}
            >
              {`middleware((ctx, next) => {
  ctx.set("requestId", crypto.randomUUID());
  await next();
  ctx.header("X-Request-Id", ctx.get("requestId"));
})`}
            </pre>
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
            <pre
              style={{
                background: "#ccfbf1",
                padding: "0.5rem",
                borderRadius: "4px",
                fontSize: "0.875rem",
                margin: "0.5rem 0 0 0",
              }}
            >
              {`middleware("/dashboard*", (ctx, next) => {
  if (!isAuthenticated(ctx)) {
    return redirect("/login");
  }
  await next();
})`}
            </pre>
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
            <pre
              style={{
                background: "#e0f2fe",
                padding: "0.5rem",
                borderRadius: "4px",
                fontSize: "0.875rem",
                margin: "0.5rem 0 0 0",
              }}
            >
              {`route("timed", () => <TimedPage />, () => [
  middleware(async (ctx, next) => {
    const start = performance.now();
    await next();
    ctx.header("X-Response-Time", \`\${elapsed}ms\`);
  }),
])`}
            </pre>
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
              Used for auth checks on data fetching.
            </p>
            <pre
              style={{
                background: "#f3e8ff",
                padding: "0.5rem",
                borderRadius: "4px",
                fontSize: "0.875rem",
                margin: "0.5rem 0 0 0",
              }}
            >
              {`const ApiLoader = createLoader(
  async (ctx) => fetchData(ctx),
  { fetchable: true, middleware: [authMiddleware] }
)`}
            </pre>
          </div>
        </div>
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Dashboard page - protected by pattern-based middleware
 */
function DashboardPage({ user }: { user?: { id: string; name: string } }) {
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
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#134e4a" }}>
            Pattern-Based Auth Middleware
          </h4>
          <p style={{ margin: 0, color: "#134e4a" }}>
            This route is protected by <code>middleware("/dashboard*")</code>.
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

/**
 * Timed page - demonstrates route-level middleware
 */
function TimedPage({ elapsed }: { elapsed?: string }) {
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
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#0c4a6e" }}>
            Per-Route Timing Middleware
          </h4>
          <p style={{ margin: 0, color: "#0c4a6e" }}>
            This route has middleware defined inside its children function. It
            measures response time and adds an X-Response-Time header.
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
            <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.875rem" }}>
              Check the response headers for <code>X-Response-Time</code>
            </p>
          </div>
        )}
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * User page - demonstrates variable sharing between middleware and handler
 */
function UserPage({
  userId,
  enrichedUser,
}: {
  userId: string;
  enrichedUser?: { id: string; name: string; role: string };
}) {
  return (
    <DebugSegmentWrapper type="route" name="User (Variable Sharing)">
      <div>
        <h2>Variable Sharing with ctx.set/ctx.get</h2>

        <div
          style={{
            background: "#eef2ff",
            border: "1px solid #a5b4fc",
            borderRadius: "8px",
            padding: "1rem",
            marginBottom: "1rem",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#3730a3" }}>
            Middleware Sets Variables
          </h4>
          <p style={{ margin: 0, color: "#3730a3" }}>
            Middleware uses <code>ctx.set("enrichedUser", data)</code> and the
            handler reads it with <code>ctx.get("enrichedUser")</code>.
          </p>
        </div>

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
              <code>ctx.params.userId</code>: {userId}
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

/**
 * API page - demonstrates loader middleware
 */
function ApiDataPage() {
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
          <h4 style={{ margin: "0 0 0.5rem 0", color: "#581c87" }}>
            Fetchable Loader with Auth Middleware
          </h4>
          <p style={{ margin: 0, color: "#581c87" }}>
            This route has a fetchable loader with its own middleware chain.
            When the loader is fetched via GET or server action, the middleware runs first.
          </p>
        </div>

        <div
          style={{
            background: "#f3e8ff",
            padding: "1rem",
            borderRadius: "8px",
            marginBottom: "1rem",
          }}
        >
          <h4 style={{ margin: "0 0 0.5rem 0" }}>How Loader Middleware Works</h4>
          <ol style={{ margin: 0, paddingLeft: "1.25rem" }}>
            <li>Define middleware in <code>createLoader</code> options</li>
            <li>Middleware runs before loader function executes</li>
            <li>Can set headers, check auth, or short-circuit with redirect</li>
            <li>Shares context with the loader function</li>
          </ol>
        </div>

        <pre
          style={{
            background: "#1f2937",
            color: "#e5e7eb",
            padding: "1rem",
            borderRadius: "8px",
            fontSize: "0.875rem",
            overflow: "auto",
          }}
        >
{`const ApiDataLoader = createLoader(
  async (ctx) => {
    return { items: ["alpha", "beta"], timestamp: new Date().toISOString() };
  },
  {
    fetchable: true,
    middleware: [
      async (ctx, next) => {
        console.log("[ApiDataLoader] Middleware running");
        ctx.header("X-Loader-Middleware", "executed");
        await next();
      },
    ],
  }
);`}
        </pre>

        <p style={{ marginTop: "1rem", color: "#6b7280" }}>
          Check the server console to see the middleware logging when this page loads.
          The loader is registered and its middleware will execute when fetched.
        </p>
      </div>
    </DebugSegmentWrapper>
  );
}

/**
 * Loader with middleware for API data route
 */
const ApiDataLoader = createLoader(
  async (ctx) => {
    // Simulate fetching data
    await new Promise((resolve) => setTimeout(resolve, 100));
    return {
      items: ["alpha", "beta", "gamma"],
      timestamp: new Date().toISOString(),
    };
  },
  {
    fetchable: true,
    middleware: [
      async (ctx, next) => {
        // Loader-level auth check
        console.log("[ApiDataLoader] Middleware running");
        ctx.header("X-Loader-Middleware", "executed");
        await next();
      },
    ],
  }
);

/**
 * Middleware Demo handler
 * Demonstrates all middleware types in rsc-router
 */
export default map<typeof middlewareRoutes>(({ route, layout, middleware, loader }) => [
  // Global middleware - runs for ALL routes in this handler
  middleware(async (ctx, next) => {
    const requestId = crypto.randomUUID().slice(0, 8);
    ctx.set("requestId", requestId);
    console.log(`[Middleware Demo] Request ${requestId} started`);

    const start = performance.now();
    await next();
    const elapsed = performance.now() - start;

    ctx.header("X-Request-Id", requestId);
    console.log(`[Middleware Demo] Request ${requestId} completed in ${elapsed.toFixed(2)}ms`);
  }),

  // Pattern-based middleware - runs for /dashboard* routes
  middleware("/dashboard*", async (ctx, next) => {
    const isAuth = ctx.searchParams.get("auth") === "true";
    console.log(`[Auth Middleware] Checking auth for ${ctx.pathname}: ${isAuth}`);

    if (isAuth) {
      ctx.set("user", { id: "user-123", name: "Demo User" });
    }

    await next();
  }),

  // Layout for the demo
  layout(<MiddlewareDemoLayout />, () => [
    // Index route
    route("index", (ctx) => (
      <MiddlewareIndexPage requestId={ctx.get("requestId")} />
    )),

    // Dashboard - protected by pattern-based middleware
    route("dashboard", (ctx) => (
      <DashboardPage user={ctx.get("user")} />
    )),

    // Timed route with route-level middleware
    route(
      "timed",
      (ctx) => <TimedPage elapsed={ctx.get("responseTime")} />,
      () => [
        middleware(async (ctx, next) => {
          const start = performance.now();
          await next();
          const elapsed = `${(performance.now() - start).toFixed(2)}ms`;
          ctx.set("responseTime", elapsed);
          ctx.header("X-Response-Time", elapsed);
          console.log(`[Timed Route] Response time: ${elapsed}`);
        }),
      ]
    ),

    // User route with variable sharing
    route(
      "user",
      (ctx) => (
        <UserPage
          userId={ctx.params.userId}
          enrichedUser={ctx.get("enrichedUser")}
        />
      ),
      () => [
        middleware(async (ctx, next) => {
          // Enrich user data from params
          const userId = ctx.params.userId;
          ctx.set("enrichedUser", {
            id: userId,
            name: `User ${userId}`,
            role: userId === "admin" ? "Administrator" : "Member",
          });
          ctx.header("X-User-Id", userId);
          await next();
        }),
      ]
    ),

    // API route with loader middleware
    route("api", () => <ApiDataPage />, () => [
      loader(ApiDataLoader),
    ]),
  ]),
]);
