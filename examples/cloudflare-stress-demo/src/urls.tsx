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
import { urls } from "@rangojs/router";
import {
  enableMatchDebug,
  getMatchDebugStats,
  type HandlerContext,
} from "@rangojs/router/server";
import { includedPatterns } from "./included-patterns.js";
import { localizedPatterns } from "./localized-patterns.js";
import { shopPatterns } from "./shop-patterns.js";
import { HomePage } from "./pages/benchmark.js";

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
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const urlpatterns = urls(({ path, include }) => [
  // === BENCHMARK: First route (before any includes) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // Home page (outside prefixes)
  path("/", HomePage, { name: "home" }),

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
