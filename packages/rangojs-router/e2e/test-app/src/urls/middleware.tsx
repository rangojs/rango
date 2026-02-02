import { urls } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

/**
 * Middleware test routes URL patterns
 * Routes: middlewareTest.*
 */
export const middlewarePatterns = urls(({ path, middleware }) => [
  // Middleware test index
  path(
    "/",
    (ctx) => {
      // Check if redirected from protected route
      const authRequired = ctx.url.searchParams.get("auth") === "required";
      return (
        <div data-testid="middleware-test-index">
          <Link to="/" data-testid="back-link">
            ← Back to Home
          </Link>
          <h1 data-testid="middleware-test-title">Middleware Tests</h1>
          {authRequired && (
            <p data-testid="auth-required-message">Authentication required. Please login.</p>
          )}
          <nav data-testid="middleware-test-nav">
            <ul>
              <li>
                <Link to="/middleware-test/protected" data-testid="protected-link">
                  Protected Route (requires auth)
                </Link>
              </li>
              <li>
                <Link to="/middleware-test/protected/dashboard" data-testid="protected-dashboard-link">
                  Protected Dashboard
                </Link>
              </li>
              <li>
                <Link to="/middleware-test/error-handler/trigger" data-testid="error-handler-link">
                  Error Handler Test
                </Link>
              </li>
              <li>
                <Link to="/middleware-test/cookies" data-testid="cookies-link">
                  Cookie Test
                </Link>
              </li>
              <li>
                <Link to="/middleware-test/params/test-123" data-testid="params-link">
                  Params Test (id=test-123)
                </Link>
              </li>
              <li>
                <Link to="/middleware-test/shared-vars" data-testid="shared-vars-link">
                  Shared Variables Test
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      );
    },
    { name: "index" }
  ),

  // Protected route - requires auth cookie (set by middleware)
  path(
    "/protected",
    (ctx) => {
      // Get user from middleware-set context variable
      const user = ctx.get("user") as { id: string; name: string } | undefined;
      return (
        <div data-testid="middleware-test-protected">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="protected-title">Protected Route</h1>
          {user ? (
            <div data-testid="user-info">
              <p data-testid="user-id">User ID: {user.id}</p>
              <p data-testid="user-name">User Name: {user.name}</p>
            </div>
          ) : (
            <p data-testid="no-user">No user context (this shouldn't happen)</p>
          )}
        </div>
      );
    },
    { name: "protected" }
  ),

  // Protected dashboard - also requires auth
  path(
    "/protected/dashboard",
    (ctx) => {
      const user = ctx.get("user") as { id: string; name: string } | undefined;
      return (
        <div data-testid="middleware-test-protected-dashboard">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="dashboard-title">Protected Dashboard</h1>
          {user && (
            <p data-testid="dashboard-user">Welcome, {user.name}!</p>
          )}
        </div>
      );
    },
    { name: "protectedDashboard" }
  ),

  // Error handler test - throws error, caught by middleware
  path(
    "/error-handler/trigger",
    () => {
      throw new Error("Test error from handler");
      return (
        <div data-testid="error-handler-page">
          This should never render
        </div>
      );
    },
    { name: "errorHandler" }
  ),

  // Cookie test route
  path(
    "/cookies",
    (ctx) => {
      const visitCount = ctx.get("visitCount") as number | undefined;
      return (
        <div data-testid="middleware-test-cookies">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="cookies-title">Cookie Test</h1>
          <p data-testid="visit-count">Visit count: {visitCount ?? "unknown"}</p>
          <p data-testid="cookies-description">
            Refresh the page to see the visit count increment.
          </p>
        </div>
      );
    },
    { name: "cookies" }
  ),

  // Params test route - middleware extracts :id param
  path(
    "/params/:paramId",
    (ctx) => {
      const middlewareParams = ctx.get("middlewareParams") as Record<string, string> | undefined;
      return (
        <div data-testid="middleware-test-params">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="params-title">Params Test</h1>
          <p data-testid="route-param-id">Route param ID: {ctx.params.paramId}</p>
          <p data-testid="middleware-param-id">
            Middleware param ID: {middlewareParams?.id ?? "none"}
          </p>
        </div>
      );
    },
    { name: "params" }
  ),

  // Shared variables test
  path(
    "/shared-vars",
    () => (
      <div data-testid="middleware-test-shared-vars">
        <Link to="/middleware-test" data-testid="back-link">
          ← Back to Middleware Tests
        </Link>
        <h1 data-testid="shared-vars-title">Shared Variables Test</h1>
        <p data-testid="shared-vars-description">
          This page tests that middleware can share variables with handlers via ctx.set/get.
        </p>
      </div>
    ),
    { name: "sharedVars" }
  ),

  // Route-level middleware test - middleware defined inside route() callback
  path(
    "/route-level",
    (ctx) => {
      // Read variable set by route-level middleware
      const routeMiddlewareValue = ctx.get("routeMiddlewareApplied");
      return (
        <div data-testid="middleware-test-route-level">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="route-level-title">Route-Level Middleware Test</h1>
          <p data-testid="route-level-description">
            This route has middleware defined inside the route() callback.
          </p>
          <div data-testid="route-middleware-value">
            {routeMiddlewareValue || "No middleware value"}
          </div>
        </div>
      );
    },
    { name: "routeLevel" },
    () => [
      // Route-level middleware that sets a header and a variable
      middleware(async (ctx, next) => {
        ctx.set("routeMiddlewareApplied", "yes");
        await next();
        ctx.header("X-Route-Level-Middleware", "applied");
      }),
    ]
  ),

  // Route-level middleware with params test - verify ctx.params is available in middleware
  path(
    "/route-level/:routeId",
    (ctx) => {
      // Read variables set by route-level middleware (which read from ctx.params)
      const middlewareRouteId = ctx.get("middlewareRouteId");
      const paramsAvailableInMiddleware = ctx.get("paramsAvailableInMiddleware");
      return (
        <div data-testid="middleware-test-route-level-params">
          <Link to="/middleware-test" data-testid="back-link">
            ← Back to Middleware Tests
          </Link>
          <h1 data-testid="route-level-params-title">Route-Level Middleware with Params</h1>
          <p data-testid="route-level-params-description">
            Tests that ctx.params is available in route-level middleware.
          </p>
          <div data-testid="handler-route-id">
            Handler routeId: {ctx.params.routeId}
          </div>
          <div data-testid="middleware-route-id">
            Middleware routeId: {middlewareRouteId || "not set"}
          </div>
          <div data-testid="params-available">
            Params available in middleware: {paramsAvailableInMiddleware || "no"}
          </div>
        </div>
      );
    },
    { name: "routeLevelWithParams" },
    () => [
      // Route-level middleware that reads ctx.params
      middleware(async (ctx, next) => {
        // ctx.params should be typed with routeId from the route definition
        const routeId = ctx.params.routeId;
        ctx.set("middlewareRouteId", routeId);
        ctx.set("paramsAvailableInMiddleware", routeId ? "yes" : "no");
        await next();
        // Also set header with param value for HTTP-level verification
        ctx.header("X-Middleware-Route-Id", routeId);
      }),
    ]
  ),
]);
