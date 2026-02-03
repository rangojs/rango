import { createRSCRouter, type RouterEnv } from "@rangojs/router/server";
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";
import { RootLayout } from "./layouts/RootLayout.js";

// Create cache store with defaults (persists across HMR via globalThis)
const cacheStore = new MemorySegmentCacheStore({
  defaults: {
    ttl: 600000, // Default TTL for all cache() boundaries (~7 days)
  },
});

// Django-style URL patterns (new API)
import { urlpatterns } from "./urls.js";

// Legacy route imports (for shop - complex route with many loaders)
import { shopRoutes } from "./routes.js";

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
    email?: string;
  };
  permissions?: string[];
  requestId?: string;
  requestCount?: number;
  rateLimitRemaining?: number;
  responseTime?: string;
  enrichedUser?: {
    id: string;
    name: string;
    role: string;
  };
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
 *
 * Uses Django-style urls() API for most routes, with legacy .routes().map()
 * pattern for shop (which has complex loader requirements).
 */
const router = createRSCRouter<AppEnv>({
  debugPerformance: true,
  document: RootLayout,
  cache: { store: cacheStore },
})
  // Django-style URL patterns (new API) - defines routes with handlers inline
  .routes(urlpatterns)

  // Shop uses legacy pattern due to complex loader/intercept structure
  .routes("/shop", shopRoutes)
  .map(() => import("./handlers/shop.js"));

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
 * Export the router and type-safe href.
 * Import href from here for type safety: `import { href } from "./router.js"`
 */
export { router };
export const href = router.href;

console.log("[Router] Configured with urls() API + shop routes");
