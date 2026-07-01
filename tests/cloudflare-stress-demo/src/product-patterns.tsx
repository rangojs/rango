/**
 * Product routes, code-split as an ASYNC include INSIDE the (already async) shop
 * module — the async-within-async ("internal async import") path. The shop group
 * is loaded on the first /shop/* request; this product group is loaded on the
 * first /shop/product/* request. staticPrefix = "/shop/product".
 */
import { urls, type Handler } from "@rangojs/router";
import { getMatchDebugStats } from "@rangojs/router/__internal";

// Benchmark handler - returns JSON with matchStats
const ProductBenchmarkHandler: Handler<"home"> = async (ctx) => {
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

// Product page handler (no URL params, just static paths like /1, /2, ...)
const ProductPage: Handler<"home"> = async (ctx) => {
  return (
    <div>
      <h1>Product {ctx.pathname}</h1>
      <p>Product details page</p>
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
  path("/bench/first", ProductBenchmarkHandler, { name: "benchFirst" }),

  // 100 product routes
  ...Array.from({ length: 100 }, (_, i) =>
    path(`/${i + 1}`, ProductPage, { name: `item${i + 1}` }),
  ),

  // Benchmark route at end
  path("/bench/last", ProductBenchmarkHandler, { name: "benchLast" }),
]);

// Convention for async includes: `export default urls(...)`.
export default productPatterns;
