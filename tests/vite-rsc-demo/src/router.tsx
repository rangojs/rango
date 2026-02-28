import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/rsc";
import { RootLayout } from "./layouts/RootLayout.js";

// Create cache store with defaults (persists across HMR via globalThis)
const cacheStore = new MemorySegmentCacheStore({
  defaults: {
    ttl: 600000, // Default TTL for all cache() boundaries (~7 days)
  },
});

// Django-style URL patterns (composed from separate modules)
import { urlpatterns } from "./urls/index.js";

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
 * Module augmentation - makes bindings and vars available globally in all handlers
 * This allows handlers to have type-safe context without importing types
 */
type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
    interface RegisteredRoutes extends AppRoutes {}
  }
}

/**
 * Create and configure the router with type-safe context.
 * All routes are defined using the Django-style urls() API.
 */
const router = createRouter<AppBindings>({
  debugPerformance: true,
  document: RootLayout,
  cache: { store: cacheStore },
}).routes(urlpatterns);

/**
 * Export the router and type-safe reverse for server components.
 */
export { router };
export const reverse = router.reverse;
