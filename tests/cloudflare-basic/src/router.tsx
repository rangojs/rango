import { createRouter } from "@rangojs/router";
import {
  createDocumentCacheMiddleware,
  CFCacheStore,
} from "@rangojs/router/cache";
import { createCloudflareTracing } from "@rangojs/router/cloudflare";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppBindings } from "./env.js";
import { onErrorLog } from "./error-log.js";

// Create the router with document component
// Document is a server component that wraps the HTML shell
// Navigation is handled by NavLayout in urls.tsx
export const router = createRouter<AppBindings>({
  document: Document,
  // Test app only: emit the X-Rango-Cache debug header so the consumer
  // cache-status primitives (assertCacheStatus/parseCacheHeader) can be
  // exercised against a real response in e2e (see e2e/cache-signal.test.ts).
  // The header is additive; never enable this in a real production app.
  debugCacheSignal: true,
  // Cloudflare custom spans: emit "rango.*" spans for the request/middleware/
  // loader/render/ssr phases. On a tracing-enabled deployment these show up in
  // the Workers trace waterfall; here they are also exercised in e2e via the
  // ?__trace_debug recording tracer injected by the worker entry. When the
  // runtime provides no executionContext.tracing (the default), every span call
  // is a transparent pass-through.
  tracing: createCloudflareTracing(),
  // Enable theme support with system detection
  theme: {
    defaultTheme: "light",
    themes: ["light", "dark", "system"],
    attribute: "class",
    storageKey: "theme",
    enableSystem: true,
    enableColorScheme: true,
  },
  // CF cache store with L1 (Cache API) + L2 (KV) for cross-colo persistence
  cache: (env, ctx) => ({
    store: new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      ctx: ctx!, // Always provided in Cloudflare Workers
      kv: env.KV, // KV L2 for global persistence
    }),
  }),
  onError: (ctx) => {
    console.error("Router error ctx:", ctx);
    console.error("Router error:", ctx.error.stack || ctx.error);
    // Test-only: record { phase, message } so the redirect onError e2e can
    // read it back via /__test/last-error. The console.error above is kept so
    // a real consumer's logging path stays exercised.
    onErrorLog.push({ phase: ctx.phase, message: ctx.error.message });
  },
})
  // Document cache middleware - caches full responses based on Cache-Control headers
  .use(createDocumentCacheMiddleware())
  // Regression repro: top-level middleware throwing a Response must short-circuit
  // under miniflare the same way it does on Node — before the fix, the throw
  // leaked past executeMiddleware and miniflare stringified it as 500.
  .use("/__test/global-mw-throw-response", async () => {
    throw new Response("throw-response-body", {
      status: 418,
      headers: { "x-throw-response": "applied" },
    });
  })
  // Sanity repro: returning a Response from top-level middleware. Already
  // worked pre-fix via middleware.ts short-circuit. Paired with the throw
  // case so the contrast is verified under miniflare.
  .use("/__test/global-mw-return-response", async () => {
    return new Response("return-response-body", {
      status: 418,
      headers: { "x-return-response": "applied" },
    });
  })
  // Register all routes
  .routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// Export typed reverse function for use in server components
export const reverse = router.reverse;

// ---------- Type-level verification ----------
// These assertions verify Rango.PathResponse resolves correctly from the single RegisteredRoutes registry.
// They produce compile errors if the types regress — do not remove.
// Rango.PathResponse is ambient (no import).

// Rango.PathResponse resolves to the bare serialized success payload (the
// handler's return value verbatim). Errors arrive out-of-band as non-2xx
// problem+json responses, so they are not part of this type.
type _HealthResponse = Rango.PathResponse<"/api/health">;
type _AssertHealthData = _HealthResponse extends {
  status: string;
  timestamp: number;
}
  ? true
  : never;
const _checkHealth: _AssertHealthData = true;

type _ProductsResponse = Rango.PathResponse<"/api/products">;
type _AssertProductsData =
  _ProductsResponse extends Array<{
    id: string;
    name: string;
    price: number;
  }>
    ? true
    : never;
const _checkProducts: _AssertProductsData = true;

type _ProductDetailResponse = Rango.PathResponse<"/api/products/:id">;
type _AssertProductDetailData = _ProductDetailResponse extends {
  id: string;
  name: string;
  price: number;
  description: string;
}
  ? true
  : never;
const _checkProductDetail: _AssertProductDetailData = true;

// Unified lookup: a concrete path resolves the same payload as its pattern.
type _ProductByConcretePath = Rango.PathResponse<"/api/products/42">;
type _AssertProductByPath = _ProductByConcretePath extends {
  id: string;
  name: string;
  price: number;
  description: string;
}
  ? true
  : never;
const _checkProductByPath: _AssertProductByPath = true;

// Response routes are also valid paths for href()
type _AssertApiHealthIsValid = "/api/health" extends Rango.Path ? true : never;
const _checkValidPath: _AssertApiHealthIsValid = true;
