import type { RouteMiddlewareFn } from "@rangojs/router/server";
import type { shopRoutes } from "@/routes.js";

export const permissionsMiddleware: RouteMiddlewareFn<
  typeof shopRoutes,
  "shop.account.orders"
>[] = [
  (ctx, next) => {
    console.log("[Shop Middleware] Checking order view permissions");
    const user = ctx.get("user"); // Type-safe!
    if (user) {
      console.log(`[Shop Middleware] User ${user.name} can view orders`);
    }
    next();
  },
];
