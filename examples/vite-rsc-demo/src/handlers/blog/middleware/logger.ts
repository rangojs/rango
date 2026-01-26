import type { MiddlewareFn, GenericParams } from "@ivogt/rsc-router/server";

export const loggerMiddleware: MiddlewareFn<RSCRouter.Env, GenericParams>[] = [
  (_ctx, next) => {
    console.log("Blog route accessed");
    next();
  },
];
