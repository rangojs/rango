import { createRSCRouter } from "@ivogt/rsc-router/server";
import { Link, href } from "@ivogt/rsc-router/client";
import { createDocumentCacheMiddleware } from "@ivogt/rsc-router/cache";
import {
  homeRoutes,
  aboutRoutes,
  counterRoutes,
  featuresRoutes,
  blogRoutes,
  proactiveCacheRoutes,
  documentCacheRoutes,
} from "./routes.js";
import { AppShell } from "./components/AppShell.js";
import { RootLayout } from "./components/RootLayout.js";
import type { AppEnv } from "./env.js";

// Create the router with document component
// AppShell wraps both route content and error boundaries,
// preventing the app shell from unmounting during errors (avoids FOUC)
//
// IMPORTANT: Chain everything in the assignment to preserve accumulated types!
// Each .routes().map() returns a router with accumulated route types.
// If you call methods without capturing the result, TypeScript loses the types.
export const router = createRSCRouter<AppEnv>({
  document: AppShell,
})
  // Document cache middleware - caches full responses based on Cache-Control headers
  // Routes opt-in by setting s-maxage header
  .use(createDocumentCacheMiddleware())

  // Register routes with lazy-loaded handlers
  .routes(homeRoutes)
  .map(() => import("./handlers/home.js"))

  .routes(aboutRoutes)
  .map(() => import("./handlers/about.js"))

  .routes(counterRoutes)
  .map(() => import("./handlers/counter.js"))

  .routes(featuresRoutes)
  .map(() => import("./handlers/features.js"))

  .routes("/blog", blogRoutes)
  .map(() => import("./handlers/blog.js"))

  .routes("/proactive-cache", proactiveCacheRoutes)
  .map(() => import("./handlers/proactive-cache.js"))

  .routes(documentCacheRoutes)
  .map(() => import("./handlers/document-cache.js"))

  // ============================================
  // INLINE ROUTE DEFINITION EXAMPLE
  // ============================================
  // This demonstrates the new inline route definition API.
  // Routes are defined directly in the router file without
  // needing separate handler files.
  //
  // Benefits:
  // - Simpler for small apps or quick prototypes
  // - All route logic in one place
  // - Type-safe route names (try changing "index" to "invalid")
  //
  // The route names are inferred from the routes definition:
  // { index: "/", docs: "/docs", pricing: "/pricing" }
  // So you can only use "index", "docs", or "pricing" as route names.
  // ============================================
  .routes("/inline", { index: "/", docs: "/docs", pricing: "/pricing" })
  .map(({ route, layout }) => [
    layout(<RootLayout />, () => [
      route("index", () => (
        <div className="max-w-2xl mx-auto p-8">
          <h1 className="text-3xl font-bold mb-4">Inline Routes Demo</h1>
          <p className="text-gray-600 mb-6">
            This page is defined inline in router.tsx
          </p>
          <nav className="flex gap-4">
            <Link to={href("/inline/docs")} className="text-blue-600 hover:underline">
              Docs
            </Link>
            <Link to={href("/inline/pricing")} className="text-blue-600 hover:underline">
              Pricing
            </Link>
          </nav>
        </div>
      )),
      route("docs", () => (
        <div className="max-w-2xl mx-auto p-8">
          <h1 className="text-3xl font-bold mb-4">Documentation</h1>
          <Link to={href("/inline")} className="text-blue-600 hover:underline">
            &larr; Back
          </Link>
        </div>
      )),
      route("pricing", () => (
        <div className="max-w-2xl mx-auto p-8">
          <h1 className="text-3xl font-bold mb-4">Pricing</h1>
          <Link to={href("/inline")} className="text-blue-600 hover:underline">
            &larr; Back
          </Link>
        </div>
      )),
    ]),
  ]);

// Now AppRoutes includes ALL routes including the inline ones!
// Route keys stay unchanged (not prefixed), only URL patterns get prefixed.
// Hover over AppRoutes in your IDE to see:
// - home, about, counter, featuresDetail (from route definitions)
// - blog, blogPost (mounted at /blog)
// - proactiveCache, proactiveCacheItemA, proactiveCacheItemB (mounted at /proactive-cache)
// - index, docs, pricing (inline routes mounted at /inline)
type AppRoutes = typeof router.routeMap;

declare global {
  namespace RSCRouter {
    interface RegisteredRoutes extends AppRoutes {}
  }
}
