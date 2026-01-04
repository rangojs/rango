import type { AppMiddlewareFn } from "rsc-router/server";

export const loggerMiddleware: AppMiddlewareFn[] = [
  (ctx, next) => {
    console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
    next();
  },
];
