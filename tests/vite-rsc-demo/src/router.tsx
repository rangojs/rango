import { createRouter } from "@rangojs/router";
import { MemorySegmentCacheStore } from "@rangojs/router/cache";
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
  // Plain environment variables (available in any deployment target).
  // Declaring at least one member is what makes `ctx.env` / `Rango.Env`
  // a concrete type instead of the unaugmented `unknown` fallback.
  APP_NAME?: string;
  // Example platform bindings for Cloudflare Workers:
  // DB?: D1Database;
  // KV?: KVNamespace;
  // STRIPE_KEY?: string;
}

/**
 * Middleware-injected variables (user, permissions, etc.)
 * Accessed via ctx.get('key')
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

export type AppEnv = AppBindings;

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface Env extends AppBindings {}
    interface Vars extends AppVariables {}
    interface RegisteredRoutes extends AppRoutes {}
  }
}

/**
 * Create and configure the router with type-safe context.
 * All routes are defined using the Django-style urls() API.
 */
const router = createRouter<AppEnv>({
  debugPerformance: true,
  document: RootLayout,
  cache: { store: cacheStore },
}).routes(urlpatterns);

/**
 * Export the router and type-safe reverse for server components.
 */
export { router };
export const reverse = router.reverse;
