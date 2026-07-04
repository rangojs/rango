/**
 * Benchmark scenarios.
 *
 * Two scenario kinds:
 * - "fixed": one URL hammered repeatedly. After the first request the router's
 *   single-entry pathname cache (find-match.ts) short-circuits matching, so
 *   fixed scenarios measure the per-request pipeline floor, NOT matching.
 * - "unique": a pre-generated, deterministically shuffled list of distinct
 *   paths cycled by autocannon. Consecutive requests differ, so every request
 *   performs a real trie walk + param extraction. This is the only scenario
 *   kind whose numbers respond to matching changes.
 *
 * `expectStatus` is enforced: a validation fetch runs before load, and after
 * each run the autocannon status-class counters must match (a 200-scenario
 * with any non-2xx fails the benchmark instead of reporting fast garbage).
 */
export interface BenchScenario {
  name: string;
  description: string;
  kind: "fixed" | "unique";
  /** Representative path (fixed: the path; unique: printed as sample). */
  path: string;
  /**
   * For kind: "unique" — distinct paths to cycle. The function form receives
   * a nonce and must return paths unique to that nonce; used where repeat
   * requests would change what is measured (e.g. cache-miss scenarios, where
   * a reused key becomes a hit on the next round).
   */
  paths?: string[] | ((nonce: string) => string[]);
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Expected HTTP status class for every response (200 or 404). */
  expectStatus: 200 | 404;
  /** Substring the validation fetch must find in the response body. */
  expectBody?: string;
  /** Content-type prefix the validation fetch must see. */
  expectContentType?: string;
  /**
   * Optional runtime preparation against the live server (e.g. scraping a
   * build-dependent action id from rendered HTML). Returns fields to merge
   * into the scenario, or null to skip it (run.ts warns and drops it).
   */
  prepare?: (baseUrl: string) => Promise<Partial<BenchScenario> | null>;
}

/** Resolve a scenario's unique-path list for a given nonce. */
export function resolvePaths(scenario: BenchScenario, nonce: string): string[] {
  if (!scenario.paths) return [scenario.path];
  return typeof scenario.paths === "function"
    ? scenario.paths(nonce)
    : scenario.paths;
}

