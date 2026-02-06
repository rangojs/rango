import type { Middleware } from "@rangojs/router/server";

export const permissionsMiddleware: Middleware[] = [
  (ctx, next) => {
    console.log("[Shop Middleware] Checking order view permissions");
    const user = ctx.get("user"); // Type-safe!
    if (user) {
      console.log(`[Shop Middleware] User ${user.name} can view orders`);
    }
    next();
  },
];
