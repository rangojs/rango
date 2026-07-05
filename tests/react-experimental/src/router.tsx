import { createRouter, nonce, type Middleware } from "@rangojs/router";
import { urlpatterns } from "./urls.js";
import { Document } from "./components/Document.js";
import type { AppEnv } from "./env.js";

/**
 * CSP middleware. Verifies the GTM/nonce integration under experimental React:
 * router.fetch self-wires the nonce provider, so ctx.get(nonce) is populated and
 * the same nonce stamped on the GTM head scripts is named in the policy.
 * Report-Only on localhost (dev + preview) so HMR is not blocked.
 */
function buildCSPHeader(nonceValue: string): string {
  // Google's documented wildcard hosts (CSP guide) — GA4 talks to several
  // subdomains, not just www.
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonceValue}' 'strict-dynamic' https://*.googletagmanager.com`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com`,
    `connect-src 'self' https://*.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com`,
    `frame-src https://*.googletagmanager.com`,
    `object-src 'none'`,
    `base-uri 'self'`,
  ].join("; ");
}

const cspMiddleware: Middleware = async (ctx, next) => {
  await next();
  const contentType = ctx.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return;
  const nonceValue = ctx.get(nonce);
  if (!nonceValue) return;
  // Keyed on build mode (not hostname) so the production build enforces CSP even
  // on the localhost e2e preview; Report-Only in dev so HMR is not blocked.
  ctx.headers.set(
    import.meta.env.DEV
      ? "Content-Security-Policy-Report-Only"
      : "Content-Security-Policy",
    buildCSPHeader(nonceValue),
  );
};

export const router = createRouter<AppEnv>({
  document: Document,
  // Manual prefetch mode: keeps this suite's request assertions free of
  // default-on viewport prefetch traffic (default-on is dogfooded by the
  // router's e2e test-app).
  defaultPrefetch: "none",
  // Auto-generate a per-request CSP nonce (self-wired into router.fetch).
  nonce: () => true,
  // Test hook: the view-transition-optout e2e builds the app with
  // VITE_RANGO_VT=false to exercise the global createRouter({ viewTransition })
  // default end to end (createRouter -> segment resolution -> client gate).
  // Defaults to "auto" so every other test sees unchanged behavior.
  viewTransition: import.meta.env.VITE_RANGO_VT === "false" ? false : "auto",
})
  .use(cspMiddleware)
  .routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

export const reverse = router.reverse;