/** Deterministic LCG so path lists are identical across runs and branches. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = makeRng(seed);
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

const LOCALES = ["en", "fr", "de", "ja", "es"];
const UNIQUE_COUNT = 400;

function uniquePaths(build: (i: number) => string): string[] {
  return shuffled(
    Array.from({ length: UNIQUE_COUNT }, (_, i) => build(i)),
    42,
  );
}

export const scenarios: BenchScenario[] = [
  // -- Fixed-URL scenarios: per-request pipeline floor (pathname-cache path) --
  {
    name: "json-health",
    kind: "fixed",
    path: "/json-api/health",
    description: "JSON response route, single URL (pipeline floor)",
    expectStatus: 200,
    expectBody: '"status"',
  },
  {
    name: "bench-single-url",
    kind: "fixed",
    path: "/bench/first",
    description: "Raw JSON handler, single URL (pathname-cache fast path)",
    expectStatus: 200,
    expectBody: '"matchStats"',
  },
  {
    name: "ssr-home",
    kind: "fixed",
    path: "/",
    description: "Full SSR document render (route-map page), single URL",
    headers: { accept: "text/html" },
    expectStatus: 200,
    expectBody: "routes, one worker",
  },

  // -- Unique-path scenarios: real matching on every request --
  {
    name: "json-items-unique",
    kind: "unique",
    path: "/json-api/items/<n>",
    paths: uniquePaths((i) => `/json-api/items/${i + 1}`),
    description: "JSON route, distinct :id per request (trie walk + param)",
    expectStatus: 200,
  },
  {
    name: "api-static-unique",
    kind: "unique",
    path: "/api/v4/static/<n>",
    paths: uniquePaths((i) => `/api/v4/static/${(i % 1000) + 1}`),
    description: "Distinct static API route per request (RSC render)",
    expectStatus: 200,
  },
  {
    name: "api-multi-param-unique",
    kind: "unique",
    path: "/api/v2/users/<uid>/items<n>/<iid>",
    paths: uniquePaths(
      (i) => `/api/v2/users/u${i + 1}/items${(i % 1000) + 1}/it${i + 1}`,
    ),
    description: "Distinct multi-param API route per request (RSC render)",
    expectStatus: 200,
  },
  {
    name: "site-flat-unique",
    kind: "unique",
    path: "/site/<locale>/flat/<n>",
    paths: uniquePaths(
      (i) => `/site/${LOCALES[i % LOCALES.length]}/flat/${(i % 2000) + 1}`,
    ),
    description: "Distinct locale + flat route per request (RSC render)",
    expectStatus: 200,
  },
  {
    name: "site-l4-unique",
    kind: "unique",
    path: "/site/<locale>/l4/<n>/<type>/<id>",
    paths: uniquePaths(
      (i) =>
        `/site/${LOCALES[i % LOCALES.length]}/l4/${(i % 1000) + 1}/t${i % 7}/id${i + 1}`,
    ),
    description: "4-level nested layout, distinct params (deep segment tree)",
    expectStatus: 200,
  },

  // -- App-shaped scenarios: the pipeline consumers actually run --
  {
    name: "app-dashboard-unique",
    kind: "unique",
    path: "/app/dashboard/<section>",
    paths: uniquePaths((i) => `/app/dashboard/s${i % 50}`),
    description: "Nested layout + 3 parallel loaders + client consumers (SSR)",
    headers: { accept: "text/html" },
    expectStatus: 200,
    expectBody: 'data-testid="stats"',
  },
  {
    name: "rsc-nav-unique",
    kind: "unique",
    path: "/site/<locale>/flat/<n> (Flight)",
    paths: uniquePaths(
      (i) =>
        `/site/${LOCALES[i % LOCALES.length]}/flat/${(i % 2000) + 1}?_rsc_partial=true&_rsc_segments=`,
    ),
    description: "Client-navigation Flight request (partial payload)",
    headers: { "X-RSC-Router-Client-Path": "/" },
    expectStatus: 200,
    expectContentType: "text/x-component",
  },
  {
    name: "cached-hit",
    kind: "fixed",
    path: "/app/cached/hot",
    description: "cache() segment, single hot key (cache-hit serve path)",
    headers: { accept: "text/html" },
    expectStatus: 200,
    expectBody: "cached-rendered-at",
  },
  {
    name: "cached-miss-unique",
    kind: "unique",
    path: "/app/cached/<nonce>-<n>",
    // Fresh keys per nonce so every request in a round is a miss + store; a
    // static list would turn into hits from round 2 onward (ttl 300s).
    paths: (nonce) =>
      Array.from({ length: 8000 }, (_, i) => `/app/cached/${nonce}-${i}`),
    description: "cache() segment, fresh key per request (miss + store)",
    headers: { accept: "text/html" },
    expectStatus: 200,
    expectBody: "cached-rendered-at",
  },

  {
    name: "action-post",
    kind: "fixed",
    path: "/app/feedback",
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
    },
    description: "PE form POST: server action + full re-render",
    expectStatus: 200,
    expectBody: "feedback-form",
    // The PE wire format embeds a build-dependent action id in a hidden
    // $ACTION_ID_* form field — scrape it from the live server so the POST
    // body survives rebuilds.
    prepare: async (baseUrl) => {
      const res = await fetch(`${baseUrl}/app/feedback`, {
        headers: { accept: "text/html" },
      });
      const html = await res.text();
      const match = html.match(/name="(\$ACTION_ID_[^"]+)"/);
      if (res.status !== 200 || !match) return null;
      return {
        body: new URLSearchParams({
          [match[1]!]: "",
          message: "hello from bench",
        }).toString(),
      };
    },
  },

  // -- Generated hub: mixed shapes across 50 sibling async-include groups --
  {
    name: "hub-mixed-unique",
    kind: "unique",
    path: "/g/g0<nn>/<mixed shapes>",
    paths: uniquePaths((i) => {
      const g = `g${String((i % 50) + 1).padStart(3, "0")}`;
      switch (i % 5) {
        case 0:
          return `/g/${g}/r${(i % 60) + 1}/id${i}`;
        case 1:
          return `/g/${g}/deep/a/b/c/p${(i % 60) + 1}`;
        case 2:
          return `/g/${g}/m${(i % 40) + 1}/a${i}/b${i}/c${i}`;
        case 3:
          return `/g/${g}/tree/a/b/c${i}`;
        default:
          return `/g/${g}/files/app${i}.min.js`;
      }
    }),
    description:
      "Mixed shapes (param, 5-deep static, 3-param, catch-all, suffix) across 50 groups",
    expectStatus: 200,
  },

  // -- 404 scenarios: the regex fallback scan, the only remaining O(n) path --
  {
    name: "miss-under-site",
    kind: "unique",
    path: "/site/en/zzz-<n>",
    paths: uniquePaths((i) => `/site/en/zzz-miss-${i}`),
    description: "404 under /site prefix (regex fallback scans site entry)",
    expectStatus: 404,
  },
  {
    name: "miss-root-probe",
    kind: "unique",
    path: "/probe-<n>.php",
    paths: uniquePaths((i) => `/probe-${i}.php`),
    description: "Bot-style root 404 (fallback skips all prefixed entries)",
    expectStatus: 404,
  },
];

/** Paths profiled via the /timing/* endpoint (single request, Server-Timing). */
export const timingPaths = [
  "/bench/first",
  "/api/bench/first",
  "/site/en/l4/1/t0/id1",
  "/json-api/items/42",
  "/app/dashboard/main",
  "/app/cached/hot",
  "/",
];

