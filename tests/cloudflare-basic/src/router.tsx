import { createRouter } from "@rangojs/router";
import type { TimeoutContext } from "@rangojs/router";
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
  // Non-default prefetch limits so the e2e can pin that configured values reach
  // the client payload metadata through a real Cloudflare build (defaults are
  // size 100 / concurrency 2).
  prefetchCacheSize: 25,
  prefetchConcurrency: 3,
  // Manual prefetch mode: this app dogfoods the explicit opt-out seat. In
  // production this overrides the environment's viewport default; per-Link
  // strategies still opt in (e2e/default-prefetch-none.test.ts).
  defaultPrefetch: "none",
  // Render-timeout diagnostics fixture (e2e/render-timeout-stage.test.ts). Gated
  // behind RANGO_E2E_RENDER_TIMEOUT (inlined by vite.config.ts `define`, set on
  // the e2e webServers in playwright.config.ts) so the 15s render-start deadline
  // + onTimeout bookkeeping applies ONLY under the e2e run — never on a real
  // `vite dev`/`preview`/`wrangler deploy`, and never on the vitest unit suite
  // (which builds its own router). Router-level `timeouts` cannot be scoped
  // per-test on the shared e2e webServer, so all e2e requests see the 15s
  // deadline; that is well above any healthy request and never reaches a deploy.
  ...(process.env.RANGO_E2E_RENDER_TIMEOUT
    ? {
        timeouts: { renderStartMs: 15000 },
        onTimeout: (context: TimeoutContext<AppBindings>) =>
          new Response(JSON.stringify(context.render ?? null), {
            status: 504,
            headers: { "content-type": "application/json;charset=utf-8" },
          }),
      }
    : {}),
  ssr: {
    resolveStreaming: async ({ url }) => {
      // Same gate as the timeouts above: the 20s stall that trips the render
      // deadline only arms under the e2e flag, so `?__render_timeout_stage` is
      // inert on a real deploy.
      if (
        process.env.RANGO_E2E_RENDER_TIMEOUT &&
        url.searchParams.has("__render_timeout_stage")
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
      return "stream" as const;
    },
  },
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
  // Short-TTL profile for the SWR + getRequestContext() regression (see
  // pages/swr-ctx.tsx). ttl=2 opens the stale window fast; swr=120 keeps the
  // entry in the stale-serve range so the background revalidation path runs.
  cacheProfiles: {
    // PPR capture-data-snapshot drift fixture (pages/ppr-drift.tsx): a cached
    // shell value that expires fast (ttl 2, swr 0 so it is fully gone after 2s;
    // sub-60s items live only in the L1 Cache API tier). The underlying entry
    // drifts between capture and a later HIT, exercising the snapshot's parity
    // guarantee on the real CFCacheStore. See ppr-shell-resume.md.
    drift: { ttl: 2, swr: 0 },
    "swr-ctx": { ttl: 2, swr: 120 },
    // Opt-in: a stale entry re-executes in the foreground during an action's
    // revalidation render (fresh action response) instead of SWR.
    "swr-action": { ttl: 2, swr: 120, foregroundOnAction: true },
  },
  onError: (ctx) => {
    console.error("Router error ctx:", ctx);
    console.error("Router error:", ctx.error.stack || ctx.error);
    // Test-only: record { phase, message } so the redirect onError e2e can
    // read it back via /__test/last-error. The console.error above is kept so
    // a real consumer's logging path stays exercised.
    onErrorLog.push({
      phase: ctx.phase,
      message: ctx.error.message,
      metadata: ctx.metadata,
    });
  },
})
  // Document cache middleware - caches full responses based on Cache-Control headers
  .use(createDocumentCacheMiddleware())
  // Per-request perf-debug opt-in (docs/telemetry.md "Per-request opt-in"):
  // ?__perf_debug=1 turns on the metrics store for THIS request only, so the
  // suite is not spammed with [RSC Perf] logs. Must run before next() so
  // downstream phases record into the store.
  .use(async (ctx, next) => {
    if (ctx.url.searchParams.has("__perf_debug")) {
      ctx.debugPerformance();
    }
    await next();
  })
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
