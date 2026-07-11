/**
 * Loaders for the /app group: the live data layer under load. Each simulates
 * a small IO wait so loader parallelism is observable — the three loaders on
 * /app/dashboard/:section should overlap, not serialize (see Server-Timing).
 */
import { createLoader } from "@rangojs/router";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const AppShellLoader = createLoader(async (_ctx) => {
  "use server";
  await sleep(4);
  return {
    nav: ["dashboard", "cached", "feedback"],
    user: "bench-user",
  };
});

export const StatsLoader = createLoader(async (ctx) => {
  "use server";
  await sleep(6);
  return {
    section: String(ctx.params.section ?? ""),
    visits: 12_340,
    conversion: 0.042,
  };
});

export const ActivityLoader = createLoader(async (_ctx) => {
  "use server";
  await sleep(3);
  return {
    events: Array.from({ length: 10 }, (_, i) => ({
      id: i,
      type: i % 2 === 0 ? "view" : "click",
    })),
  };
});
