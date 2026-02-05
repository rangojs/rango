/**
 * Shop routes demonstrating nested include() optimization
 *
 * Structure:
 * /shop/product/:id (100 routes) → staticPrefix = "/shop/product"
 * /shop/category/:id (100 routes) → staticPrefix = "/shop/category"
 *
 * Requests to /shop/product/* skip the /shop/category entry (and vice versa)
 */
import { urls } from "@rangojs/router";
import { getMatchDebugStats, type HandlerContext } from "@rangojs/router/server";

// Benchmark handler - returns JSON with matchStats
const ShopBenchmarkHandler = async (ctx: HandlerContext) => {
  const matchStats = getMatchDebugStats();
  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      params: ctx.params,
      matchStats,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

// Product page handler
const ProductPage = async (ctx: HandlerContext) => {
  return (
    <div>
      <h1>Product {ctx.pathname}</h1>
      <p>Product details page</p>
      <pre>{JSON.stringify(ctx.params, null, 2)}</pre>
    </div>
  );
};

// Category page handler
const CategoryPage = async (ctx: HandlerContext) => {
  return (
    <div>
      <h1>Category {ctx.pathname}</h1>
      <p>Category listing page</p>
      <pre>{JSON.stringify(ctx.params, null, 2)}</pre>
    </div>
  );
};

/**
 * Product routes - 100 routes under /shop/product/*
 * staticPrefix = "/shop/product"
 */
export const productPatterns = urls(({ path }) => [
  // Benchmark route at start
  path("/bench/first", ShopBenchmarkHandler, { name: "benchFirst" }),

  // 100 product routes
  ...Array.from({ length: 100 }, (_, i) =>
    path(`/${i + 1}`, ProductPage, { name: `item${i + 1}` })
  ),

  // Benchmark route at end
  path("/bench/last", ShopBenchmarkHandler, { name: "benchLast" }),
]);

/**
 * Category routes - 100 routes under /shop/category/*
 * staticPrefix = "/shop/category"
 */
export const categoryPatterns = urls(({ path }) => [
  // Benchmark route at start
  path("/bench/first", ShopBenchmarkHandler, { name: "benchFirst" }),

  // 100 category routes
  ...Array.from({ length: 100 }, (_, i) =>
    path(`/${i + 1}`, CategoryPage, { name: `cat${i + 1}` })
  ),

  // Benchmark route at end
  path("/bench/last", ShopBenchmarkHandler, { name: "benchLast" }),
]);

/**
 * Main shop patterns - demonstrates nested include optimization
 *
 * /shop/product/* and /shop/category/* are separate entries
 * with different staticPrefixes, so they skip each other
 */
export const shopPatterns = urls(({ path, include }) => [
  // Shop home
  path("/", ShopBenchmarkHandler, { name: "home" }),

  // Nested includes with different static prefixes
  include("/product", productPatterns, { name: "product" }),
  include("/category", categoryPatterns, { name: "category" }),
]);
