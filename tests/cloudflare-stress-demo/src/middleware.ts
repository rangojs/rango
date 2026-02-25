/**
 * Timing middleware - captures request start time
 */
import type { Middleware } from "@rangojs/router";

export const timingMiddleware: Middleware = (ctx, next) => {
  ctx.set("requestStart", performance.now());
  return next();
};
