import type { MiddlewareFn, GenericParams } from "rsc-router";

export const loggerMiddleware: MiddlewareFn<GenericParams, RSCRouter.Env>[] = [
  (_ctx, next) => {
    console.log("Blog route accessed");
    next();
  },
];
