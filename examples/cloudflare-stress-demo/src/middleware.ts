/**
 * Timing middleware - captures request start time
 */
import type { MiddlewareFn } from "@rangojs/router";
import type { AppEnv } from "./env.js";

export const timingMiddleware: MiddlewareFn<AppEnv> = (ctx, next) => {
  ctx.set("requestStart", performance.now());
  return next();
};
