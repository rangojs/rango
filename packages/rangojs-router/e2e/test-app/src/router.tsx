import { createRouter, type RouterEnv, redirect, type Middleware } from "@rangojs/router/server";
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";
import { urlpatterns } from "./urls.js";

// App-level cache store with defaults
export const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 120 },
});

/**
 * App-level bindings (platform resources like DB, KV, etc.)
 */
export interface AppBindings {}

/**
 * App-level variables (middleware-injected context)
 * These are typed for ctx.get() and ctx.set() throughout the app
 */
export interface AppVariables {
  user?: { id: string; name: string };
  visitCount?: number;
  middlewareParams?: Record<string, string | undefined>;
  // Route-level middleware variables
  routeMiddlewareApplied?: string;
  middlewareRouteId?: string;
  paramsAvailableInMiddleware?: string;
}

export type AppEnv = RouterEnv<AppBindings, AppVariables>;

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

/**
 * Global middleware - adds X-Global-Middleware header to all responses
 * Note: Middleware defaults to RSCRouter.Env (via DefaultEnv) so no type parameter needed
 */
const globalMiddleware: Middleware = async (ctx, next) => {
  const response = await next();
  response.headers.set("X-Global-Middleware", "applied");
  return response;
};

/**
 * Timing middleware - measures request duration and adds X-Request-Duration header
 */
const timingMiddleware: Middleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  ctx.res.headers.set("X-Request-Duration", String(duration));
};

/**
 * Auth middleware - pattern-based, only applies to /middleware-test/protected/*
 * Checks for auth cookie, redirects to /middleware-test if not authenticated
 */
const authMiddleware: Middleware = async (ctx, next) => {
  const authToken = ctx.cookie("auth-token");
  if (!authToken) {
    // Set a header to indicate redirect happened (for test verification)
    return redirect("/middleware-test?auth=required", 302);
  }
  // Set user info in context for handlers
  ctx.set("user", { id: "123", name: "TestUser" });
  await next();
};

/**
 * Error handling middleware - catches errors and returns custom error response
 * Only applies to /middleware-test/error-handler/*
 */
const errorMiddleware: Middleware = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx.res.headers.set("X-Error-Caught", "true");
    ctx.res.headers.set("X-Error-Message", message);
    return new Response(`Error caught by middleware: ${message}`, {
      status: 500,
      headers: { "X-Error-Caught": "true", "X-Error-Message": message },
    });
  }
};

/**
 * Cookie middleware - sets a response cookie
 * Only applies to /middleware-test/cookies
 */
const cookieMiddleware: Middleware = async (ctx, next) => {
  // Read existing cookie
  const visitCount = parseInt(ctx.cookie("visit-count") || "0", 10);

  // Set updated cookie
  ctx.setCookie("visit-count", String(visitCount + 1), {
    path: "/",
    maxAge: 60 * 60 * 24, // 1 day
  });

  // Make visit count available to handler
  ctx.set("visitCount", visitCount + 1);

  await next();
};

/**
 * Params middleware - extracts params from pattern
 * Pattern: /middleware-test/params/:id
 */
const paramsMiddleware: Middleware = async (ctx, next) => {
  // ctx.params contains extracted route params
  ctx.set("middlewareParams", ctx.params);
  await next();
  ctx.header("X-Middleware-Param-Id", ctx.params.id || "none");
};

/**
 * Header shorthand middleware - uses ctx.header() shorthand
 */
const headerShorthandMiddleware: Middleware = async (ctx, next) => {
  await next();
  ctx.header("X-Header-Shorthand", "works");
};

export const router = createRouter<AppEnv>({
  cache: { store: cacheStore },
  theme: {
    defaultTheme: "system",
    themes: ["light", "dark", "system"],
    attribute: "class",
    storageKey: "theme",
    enableSystem: true,
    enableColorScheme: true,
  },
})
  // Global middleware - applied to ALL routes
  .use(globalMiddleware)
  .use(timingMiddleware)
  .use(headerShorthandMiddleware)
  // Pattern-based middleware for protected routes
  .use("/middleware-test/protected/*", authMiddleware)
  // Pattern-based middleware for error handling routes
  .use("/middleware-test/error-handler/*", errorMiddleware)
  // Pattern-based middleware for cookie routes
  .use("/middleware-test/cookies", cookieMiddleware)
  // Pattern-based middleware with params
  .use("/middleware-test/params/:id", paramsMiddleware)
  .routes(urlpatterns);

export const href = router.href;
