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
import { urls, scopedReverse, type Handler } from "@rangojs/router";
import { enableMatchDebug, getMatchDebugStats } from "@rangojs/router/server";
import type { routes } from "./urls.gen.js";
import { includedPatterns } from "./included-patterns.js";
import { localizedPatterns } from "./localized-patterns.js";
import { shopPatterns } from "./shop-patterns.js";
import { jsonApiPatterns } from "./json-api-patterns.js";
import { HomePage } from "./pages/benchmark.js";
import { LinksDemo } from "./pages/links-demo.js";

// Enable debug for all requests
enableMatchDebug(true);

// Benchmark handler - bypasses RSC, returns raw JSON with debug stats
const BenchmarkHandler: Handler<"benchFirst", routes> = async (ctx) => {
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
      // Test ctx.reverse() for routes from lazy includes
      testReverse: ctx.reverse("api.benchFirst"),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};

// Links demo handler - showcases ctx.reverse() and scopedReverse() on the server
const LinksDemoHandler: Handler<"links", routes> = async (ctx) => {
  const reverse = scopedReverse<typeof urlpatterns>(ctx.reverse);

  // ctx.reverse with global named routes
  const homeUrl = ctx.reverse("home");
  const apiBench = ctx.reverse("api.benchFirst");
  const shopHome = ctx.reverse("shop.home");
  const shopProduct1 = ctx.reverse("shop.product.item1");
  const shopCat1 = ctx.reverse("shop.category.cat1");
  // Routes from deep lazy includes (previously failed at module-level)
  const shopProduct42 = ctx.reverse("shop.product.item42");
  const shopCat42 = ctx.reverse("shop.category.cat42");
  const shopProduct100 = ctx.reverse("shop.product.item100");

  // scopedReverse with local route names
  const localHome = reverse("home");
  const localBenchFirst = reverse("benchFirst");

  // scopedReverse with cross-module dot-prefixed names
  const crossModuleApi = reverse("api.benchLast");

  return (
    <div style={{ maxWidth: "800px", margin: "0 auto", padding: "2rem" }}>
      <h1>Links Demo (14k+ routes)</h1>
      <p style={{ color: "#666" }}>
        Server-side ctx.reverse() and scopedReverse() with type-safe route resolution
        across 14,000+ routes.
      </p>

      <h2>ctx.reverse() - Global Named Routes</h2>
      <ul>
        <li>home: <code>{homeUrl}</code></li>
        <li>api.benchFirst: <code>{apiBench}</code></li>
        <li>shop.home: <code>{shopHome}</code></li>
        <li>shop.product.item1: <code>{shopProduct1}</code></li>
        <li>shop.category.cat1: <code>{shopCat1}</code></li>
        <li data-testid="reverse-product42">shop.product.item42: <code>{shopProduct42}</code></li>
        <li data-testid="reverse-cat42">shop.category.cat42: <code>{shopCat42}</code></li>
        <li data-testid="reverse-product100">shop.product.item100: <code>{shopProduct100}</code></li>
      </ul>

      <h2>scopedReverse() - Local Route Names</h2>
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

// JSON endpoint for e2e testing ctx.reverse() with lazy includes
const ReverseTestHandler: Handler<"reverseTest", routes> = async (ctx) => {
  const results: Record<string, string> = {
    home: ctx.reverse("home"),
    "api.benchFirst": ctx.reverse("api.benchFirst"),
    "api.benchLast": ctx.reverse("api.benchLast"),
    "shop.home": ctx.reverse("shop.home"),
    "shop.product.item1": ctx.reverse("shop.product.item1"),
    "shop.product.item42": ctx.reverse("shop.product.item42"),
    "shop.product.item100": ctx.reverse("shop.product.item100"),
    "shop.category.cat1": ctx.reverse("shop.category.cat1"),
    "shop.category.cat42": ctx.reverse("shop.category.cat42"),
    "shop.category.cat100": ctx.reverse("shop.category.cat100"),
    "shop.product.benchFirst": ctx.reverse("shop.product.benchFirst"),
    "shop.product.benchLast": ctx.reverse("shop.product.benchLast"),
  };
  throw new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" },
  });
};

export const urlpatterns = urls(({ path, include }) => [
  // === BENCHMARK: First route (before any includes) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // Home page (outside prefixes)
  path("/", HomePage, { name: "home" }),

  // Links demo - showcases all href APIs with typecheck coverage
  path("/links", LinksDemoHandler, { name: "links" }),

  // Reverse test - JSON endpoint for e2e testing ctx.reverse() with lazy includes
  path("/reverse-test", ReverseTestHandler, { name: "reverseTest" }),

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

  // === JSON API ROUTES (response routes with typed responses) ===
  // Tests PathResponse type resolution through the single RegisteredRoutes registry
  include("/json-api", jsonApiPatterns, { name: "jsonApi" }),

  // === BENCHMARK: Last route (after ALL routes) ===
  path("/bench/last", BenchmarkHandler, { name: "benchLast" }),
]);
