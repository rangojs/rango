import { urls, getRequestContext, redirect, cookies } from "@rangojs/router";
import {
  MiddlewareIndexHandler,
  MiddlewareProtectedHandler,
  MiddlewareProtectedDashboardHandler,
  MiddlewareErrorHandlerHandler,
  MiddlewareCookiesHandler,
  MiddlewareCookiesAfterNextHandler,
  MiddlewareRouteCookiesAfterNextHandler,
  MiddlewareParamsHandler,
  MiddlewareSharedVarsHandler,
  MiddlewareRouteLevelHandler,
  MiddlewareRouteLevelWithParamsHandler,
  MiddlewareRouteShortcircuitHandler,
  MiddlewareW5RedirectHandler,
} from "./middleware.handlers.js";

/**
 * Middleware test routes URL patterns
 * Routes: middlewareTest.*
 */
export const middlewarePatterns = urls(({ path, middleware }) => [
  path("/", MiddlewareIndexHandler, { name: "index" }),
  path("/protected", MiddlewareProtectedHandler, { name: "protected" }),
  path("/protected/dashboard", MiddlewareProtectedDashboardHandler, {
    name: "protectedDashboard",
  }),
  path("/error-handler/trigger", MiddlewareErrorHandlerHandler, {
    name: "errorHandler",
  }),
  path("/cookies", MiddlewareCookiesHandler, { name: "cookies" }),
  path("/params/:paramId", MiddlewareParamsHandler, { name: "params" }),
  path("/shared-vars", MiddlewareSharedVarsHandler, { name: "sharedVars" }),

  // Test: cookies set after await next() in top-level (global) middleware —
  // the middleware that sets the cookies is registered in router.tsx.
  path("/cookies-after-next", MiddlewareCookiesAfterNextHandler, {
    name: "cookiesAfterNext",
  }),

  // Test: cookies set after await next() in route-level middleware
  path(
    "/route-cookies-after-next",
    MiddlewareRouteCookiesAfterNextHandler,
    { name: "routeCookiesAfterNext" },
    () => [
      middleware(async (_ctx, next) => {
        await next();
        cookies().set("route_session", "xyz789", { path: "/", httpOnly: true });
        cookies().set("route-post-next", "applied", { path: "/" });
      }),
    ],
  ),

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
    ],
  ),

  // Route-shortcircuit: first middleware registers onResponse callback, second
  // short-circuits with 403. Tests that onResponse callbacks survive route-
  // level middleware short-circuits (finalizeResponse at handler.ts:759).
  path(
    "/route-shortcircuit",
    MiddlewareRouteShortcircuitHandler,
    { name: "routeShortcircuit" },
    () => [
      middleware(async (_ctx, next) => {
        const reqCtx = getRequestContext();
        reqCtx?.onResponse((response) => {
          const headers = new Headers(response.headers);
          headers.set("X-Route-OnResponse", "applied");
          return new Response(response.body, {
            status: response.status,
            headers,
          });
        });
        await next();
      }),
      middleware(async () => {
        return new Response("blocked", { status: 403 });
      }),
    ],
  ),

  // W5 guardrail test: middleware calls ctx.set() then returns a redirect.
  // Should trigger a dev-mode warning about lost context variables.
  path(
    "/w5-redirect",
    MiddlewareW5RedirectHandler,
    { name: "w5Redirect" },
    () => [
      middleware(async function w5SetThenRedirect(ctx) {
        ctx.set("user", { id: "lost", name: "lost" });
        return redirect("/middleware-test", 302);
      }),
    ],
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
    ],
  ),
]);
