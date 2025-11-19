import type { MiddlewareFn, RouteMiddlewareFn, GenericParams } from "rsc-router/server";
import type { shopRoutes } from "@/routes.js";

/**
 * Mock authentication middleware - adds a mock user to context
 */
export const mockAuthMiddleware: MiddlewareFn<
  GenericParams,
  RSCRouter.Env
>[] = [
  (ctx, next) => {
    // Simulate authentication - add mock user to context (type-safe!)
    console.log("[Shop Middleware] Auth: Adding mock user to context");
    ctx.set("user", {
      id: "user-123",
      name: "John Doe",
      email: "john@example.com",
    });
    next();
  },
];

/**
 * Require authentication middleware - checks for user in context
 */
export const requireAuthMiddleware: RouteMiddlewareFn<
  typeof shopRoutes,
  "checkout.index"
>[] = [
  (ctx, next) => {
    console.log("[Shop Middleware] Auth check");
    const user = ctx.get("user"); // Type-safe!
    if (!user) {
      console.error("[Shop Middleware] No user - would redirect to login");
      // In real app: throw new Error('Unauthorized') or redirect
    }
    next();
  },
];
