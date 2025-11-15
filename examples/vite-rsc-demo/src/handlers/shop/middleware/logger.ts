import type { MiddlewareFn, GenericParams } from "rsc-router";

export const loggerMiddleware: MiddlewareFn<GenericParams, RSCRouter.Env>[] = [
  (ctx, next) => {
    console.log(`[Shop Middleware] Logger: ${ctx.pathname}`);
    next();
  },
];
