import { urls } from "@rangojs/router";
import {
  MiddlewareIndexHandler,
  MiddlewareProtectedHandler,
  MiddlewareProtectedDashboardHandler,
  MiddlewareErrorHandlerHandler,
  MiddlewareCookiesHandler,
  MiddlewareParamsHandler,
  MiddlewareSharedVarsHandler,
  MiddlewareRouteLevelHandler,
  MiddlewareRouteLevelWithParamsHandler,
} from "./middleware.handlers.js";

/**
 * Middleware test routes URL patterns
 * Routes: middlewareTest.*
 */
export const middlewarePatterns = urls(({ path, middleware }) => [
  path("/", MiddlewareIndexHandler, { name: "index" }),
  path("/protected", MiddlewareProtectedHandler, { name: "protected" }),
  path("/protected/dashboard", MiddlewareProtectedDashboardHandler, { name: "protectedDashboard" }),
  path("/error-handler/trigger", MiddlewareErrorHandlerHandler, { name: "errorHandler" }),
  path("/cookies", MiddlewareCookiesHandler, { name: "cookies" }),
  path("/params/:paramId", MiddlewareParamsHandler, { name: "params" }),
  path("/shared-vars", MiddlewareSharedVarsHandler, { name: "sharedVars" }),

  path(
    "/route-level",
    MiddlewareRouteLevelHandler,
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

  path(
    "/route-level/:routeId",
    MiddlewareRouteLevelWithParamsHandler,
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
