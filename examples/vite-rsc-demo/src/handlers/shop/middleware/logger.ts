import type { MiddlewareFn } from "@ivogt/rsc-router/server";

export const loggerMiddleware: MiddlewareFn[] = [
  (ctx, next) => {
    console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
    next();
  },
];
