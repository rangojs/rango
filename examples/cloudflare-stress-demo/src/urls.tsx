/**
 * Stress test URL patterns: 10,000+ routes with complex patterns
 *
 * Structure designed to test prefix short-circuit optimization:
 * - /site/:locale/* - 5,000+ localized routes (staticPrefix: "/site")
 * - /api/* - 5,000 API routes (staticPrefix: "/api")
 * - /shop/* - Nested includes demo (staticPrefix: "/shop")
 *   - /shop/product/* - 100 routes (staticPrefix: "/shop/product")
 *   - /shop/category/* - 100 routes (staticPrefix: "/shop/category")
 *
 * Key optimizations:
 * - /api/* requests skip ALL /site and /shop routes
 * - /shop/product/* requests skip /shop/category routes (nested optimization!)
 * - 404s for non-prefixed paths skip ~10,000 routes
 */
import { urls, scopedHref } from "@rangojs/router";
import {
  enableMatchDebug,
  getMatchDebugStats,
  type HandlerContext,
} from "@rangojs/router/server";
import { includedPatterns } from "./included-patterns.js";
import { localizedPatterns } from "./localized-patterns.js";
import { shopPatterns } from "./shop-patterns.js";
import { HomePage } from "./pages/benchmark.js";
import { LinksDemo } from "./pages/links-demo.js";

// Enable debug for all requests
enableMatchDebug(true);

// Benchmark handler - bypasses RSC, returns raw JSON with debug stats
const BenchmarkHandler = async (ctx: HandlerContext) => {
  const now = Date.now();
  const start = ctx.var.dateStart ?? 0;
  const elapsed = now - start;
  const matchStats = getMatchDebugStats();

  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      timing: {
        requestStart: start,
        handlerReached: now,
        elapsed: `${elapsed}ms`,
        note: elapsed === 0 ? "sub-millisecond (CF time frozen)" : "actual",
      },
      matchStats,
      // Test ctx.href() for routes from lazy includes
      testHref: ctx.href("api.benchFirst"),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};

// Links demo handler - showcases ctx.href() and scopedHref() on the server
const LinksDemoHandler = async (ctx: HandlerContext) => {
  const href = scopedHref<typeof urlpatterns>(ctx.href);

  // ctx.href with global named routes
  const homeUrl = ctx.href("home");
  const apiBench = ctx.href("api.benchFirst");
  const shopHome = ctx.href("shop.home");
  const shopProduct1 = ctx.href("shop.product.item1");
  const shopCat1 = ctx.href("shop.category.cat1");

  // scopedHref with local route names
  const localHome = href("home");
  const localBenchFirst = href("benchFirst");

  // scopedHref with cross-module dot-prefixed names
  const crossModuleApi = href("api.benchLast");

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem" }}>
      <h1>Links Demo (14k+ routes)</h1>
      <p style={{ color: "#666" }}>
        Server-side ctx.href() and scopedHref() with type-safe route resolution
        across 14,000+ routes.
      </p>

      <h2>ctx.href() - Global Named Routes</h2>
      <ul>
        <li>home: <code>{homeUrl}</code></li>
        <li>api.benchFirst: <code>{apiBench}</code></li>
        <li>shop.home: <code>{shopHome}</code></li>
        <li>shop.product.item1: <code>{shopProduct1}</code></li>
        <li>shop.category.cat1: <code>{shopCat1}</code></li>
      </ul>

      <h2>scopedHref() - Local Route Names</h2>
      <ul>
        <li>home (local): <code>{localHome}</code></li>
        <li>benchFirst (local): <code>{localBenchFirst}</code></li>
        <li>api.benchLast (cross-module): <code>{crossModuleApi}</code></li>
      </ul>

      <h2>Client-Side href() and useHref()</h2>
      <LinksDemo />
    </div>
  );
};

export const urlpatterns = urls(({ path, include }) => [
  // === BENCHMARK: First route (before any includes) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // Home page (outside prefixes)
  path("/", HomePage, { name: "home" }),

  // Links demo - showcases all href APIs with typecheck coverage
  path("/links", LinksDemoHandler, { name: "links" }),

  // === LOCALIZED ROUTES (5,000+ under /site/:locale) ===
  // Static "/site" prefix enables short-circuit optimization
  // Patterns are lazily evaluated on first /site/* request (default behavior)
  include("/site/:locale", localizedPatterns, { name: "site" }),

  // === API ROUTES (5,000) ===
  // Static "/api" prefix enables short-circuit optimization
  // Patterns are lazily evaluated on first /api/* request (default behavior)
  include("/api", includedPatterns, { name: "api" }),

  // === SHOP ROUTES (nested includes demo) ===
  // Demonstrates nested include optimization:
  // - /shop/product/* (staticPrefix: "/shop/product") skips /shop/category
  // - /shop/category/* (staticPrefix: "/shop/category") skips /shop/product
  include("/shop", shopPatterns, { name: "shop" }),

  // === BENCHMARK: Last route (after ALL routes) ===
  path("/bench/last", BenchmarkHandler, { name: "benchLast" }),
]);
