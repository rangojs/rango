import type { Middleware } from "@rangojs/router/server";

export const loggerMiddleware: Middleware[] = [
  (ctx, next) => {
    console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
    next();
  },
];
