import { createRouter } from "@rangojs/router";
import { createDocumentCacheMiddleware, CFCacheStore } from "@rangojs/router/cache";
import { urlpatterns } from "./urls.js";
import { Document } from "./document.js";
import type { AppEnv } from "./env.js";

// Create the router with document component
// Document is a server component that wraps the HTML shell
// Navigation is handled by NavLayout in urls.tsx
export const router = createRouter<AppEnv>({
  document: Document,
  // Enable theme support with system detection
  theme: {
    defaultTheme: "light",
    themes: ["light", "dark", "system"],
    attribute: "class",
    storageKey: "theme",
    enableSystem: true,
    enableColorScheme: true,
  },
  // CF cache store with ExecutionContext for non-blocking writes
  cache: (env) => ({
    store: new CFCacheStore({
      defaults: { ttl: 60, swr: 300 },
      ctx: env.ctx!, // Always provided in Cloudflare Workers
    }),
  }),
})
  // Document cache middleware - caches full responses based on Cache-Control headers
  .use(createDocumentCacheMiddleware())
  // Register all routes
  .routes(() => urlpatterns);

type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}

// Export typed reverse function for use in server components
export const reverse = router.reverse;

// ---------- Type-level verification ----------
// These assertions verify PathResponse resolves correctly from the single RegisteredRoutes registry.
// They produce compile errors if the types regress — do not remove.
import type { PathResponse, ValidPaths } from "@rangojs/router/client";

// PathResponse wraps in ResponseEnvelope<T> = { data: T } | { error: ... }
type _HealthResponse = PathResponse<"/api/health">;
type _AssertHealthData = _HealthResponse extends { data: { status: string; timestamp: number } } | { error: unknown } ? true : never;
const _checkHealth: _AssertHealthData = true;

type _ProductsResponse = PathResponse<"/api/products">;
type _AssertProductsData = _ProductsResponse extends { data: Array<{ id: string; name: string; price: number }> } | { error: unknown } ? true : never;
const _checkProducts: _AssertProductsData = true;

type _ProductDetailResponse = PathResponse<"/api/products/:id">;
type _AssertProductDetailData = _ProductDetailResponse extends { data: { id: string; name: string; price: number; description: string } } | { error: unknown } ? true : never;
const _checkProductDetail: _AssertProductDetailData = true;

// Response routes are also valid paths for href()
type _AssertApiHealthIsValid = "/api/health" extends ValidPaths ? true : never;
const _checkValidPath: _AssertApiHealthIsValid = true;
