import { createRSCRouter, type RouterEnv, redirect, type MiddlewareFn } from "rsc-router/server";
import { MemorySegmentCacheStore } from "rsc-router/rsc";
import { testRoutes } from "./routes.js";

// App-level cache store with defaults
export const cacheStore = new MemorySegmentCacheStore({
  defaults: { ttl: 60, swr: 120 },
});

export type AppEnv = RouterEnv<{}, {}>;

declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

/**
 * Global middleware - adds X-Global-Middleware header to all responses
 */
const globalMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
  const response = await next();
  response.headers.set("X-Global-Middleware", "applied");
  return response;
};

/**
 * Timing middleware - measures request duration and adds X-Request-Duration header
 */
const timingMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  ctx.res.headers.set("X-Request-Duration", String(duration));
};

/**
 * Auth middleware - pattern-based, only applies to /middleware-test/protected/*
 * Checks for auth cookie, redirects to /middleware-test if not authenticated
 */
const authMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
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
const errorMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
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
const cookieMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
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
const paramsMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
  // ctx.params contains extracted route params
  ctx.set("middlewareParams", ctx.params);
  await next();
  ctx.header("X-Middleware-Param-Id", ctx.params.id || "none");
};

/**
 * Header shorthand middleware - uses ctx.header() shorthand
 */
const headerShorthandMiddleware: MiddlewareFn<AppEnv> = async (ctx, next) => {
  await next();
  ctx.header("X-Header-Shorthand", "works");
};

export const router = createRSCRouter<AppEnv>()
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
  .routes(testRoutes)
  .map(() => import("./handlers.js"));

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const href = router.href;
