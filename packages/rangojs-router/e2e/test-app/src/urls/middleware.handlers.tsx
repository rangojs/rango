import type { Handler } from "@rangojs/router";
import { Link } from "@rangojs/router/client";

export const MiddlewareProtectedHandler: Handler<"middlewareTest.protected"> = (
  ctx,
) => {
  // Get user from middleware-set context variable
  const user = ctx.get("user");
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
};

export const MiddlewareIndexHandler: Handler<"middlewareTest.index"> = (
  ctx,
) => {
  // Check if redirected from protected route
  const authRequired = ctx.url.searchParams.get("auth") === "required";
  return (
    <div data-testid="middleware-test-index">
      <Link to="/" data-testid="back-link">
        ← Back to Home
      </Link>
      <h1 data-testid="middleware-test-title">Middleware Tests</h1>
      {authRequired && (
        <p data-testid="auth-required-message">
          Authentication required. Please login.
        </p>
      )}
      <nav data-testid="middleware-test-nav">
        <ul>
          <li>
            <Link to="/middleware-test/protected" data-testid="protected-link">
              Protected Route (requires auth)
            </Link>
          </li>
          <li>
            <Link
              to="/middleware-test/protected/dashboard"
              data-testid="protected-dashboard-link"
            >
              Protected Dashboard
            </Link>
          </li>
          <li>
            <Link
              to="/middleware-test/error-handler/trigger"
              data-testid="error-handler-link"
            >
              Error Handler Test
            </Link>
          </li>
          <li>
            <Link to="/middleware-test/cookies" data-testid="cookies-link">
              Cookie Test
            </Link>
          </li>
          <li>
            <Link
              to="/middleware-test/params/test-123"
              data-testid="params-link"
            >
              Params Test (id=test-123)
            </Link>
          </li>
          <li>
            <Link
              to="/middleware-test/shared-vars"
              data-testid="shared-vars-link"
            >
              Shared Variables Test
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  );
};

export const MiddlewareProtectedDashboardHandler: Handler<
  "middlewareTest.protectedDashboard"
> = (ctx) => {
  const user = ctx.get("user");
  return (
    <div data-testid="middleware-test-protected-dashboard">
      <Link to="/middleware-test" data-testid="back-link">
        ← Back to Middleware Tests
      </Link>
      <h1 data-testid="dashboard-title">Protected Dashboard</h1>
      {user && <p data-testid="dashboard-user">Welcome, {user.name}!</p>}
    </div>
  );
};

export const MiddlewareErrorHandlerHandler: Handler<
  "middlewareTest.errorHandler"
> = () => {
  throw new Error("Test error from handler");
  return <div data-testid="error-handler-page">This should never render</div>;
};

export const MiddlewareCookiesHandler: Handler<"middlewareTest.cookies"> = (
  ctx,
) => {
  const visitCount = ctx.get("visitCount");
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
};

export const MiddlewareParamsHandler: Handler<"middlewareTest.params"> = (
  ctx,
) => {
  const middlewareParams = ctx.get("middlewareParams");
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
};

export const MiddlewareSharedVarsHandler: Handler<
  "middlewareTest.sharedVars"
> = () => (
  <div data-testid="middleware-test-shared-vars">
    <Link to="/middleware-test" data-testid="back-link">
      ← Back to Middleware Tests
    </Link>
    <h1 data-testid="shared-vars-title">Shared Variables Test</h1>
    <p data-testid="shared-vars-description">
      This page tests that middleware can share variables with handlers via
      ctx.set/get.
    </p>
  </div>
);

export const MiddlewareRouteShortcircuitHandler: Handler<
  "middlewareTest.routeShortcircuit"
> = () => (
  <div data-testid="middleware-test-route-shortcircuit">
    <h1>This should never render (middleware short-circuits)</h1>
  </div>
);

export const MiddlewareRouteLevelHandler: Handler<
  "middlewareTest.routeLevel"
> = (ctx) => {
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
};

export const MiddlewareW5RedirectHandler: Handler<
  "middlewareTest.w5Redirect"
> = () => (
  <div data-testid="middleware-test-w5-redirect">
    <h1>This should never render (middleware redirects)</h1>
  </div>
);

export const MiddlewareRouteLevelWithParamsHandler: Handler<
  "middlewareTest.routeLevelWithParams"
> = (ctx) => {
  // Read variables set by route-level middleware (which read from ctx.params)
  const middlewareRouteId = ctx.get("middlewareRouteId");
  const paramsAvailableInMiddleware = ctx.get("paramsAvailableInMiddleware");
  return (
    <div data-testid="middleware-test-route-level-params">
      <Link to="/middleware-test" data-testid="back-link">
        ← Back to Middleware Tests
      </Link>
      <h1 data-testid="route-level-params-title">
        Route-Level Middleware with Params
      </h1>
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
};
