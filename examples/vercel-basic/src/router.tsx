import { createRouter } from "@rangojs/router";
import {
  MemorySegmentCacheStore,
  VercelCacheStore,
} from "@rangojs/router/cache";
import { getCache, waitUntil } from "@vercel/functions";
import { Document } from "./components/Document.js";
import { HomePage } from "./components/pages/HomePage.js";
import { AboutPage } from "./components/pages/AboutPage.js";
import { CachedTimePage } from "./components/pages/CachedTimePage.js";
import { buildTracing } from "./instrumentation.js";
import { getLastTrace } from "./trace-debug.js";

// Read the gate as a direct `process.env` expression (not the imported
// `traceDebugEnabled` const, which the bundler keeps as a live binding): the
// vite `define` folds this to a literal so the /__debug/trace branch below is
// dead-code-eliminated entirely from a production build.
const TRACE_DEBUG = process.env.RANGO_TRACE_DEBUG === "1";

const defaults = { ttl: 60, swr: 300 };

// Local dev/preview has no Vercel Runtime Cache, so fall back to the in-memory
// store there. On Vercel (process.env.VERCEL is set by the platform) use the
// Runtime Cache store, namespaced by the deployment id so a redeploy does not
// serve stale-shaped entries (Vercel does not reconcile TTL/tags across deploys).
const memoryStore = new MemorySegmentCacheStore({ defaults });

function resolveCache() {
  if (process.env.VERCEL) {
    return {
      store: new VercelCacheStore({
        cache: getCache({ namespace: process.env.VERCEL_DEPLOYMENT_ID }),
        waitUntil,
        defaults,
      }),
    };
  }
  return { store: memoryStore };
}

type AppRoutes = typeof router.routeMap;

declare global {
  namespace Rango {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

const base = createRouter({
  document: Document,
  cache: resolveCache,
  // Vercel custom spans: emit "rango.*" spans for the request/middleware/
  // loader/render/ssr phases via OpenTelemetry. The hybrid setup in
  // instrumentation.ts wires @vercel/otel in the real path and an in-memory
  // recorder in the e2e (RANGO_TRACE_DEBUG=1).
  tracing: buildTracing(),
});

// Test-only: only in the debug build (RANGO_TRACE_DEBUG=1) register a
// path-scoped endpoint that returns the recorder's most recent "rango.*" span
// tree, so the e2e can assert span emission and nesting. Gated so a real
// production deploy never exposes it. (A `.use()` middleware, not a route, so it
// stays out of the route manifest either way.)
const withDebug = TRACE_DEBUG
  ? base.use(
      "/__debug/trace",
      () =>
        new Response(JSON.stringify(getLastTrace()), {
          headers: { "content-type": "application/json" },
        }),
    )
  : base;

export const router = withDebug.routes(({ path, cache }) => [
  path("/", HomePage, { name: "home" }),
  path("/about", AboutPage, { name: "about" }),
  cache({ ttl: 10, swr: 30, tags: ["time"] }, () => [
    path("/cached", CachedTimePage, { name: "cached" }),
  ]),
]);
