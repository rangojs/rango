import type { Middleware } from "@rangojs/router/server";

export const loggerMiddleware: Middleware[] = [
  (_ctx, next) => {
    console.log("Blog route accessed");
    next();
  },
];
