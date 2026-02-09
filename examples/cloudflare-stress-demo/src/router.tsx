import { createRouter } from "@rangojs/router/server";
import { CFCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppEnv } from "./env.js";

export const router = createRouter<AppEnv>({
  document: Document,
  debugPerformance: true, // Enable Server-Timing headers
  // CF cache store for segment caching
  cache: (env) => ({
    store: new CFCacheStore({ ctx: env.ctx! }),
  }),
  onError: (error) => {
    // Log errors to console (can be extended to use external logging services)
    console.error("Router error:", error);
  },
}).routes(urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// ---------- Type-level verification ----------
// These assertions verify PathResponse works with response routes in a large route map (10k+ routes).
// Compile errors here mean the type system regressed — do not remove.
import type { PathResponse, ValidPaths } from "@rangojs/router/client";

// Response routes resolve their typed response data (wrapped in ResponseEnvelope)
type _HealthResponse = PathResponse<"/json-api/health">;
type _AssertHealth = _HealthResponse extends { data: { status: "ok"; timestamp: number; uptime: number } } | { error: unknown } ? true : never;
const _checkHealth: _AssertHealth = true;

type _StatsResponse = PathResponse<"/json-api/stats">;
type _AssertStats = _StatsResponse extends { data: { routes: number; prefixes: number; lazy: boolean } } | { error: unknown } ? true : never;
const _checkStats: _AssertStats = true;

type _ItemResponse = PathResponse<"/json-api/items/:id">;
type _AssertItem = _ItemResponse extends { data: { id: string; name: string; price: number; inStock: boolean } } | { error: unknown } ? true : never;
const _checkItem: _AssertItem = true;

// Response routes are also valid paths for href()
type _AssertHealthPath = "/json-api/health" extends ValidPaths ? true : never;
const _checkHealthPath: _AssertHealthPath = true;

// RSC routes with params remain valid
type _AssertSiteRoute = `/site/${string}/bench/first` extends ValidPaths ? true : never;
const _checkSiteRoute: _AssertSiteRoute = true;
