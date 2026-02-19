/**
 * 1000+ localized routes under /:locale prefix
 * - Routes with params
 * - Routes with optional params
 * - Nested layouts
 * - Static routes
 */
import { urls, type Handler } from "@rangojs/router";
import { Outlet } from "@rangojs/router/client";
import { getMatchDebugStats } from "@rangojs/router";

// Benchmark route - returns raw Response with debug stats, bypasses RSC
const BenchmarkHandler: Handler<"benchFirst"> = async (ctx) => {
  const now = Date.now();
  const start = ctx.var.dateStart ?? 0;
  const elapsed = now - start;
  const matchStats = getMatchDebugStats();

  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      params: ctx.params,
      timing: {
        requestStart: start,
        handlerReached: now,
        elapsed: `${elapsed}ms`,
        note: elapsed === 0 ? "sub-millisecond (CF time frozen)" : "actual",
      },
      matchStats,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
};

// Shared handler for 8000+ stress-test routes with varying param shapes.
// Handler<Record<string, any>> bypasses PathFn's biconditional via the
// index-signature guard (string extends keyof TParams).
const ParamPage: Handler<Record<string, any>> = async (ctx) => {
  // setTimeout(0) to unfreeze Cloudflare's time
  await new Promise((r) => setTimeout(r, 1));

  const renderTime = Date.now();
  const requestStart = ctx.var.dateStart ?? 0;
  const totalTime = renderTime - requestStart;

  return (
    <div>
      <h1>Params Page</h1>
      <p>
        <strong>Request → Render:</strong> {totalTime}ms
      </p>
      <pre>{JSON.stringify(ctx.params, null, 2)}</pre>
    </div>
  );
};

// Simple page component for stress routes (no params)
const StressPage: Handler = async (ctx) => {
  await new Promise((r) => setTimeout(r, 1));

  const renderTime = Date.now();
  const requestStart = ctx.var.dateStart ?? 0;
  const totalTime = renderTime - requestStart;

  return (
    <div>
      <p>
        <strong>Request → Render:</strong> {totalTime}ms
      </p>
    </div>
  );
};

// Simple layout wrapper
const Layout = () => (
  <div>
    <Outlet />
  </div>
);

export const localizedPatterns = urls(({ path, layout }) => [
  // Locale home: /:locale
  path("/", StressPage, { name: "localeHome" }),

  // === BENCHMARK ROUTES (raw Response, no RSC) ===
  path("/bench/first", BenchmarkHandler, { name: "benchFirst" }),

  // === PARAM ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/user${i + 1}/:id`, ParamPage, { name: `user${i + 1}` })
  ),

  // === OPTIONAL PARAM ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/post${i + 1}/:id?`, ParamPage, { name: `post${i + 1}` })
  ),

  // === MULTI-PARAM ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/org${i + 1}/:orgId/repo/:repoId`, ParamPage, {
      name: `org${i + 1}`,
    })
  ),

  // === FLAT ROUTES (2000) ===
  ...Array.from({ length: 2000 }, (_, i) =>
    path(`/flat/${i + 1}`, StressPage, { name: `flat${i + 1}` })
  ),

  // === NESTED LAYOUTS WITH PARAMS (4000 routes across 4 levels) ===
  layout(<Layout />, () => [
    // Level 1: 1000 routes with optional param
    ...Array.from({ length: 1000 }, (_, i) =>
      path(`/l1/${i + 1}/:slug?`, ParamPage, { name: `l1_${i + 1}` })
    ),

    layout(<Layout />, () => [
      // Level 2: 1000 routes with required param
      ...Array.from({ length: 1000 }, (_, i) =>
        path(`/l2/${i + 1}/:id`, ParamPage, { name: `l2_${i + 1}` })
      ),

      layout(<Layout />, () => [
        // Level 3: 1000 routes with two params
        ...Array.from({ length: 1000 }, (_, i) =>
          path(`/l3/${i + 1}/:cat/:id`, ParamPage, { name: `l3_${i + 1}` })
        ),

        layout(<Layout />, () => [
          // Level 4: 1000 routes with mixed params
          ...Array.from({ length: 1000 }, (_, i) =>
            path(`/l4/${i + 1}/:type/:id?`, ParamPage, {
              name: `l4_${i + 1}`,
            })
          ),
        ]),
      ]),
    ]),
  ]),

  // === BENCHMARK ROUTE AT THE END (raw Response, no RSC) ===
  path("/bench/last", BenchmarkHandler, { name: "benchLast" }),
]);
