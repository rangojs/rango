/**
 * Shop routes demonstrating nested include() optimization
 *
 * Structure:
 * /shop/product/:id (100 routes) → staticPrefix = "/shop/product"
 * /shop/category/:id (100 routes) → staticPrefix = "/shop/category"
 *
 * Requests to /shop/product/* skip the /shop/category entry (and vice versa)
 */
import { urls, type Handler } from "@rangojs/router";
import { getMatchDebugStats } from "@rangojs/router/__internal";

// Benchmark handler - returns JSON with matchStats
const ShopBenchmarkHandler: Handler<"home"> = async (ctx) => {
  const matchStats = getMatchDebugStats();
  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      params: ctx.params,
      matchStats,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
};

// Category page handler (no URL params, just static paths like /1, /2, ...)
const CategoryPage: Handler<"home"> = async (ctx) => {
  return (
    <div>
      <h1>Category {ctx.pathname}</h1>
      <p>Category listing page</p>
      <pre>{JSON.stringify(ctx.params, null, 2)}</pre>
    </div>
  );
};

/**
 * Category routes - 100 routes under /shop/category/*
 * staticPrefix = "/shop/category"
 */
export const categoryPatterns = urls(({ path }) => [
  // Benchmark route at start
  path("/bench/first", ShopBenchmarkHandler, { name: "benchFirst" }),

  // 100 category routes
  ...Array.from({ length: 100 }, (_, i) =>
    path(`/${i + 1}`, CategoryPage, { name: `cat${i + 1}` }),
  ),

  // Benchmark route at end
  path("/bench/last", ShopBenchmarkHandler, { name: "benchLast" }),
]);

/**
 * Main shop patterns - demonstrates nested include optimization AND
 * async-within-async: this shop module is itself loaded via an async include
 * (`() => import("./shop-patterns.js")` from urls.tsx), and its /product child
 * is ALSO an async include (`() => import("./product-patterns.js")`) — so
 * /shop/product/* chains two deferred imports. /category stays eager for
 * contrast (an eager child inside an async parent).
 *
 * /shop/product/* and /shop/category/* are separate entries with different
 * staticPrefixes, so they skip each other.
 */
export const shopPatterns = urls(({ path, include }) => [
  // Shop home
  path("/", ShopBenchmarkHandler, { name: "home" }),

  // Nested includes with different static prefixes. /product is async
  // (code-split, loaded on first /shop/product/* request); /category is eager.
  include("/product", () => import("./product-patterns.js"), {
    name: "product",
  }),
  include("/category", categoryPatterns, { name: "category" }),
]);

export default shopPatterns;
