/**
 * Middleware chain for representative per-request load.
 *
 * Global middleware (router.use in router.tsx) wraps EVERY request including
 * server actions; route middleware (middleware() in urls.tsx) wraps render
 * passes. Every consumer app pays a chain like this on each request — a
 * stress app benching a router with an empty middleware chain understates
 * per-request cost.
 */
import type { Middleware } from "@rangojs/router";

/** Global: request identity, the ctx.set every real app starts with. */
export const requestIdMiddleware: Middleware = (ctx, next) => {
  ctx.set("requestId", crypto.randomUUID());
  return next();
};

/** Global: cookie parse + session variable (auth-shaped work). */
export const sessionMiddleware: Middleware = (ctx, next) => {
  const cookie = ctx.request.headers.get("cookie") ?? "";
  const match = cookie.match(/bench_session=([^;]+)/);
  ctx.set("sessionId", match ? match[1] : "anonymous");
  return next();
};

/** Global: response header on the way out (post-next side effect). */
export const securityHeadersMiddleware: Middleware = async (ctx, next) => {
  await next();
  ctx.headers.set("X-Frame-Options", "DENY");
  ctx.headers.set("X-Content-Type-Options", "nosniff");
};

/** Route-level: wraps every render pass, measures render duration. */
export const renderTimingMiddleware: Middleware = async (ctx, next) => {
  const start = performance.now();
  await next();
  ctx.headers.set("X-Render-Ms", (performance.now() - start).toFixed(1));
};

/** Route-level: accept-language parse (locale-shaped work). */
export const acceptLanguageMiddleware: Middleware = (ctx, next) => {
  const accept = ctx.request.headers.get("accept-language") ?? "";
  ctx.set("locale", accept.split(",")[0]?.split("-")[0] || "en");
  return next();
};
