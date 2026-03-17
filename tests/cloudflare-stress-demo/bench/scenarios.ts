export interface BenchScenario {
  name: string;
  path: string;
  description: string;
  headers?: Record<string, string>;
}

export const scenarios: BenchScenario[] = [
  {
    name: "json-health",
    path: "/json-api/health",
    description: "JSON response route (lightest)",
  },
  {
    name: "json-items-param",
    path: "/json-api/items/42",
    description: "JSON with path param",
  },
  {
    name: "bench-first",
    path: "/bench/first",
    description: "First root route (best-case match)",
  },
  {
    name: "bench-last",
    path: "/bench/last",
    description: "Last root route (3 routes checked)",
  },
  {
    name: "bench-api-first",
    path: "/api/bench/first",
    description: "API first (prefix skip)",
  },
  {
    name: "bench-api-last",
    path: "/api/bench/last",
    description: "API last (5005 routes checked)",
  },
  {
    name: "ssr-home",
    path: "/",
    description: "Full SSR document render",
    headers: { accept: "text/html" },
  },
];

export const timingPaths = [
  "/bench/first",
  "/bench/last",
  "/api/bench/first",
  "/api/bench/last",
  "/",
];

/** Paths to hit during warmup to trigger all lazy includes */
export const warmupPaths = [
  "/json-api/health",
  "/api/bench/first",
  "/site/en/bench/first",
  "/shop/product/bench/first",
  "/bench/first",
];
