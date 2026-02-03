import type { MiddlewareFn } from "@rangojs/router/server";

export const loggerMiddleware: MiddlewareFn[] = [
  (ctx, next) => {
    console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
    next();
  },
];
