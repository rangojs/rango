import { createRSCRouter, type RouterEnv, type AppMiddlewareFn } from "@ivogt/rsc-router/server";
import { homeRoutes, aboutRoutes, counterRoutes } from "./routes.js";
import { AppShell } from "./components/AppShell.js";

// Cloudflare Workers bindings (D1, KV, etc.)
export interface AppBindings {
  // Add your bindings here:
  // DB?: D1Database;
  // KV?: KVNamespace;
}

// Middleware-injected variables
export interface AppVariables {
  requestId?: string;
}

// Combined app environment
export type AppEnv = RouterEnv<AppBindings, AppVariables>;

// Module augmentation for global type inference
declare global {
  namespace RSCRouter {
    interface Env extends AppEnv {}
  }
}

/**
 * Build CSP header with nonce for script-src
 */
function buildCSPHeader(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`, // Inline styles for demo simplicity
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join("; ");
}

/**
 * Detect development mode by checking hostname
 */
function isDevelopment(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1";
}

/**
 * CSP Middleware
 *
 * Adds Content-Security-Policy headers to HTML responses using the
 * auto-generated nonce from the RSC handler (accessed via ctx.get('nonce')).
 *
 * - In development: Uses Report-Only mode to avoid blocking HMR scripts
 * - In production: Uses enforcing CSP
 */
const cspMiddleware: AppMiddlewareFn<AppEnv> = async (ctx, next) => {
  await next();

  // Only add CSP to HTML responses
  const contentType = ctx.res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return;
  }

  // Get the nonce from shared variables (set by createRSCHandler when nonce option is used)
  const nonce = ctx.get("nonce");
  if (!nonce) {
    return;
  }

  // Use Report-Only in dev mode to avoid blocking HMR scripts
  // Use enforcing CSP in production
  const cspHeaderName = isDevelopment(ctx.url)
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  ctx.res.headers.set(cspHeaderName, buildCSPHeader(nonce));
};

// Create the router with document component
// AppShell wraps both route content and error boundaries,
// preventing the app shell from unmounting during errors (avoids FOUC)
export const router = createRSCRouter<AppEnv>({
  document: AppShell,
})
  // CSP middleware - adds Content-Security-Policy headers to all HTML responses
  .use(cspMiddleware);

// Register routes with lazy-loaded handlers
router
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes(aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes(counterRoutes)
  .map(() => import("./handlers/counter.js"));

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
