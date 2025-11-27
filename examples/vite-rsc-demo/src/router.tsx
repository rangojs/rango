import { createRSCRouter, type RouterEnv } from "rsc-router/server";
import {
  homeRoutes,
  blogRoutes,
  aboutRoutes,
  dashboardRoutes,
  shopRoutes,
  adminRoutes,
  protectedRoutes,
  todosRoutes,
} from "./routes.js";

/**
 * Platform bindings (Cloudflare Workers, environment variables, etc.)
 * Accessed via ctx.env
 */
export interface AppBindings {
  // Example for Cloudflare Workers:
  // DB?: D1Database;
  // KV?: KVNamespace;
  // STRIPE_KEY?: string;
}

/**
 * Middleware-injected variables (user, permissions, etc.)
 * Accessed via ctx.var or ctx.get('key')
 */
export interface AppVariables {
  user?: {
    id: string;
    name: string;
    email: string;
  };
  permissions?: string[];
  requestId?: string;
  requestCount?: number;
  rateLimitRemaining?: number;
}

/**
 * Combined app environment (Hono-inspired type-safe context)
 */
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

/**
 * Module augmentation - makes AppEnv available globally in all handlers
 * This allows handlers to have type-safe context without importing AppEnv
 */
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

/**
 * Create and configure the router with type-safe context.
 * Route types are accumulated through the builder chain.
 */
const router = createRSCRouter<AppEnv>({ debugPerformance: true })
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes("/blog", blogRoutes) // Mount blog routes at /blog prefix
  .map(() => import("./handlers/blog.js"))

  .routes("", aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes("/dashboard", dashboardRoutes) // Dashboard with parallel routes
  .map(() => import("./handlers/dashboard.js"))

  .routes("/shop", shopRoutes) // Shop - comprehensive ecommerce example
  .map(() => import("./handlers/shop.js"))

  .routes("/admin", adminRoutes) // Admin - demonstrates soft/hard revalidation
  .map(() => import("./handlers/admin.js"))

  .routes("/protected", protectedRoutes) // Protected - demonstrates middleware short-circuit
  .map(() => import("./handlers/protected.js"))

  .routes("/todos", todosRoutes) // Todos - demonstrates loaders, actions, streaming
  .map(() => import("./handlers/todos.js"));

/**
 * Extract route types directly from the router chain
 */
type AppRoutes = typeof router.routeMap;

/**
 * Module augmentation - register types globally for type-safe href
 */
declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

/**
 * Export the router.
 * Type-safe href is available via `import { href } from "rsc-router/browser"`
 */
export { router };

console.log("[Router] Configured with 8 route groups (lazy-loaded handlers)");