/**
 * Cold-start measurement sequence: each entry is the FIRST request of its kind
 * after a fresh server start, in this order. The first request pays manifest
 * load; each include prefix then pays its chunk import on first hit.
 */
export const coldStartPaths: { path: string; description: string }[] = [
  { path: "/bench/first", description: "first request (manifest parse)" },
  { path: "/api/bench/first", description: "/api include first-hit" },
  { path: "/site/en/bench/first", description: "/site include first-hit" },
  {
    path: "/shop/product/bench/first",
    description: "/shop nested include first-hit",
  },
  {
    path: "/shop/category/bench/first",
    description: "/shop/category sibling (chunk already loaded)",
  },
  { path: "/json-api/health", description: "/json-api include first-hit" },
  {
    path: "/app/dashboard/main",
    description: "/app include first-hit (layout + parallel loaders)",
  },
  {
    path: "/g/g001/bench/first",
    description: "hub first-hit (hub chunk + 50 spliced entries + one group)",
  },
  {
    path: "/mega/l2/l3/p1/x",
    description: "3-level async chain first-hit (three imports in sequence)",
  },
  {
    path: "/dup/shoes/cat-page1",
    description: "same-staticPrefix pair first-hit (imports BOTH dup chunks)",
  },
  { path: "/", description: "SSR home after all includes loaded" },
];

/**
 * Paths hit during warmup to trigger every lazy include group before the
 * throughput phase. Every include prefix appears, including /shop/category.
 */
export const warmupPaths: string[] = [
  "/json-api/health",
  "/api/bench/first",
  "/site/en/bench/first",
  "/shop/product/bench/first",
  "/shop/category/bench/first",
  "/app/dashboard/main",
  "/g/g001/bench/first",
  "/mega/l2/l3/p1/x",
  "/site-admin/p1",
  "/dup/shoes/cat-page1",
  "/bench/first",
  "/",
];
