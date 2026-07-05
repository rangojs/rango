import { createRouter, nonce, type Middleware } from "@rangojs/router";
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
 * Top-level (app-wide) middleware, registered via `.use()`. It has no pattern,
 * so it runs on every route (global scope) and appears in the `debugPerformance`
 * timeline as `middleware:appTimer@*` — the `@*` marks it global, distinguishing
 * it from route-level `middleware()` (which prints as `middleware:*#n`). It
 * records a `:pre` segment (before `next()`) and, since it also does work after
 * `next()` resolves, a disjoint `:post` segment (here, stamping a response
 * header). Both phases merge into one `middleware:appTimer@*` row.
 */
const appTimer: Middleware = async (ctx, next) => {
  const start = Date.now();
  await next();
  ctx.headers.set("X-App-Response-Time", `${Date.now() - start}ms`);
};

/**
 * Build a Content-Security-Policy that permits the nonced GTM scripts and the
 * endpoints GTM/GA4 talk to. 'strict-dynamic' lets the nonced gtm.js loader
 * vouch for the scripts it injects at runtime; the wildcard googletagmanager.com
 * host is a fallback for browsers without strict-dynamic. Host allowances use
 * Google's documented wildcards (*.googletagmanager.com, *.google-analytics.com,
 * *.analytics.google.com) since GA4 talks to several regional/collection
 * subdomains, not just www. — see
 * https://developers.google.com/tag-platform/security/guides/csp. The inline
 * <style> in RootLayout is not nonced, so style-src allows 'unsafe-inline'.
 */
function buildCSPHeader(nonceValue: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonceValue}' 'strict-dynamic' https://*.googletagmanager.com`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com`,
    `font-src 'self'`,
    `connect-src 'self' https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com`,
    `frame-src https://*.googletagmanager.com`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ].join("; ");
}

/**
 * CSP middleware. Reads the per-request nonce the router generated (via the
 * `nonce` ContextVar token) and sets the policy on HTML responses.
 *
 * Keyed on BUILD MODE, not hostname: enforcing in a production build, Report-Only
 * in dev (so Vite's HMR client scripts, which are not nonced, are not blocked).
 * Hostname-keying would emit Report-Only even for the production build on
 * localhost — so the production e2e (which runs the build on localhost) would
 * never exercise the enforcing policy. import.meta.env.DEV is folded per build.
 */
const cspMiddleware: Middleware = async (ctx, next) => {
  await next();

  const contentType = ctx.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;

  const nonceValue = ctx.get(nonce);
  if (!nonceValue) return;

  const headerName = import.meta.env.DEV
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
  ctx.headers.set(headerName, buildCSPHeader(nonceValue));
};

/**
 * Create and configure the router with type-safe context.
 * All routes are defined using the Django-style urls() API.
 */
const router = createRouter<AppEnv>({
  debugPerformance: true,
  document: RootLayout,
  // Manual prefetch mode: keeps this suite's request-count/timing assertions
  // free of default-on viewport prefetch traffic. Default-on is dogfooded by
  // the router's e2e test-app; the opt-out seat by tests/cloudflare-basic.
  defaultPrefetch: "none",
  cache: { store: cacheStore },
  // Auto-generate a per-request CSP nonce, applied to React's bootstrap scripts
  // and consumable by userland head scripts (GTM) via useNonce().
  nonce: () => true,
})
  .use(appTimer)
  .use(cspMiddleware)
  .routes(urlpatterns);

/**
 * Export the router and type-safe reverse for server components.
 */
export { router };
export const reverse = router.reverse;
