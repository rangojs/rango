/**
 * Stress test URL patterns: 14,000+ routes with complex patterns
 *
 * Structure designed to test prefix short-circuit optimization:
 * - /site/:locale/* - 9,000+ localized routes (static prefix enables optimization)
 * - /api/* - 5,000 API routes (static prefix enables optimization)
 *
 * When requesting /api/*, the router can skip ALL /site routes
 * by checking that pathname doesn't start with "/site".
 *
 * Benchmark routes:
 * - /bench/first - before any includes (baseline)
 * - /site/en/bench/first - early in site routes
 * - /site/en/bench/last - late in site routes (after 9000+ patterns)
 * - /api/v1/resource1/test - early API route (skips 9000+ site routes)
 * - /api/v4/static/1000 - late API route
 * - /bench/last - AFTER all includes (worst case: checks all 14,000+ routes)
 */
import { urls } from "@rangojs/router";
import type { HandlerContext } from "@rangojs/router/server";
import { includedPatterns } from "./included-patterns.js";
import { localizedPatterns } from "./localized-patterns.js";
import { HomePage } from "./pages/benchmark.js";

// Benchmark handler - bypasses RSC, returns raw JSON
const BenchmarkHandler = async (ctx: HandlerContext) => {
  const now = Date.now();
  const start = ctx.var.dateStart ?? 0;
  const elapsed = now - start;

  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      timing: {
        requestStart: start,
        handlerReached: now,
        elapsed: `${elapsed}ms`,
        note: elapsed === 0 ? "sub-millisecond (CF time frozen)" : "actual",
      },
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const urlpatterns = urls(({ path, include }) => [
  // === BENCHMARK: First route (before any includes) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // Home page (outside prefixes)
  path("/", HomePage, { name: "home" }),

  // === LOCALIZED ROUTES (9,000+ under /site/:locale) ===
  // Static "/site" prefix enables short-circuit optimization
  include("/site/:locale", localizedPatterns, { name: "site" }),

  // === API ROUTES (5,000) ===
  // Static "/api" prefix enables short-circuit optimization
  include("/api", includedPatterns, { name: "api" }),

  // === BENCHMARK: Last route (after ALL 14,000+ routes) ===
  path("/bench/last", BenchmarkHandler, { name: "benchLast" }),
]);
