import { createRouter, nonce, type Middleware } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";
import type { AppBindings } from "./env.js";

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
 * auto-generated nonce from the RSC handler (accessed via ctx.get(nonce) token).
 *
 * - In development: Uses Report-Only mode to avoid blocking HMR scripts
 * - In production: Uses enforcing CSP
 */
const cspMiddleware: Middleware = async (ctx, next) => {
  await next();

  // Only add CSP to HTML responses
  const contentType = ctx.res.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    return;
  }

  // Get the nonce from context var token (set by router when nonce option is used)
  const nonceValue = ctx.get(nonce);
  if (!nonceValue) {
    return;
  }

  // Use Report-Only in dev mode to avoid blocking HMR scripts
  // Use enforcing CSP in production
  const cspHeaderName = isDevelopment(ctx.url)
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";

  ctx.res.headers.set(cspHeaderName, buildCSPHeader(nonceValue));
};

// Create the router with document component
// Document wraps both route content and error boundaries,
// preventing the document from unmounting during errors (avoids FOUC)
export const router = createRouter<AppBindings>({
  document: Document,
  // Auto-generate a cryptographic nonce for each request (for CSP)
  nonce: () => true,
})
  // CSP middleware - adds Content-Security-Policy headers to all HTML responses
  .use(cspMiddleware)
  // Register all routes
  .routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// Export typed reverse function for use in server components
export const reverse = router.reverse;
