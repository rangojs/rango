import type { Middleware, GenericParams } from "@rangojs/router/server";

export const loggerMiddleware: Middleware<RSCRouter.Env, GenericParams>[] = [
  (_ctx, next) => {
    console.log("Blog route accessed");
    next();
  },
];
