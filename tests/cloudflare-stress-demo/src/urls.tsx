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
import { urls, type Handler } from "@rangojs/router";
import { getMatchDebugStats } from "@rangojs/router/__internal";
// Route groups are loaded via async include providers (`() => import()`): each
// becomes a separate chunk in the worker bundle that is not evaluated at startup
// — only on the first request to its prefix. The bundler handles the subgraph
// (shared modules stay in the common chunk); the router awaits the import once
// on first match and caches it. Build-time discovery awaits the same providers,
// so href()/named routes/types still cover every route in these groups.
import { renderTimingMiddleware } from "./middleware.js";
import { HomePage } from "./pages/benchmark.js";
import { DashboardToolPage } from "./pages/dashboard-page.js";
import { LinksDemo } from "./pages/links-demo.js";

// Match debug is NOT enabled here: enableMatchDebug is a module-global toggle
// that adds per-request work in the regex fallback matcher, which would
// pollute benchmark numbers. The worker entry enables it per-deployment via
// the MATCH_DEBUG env binding (see worker.rsc.tsx / env.ts). Note that all
// named routes resolve via the trie, so matchStats stays at zeros except when
// the regex fallback runs (unmatched paths).

// Benchmark handler - bypasses RSC, returns raw JSON with debug stats
const BenchmarkHandler: Handler<"benchFirst"> = async (ctx) => {
  const now = Date.now();
  const start = ctx.get("dateStart") ?? 0;
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
const LinksDemoHandler: Handler<"links"> = async (ctx) => {
  const reverse = ctx.reverse;

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
      <h1>Links Demo (26k+ routes)</h1>
      <p style={{ color: "#666" }}>
        Server-side ctx.reverse() and scopedReverse() with type-safe route
        resolution across 26,000+ routes.
      </p>

      <h2>ctx.reverse() - Global Named Routes</h2>
      <ul>
        <li>
          home: <code>{homeUrl}</code>
        </li>
        <li>
          api.benchFirst: <code>{apiBench}</code>
        </li>
        <li>
          shop.home: <code>{shopHome}</code>
        </li>
        <li>
          shop.product.item1: <code>{shopProduct1}</code>
        </li>
        <li>
          shop.category.cat1: <code>{shopCat1}</code>
        </li>
        <li data-testid="reverse-product42">
          shop.product.item42: <code>{shopProduct42}</code>
        </li>
        <li data-testid="reverse-cat42">
          shop.category.cat42: <code>{shopCat42}</code>
        </li>
        <li data-testid="reverse-product100">
          shop.product.item100: <code>{shopProduct100}</code>
        </li>
      </ul>

      <h2>scopedReverse() - Local Route Names</h2>
      <ul>
        <li>
          home (local): <code>{localHome}</code>
        </li>
        <li>
          benchFirst (local): <code>{localBenchFirst}</code>
        </li>
        <li>
          api.benchLast (cross-module): <code>{crossModuleApi}</code>
        </li>
      </ul>

      <h2>Client-Side href() and useHref()</h2>
      <LinksDemo />
    </div>
  );
};

// JSON endpoint for e2e testing ctx.reverse() with lazy includes
const ReverseTestHandler: Handler<"reverseTest"> = async (ctx) => {
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

export const urlpatterns = urls(({ path, include, middleware }) => [
  // Route middleware: wraps every render pass (see src/middleware.ts)
  middleware(renderTimingMiddleware),

  // === BENCHMARK: First route (before any includes) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // Home page (outside prefixes)
  path("/", HomePage, { name: "home" }),

  // Links demo - showcases all href APIs with typecheck coverage
  path("/links", LinksDemoHandler, { name: "links" }),

  // Benchmark dashboard - in-browser route explorer + repeat-run timing
  path("/dashboard", DashboardToolPage, { name: "dashboard" }),

  // Reverse test - JSON endpoint for e2e testing ctx.reverse() with lazy includes
  path("/reverse-test", ReverseTestHandler, { name: "reverseTest" }),

  // === LOCALIZED ROUTES (5,000+ under /site/:locale) ===
  // Static "/site" prefix enables short-circuit optimization
  // Patterns are lazily evaluated on first /site/* request (default behavior)
  include("/site/:locale", () => import("./localized-patterns.js"), {
    name: "site",
  }),

  // === API ROUTES (5,000) ===
  // Static "/api" prefix enables short-circuit optimization
  // Patterns are lazily evaluated on first /api/* request (default behavior)
  include("/api", () => import("./included-patterns.js"), { name: "api" }),

  // === SHOP ROUTES (nested includes demo, async-loaded) ===
  // Async include whose split module ITSELF declares nested includes:
  // - /shop/product/* (staticPrefix: "/shop/product") skips /shop/category
  // - /shop/category/* (staticPrefix: "/shop/category") skips /shop/product
  // On the first /shop/* request the router awaits the import, then splices the
  // nested product/category entries — the nested async-include path.
  include("/shop", () => import("./shop-patterns.js"), { name: "shop" }),

  // === JSON API ROUTES (response routes with typed responses) ===
  // Tests PathResponse type resolution through the single RegisteredRoutes registry
  include("/json-api", () => import("./json-api-patterns.js"), {
    name: "jsonApi",
  }),

  // === APP-SHAPED ROUTES (loaders, cache boundary, action form) ===
  // Representative per-request load: layout loader + parallel route loaders,
  // a cache() segment, and a PE-postable server action (see bench scenarios).
  include("/app", () => import("./app-like-patterns.js"), { name: "app" }),

  // === GENERATED GROUP HUB (50 sibling async includes) ===
  // The hub module declares 50 nested `() => import()` includes (generated by
  // scripts/gen-groups.mjs). First /g/* request imports the hub chunk and
  // splices 50 nested entries; only the group actually hit is then imported.
  // Groups carry the shapes the original modules lack: 5-deep static paths,
  // 5-param routes, suffix params, named catch-alls.
  include("/g", () => import("./groups/hub.js"), { name: "g" }),

  // === 3-LEVEL ASYNC INCLUDE CHAIN ===
  // /mega -> /mega/l2 -> /mega/l2/l3, each level its own async provider; the
  // deepest first hit awaits three chunk imports in sequence.
  include("/mega", () => import("./groups/mega/l1.js"), { name: "mega" }),

  // === STRING-PREFIX OVERLAP ===
  // "/site" is a string prefix of "/site-admin" but not a segment prefix —
  // pins segment-wise (not string-wise) prefix handling in trie + fallback.
  include("/site-admin", () => import("./site-admin-patterns.js"), {
    name: "siteAdmin",
  }),

  // === SAME-STATICPREFIX SIBLING PAIR ===
  // Both reduce to staticPrefix "/dup": the router must import BOTH chunks on
  // the first /dup hit (async-includes.md documents this) before matching.
  include("/dup/:cat", () => import("./dup-cat-patterns.js"), {
    name: "dupCat",
  }),
  include("/dup/:brand", () => import("./dup-brand-patterns.js"), {
    name: "dupBrand",
  }),

  // === BENCHMARK: Last route (after ALL routes) ===
  path("/bench/last", BenchmarkHandler, { name: "benchLast" }),
]);
