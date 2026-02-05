/**
 * 500 routes for include() testing with various param patterns
 */
import { urls } from "@rangojs/router";
import { getMatchDebugStats, type HandlerContext } from "@rangojs/router/server";
import type { AppEnv } from "./env.js";

// Benchmark handler for API routes - returns debug stats
const ApiBenchmarkHandler = async (ctx: HandlerContext<AppEnv>) => {
  const matchStats = getMatchDebugStats();
  throw new Response(
    JSON.stringify({
      route: ctx.pathname,
      timing: {
        requestStart: ctx.var.dateStart ?? 0,
        handlerReached: Date.now(),
      },
      matchStats,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
};

const ParamPage = async (ctx: HandlerContext<AppEnv>) => {
  await new Promise((r) => setTimeout(r, 1));

  const renderTime = Date.now();
  const requestStart = ctx.var.dateStart ?? 0;
  const totalTime = renderTime - requestStart;

  return (
    <div>
      <h1>API Route</h1>
      <p>
        <strong>Request → Render:</strong> {totalTime}ms
      </p>
      <pre>{JSON.stringify(ctx.params, null, 2)}</pre>
    </div>
  );
};

export const includedPatterns = urls(({ path }) => [
  // === BENCHMARK: First API route ===
  path("/bench/first", ApiBenchmarkHandler, { name: "benchFirst" }),

  // === RESOURCE ROUTES WITH ID (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/v1/resource${i + 1}/:id`, ParamPage, { name: `resource${i + 1}` })
  ),

  // === NESTED RESOURCE ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/v2/users/:userId/items${i + 1}/:itemId`, ParamPage, {
      name: `userItem${i + 1}`,
    })
  ),

  // === OPTIONAL PARAM ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/v3/search${i + 1}/:query?`, ParamPage, { name: `search${i + 1}` })
  ),

  // === STATIC ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/v4/static/${i + 1}`, ParamPage, { name: `static${i + 1}` })
  ),

  // === MIXED PARAM ROUTES (1000) ===
  ...Array.from({ length: 1000 }, (_, i) =>
    path(`/v5/org/:orgId/project${i + 1}/:projectId?`, ParamPage, {
      name: `project${i + 1}`,
    })
  ),

  // === BENCHMARK: Last API route ===
  path("/bench/last", ApiBenchmarkHandler, { name: "benchLast" }),
]);
