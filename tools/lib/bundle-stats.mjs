// Shared metafile parsing + server-in-client classification for
// tools/bundle-report.mjs (Sections 2/2b) and tools/check-bundle-guards.mjs.
// The input is the raw-data JSON dump emitted per environment by
// tools/bundle-analyze.ts (`RANGO_ANALYZE=1 pnpm exec vite build`).

/** Flatten a visualizer raw-data dump into per-module size rows. */
export function extractRows(data) {
  const rows = [];
  for (const [, meta] of Object.entries(data.nodeMetas)) {
    const path = meta.id ?? "";
    let rendered = 0,
      gzip = 0,
      brotli = 0;
    for (const [, partUid] of Object.entries(meta.moduleParts ?? {})) {
      const part = data.nodeParts[partUid] ?? {};
      rendered += part.renderedLength ?? 0;
      gzip += part.gzipLength ?? 0;
      brotli += part.brotliLength ?? 0;
    }
    if (rendered > 0 || gzip > 0) rows.push({ path, rendered, gzip, brotli });
  }
  return rows;
}

export const ROUTER_SERVER_PATTERNS = [
  { name: "src/server/", re: /\/packages\/rangojs-router\/src\/server\// },
  { name: "src/host/", re: /\/packages\/rangojs-router\/src\/host\// },
  { name: "src/handlers/", re: /\/packages\/rangojs-router\/src\/handlers\// },
  { name: "src/build/", re: /\/packages\/rangojs-router\/src\/build\// },
  { name: "src/vite/", re: /\/packages\/rangojs-router\/src\/vite\// },
  {
    name: "src/router/match-handlers.ts",
    re: /\/src\/router\/match-handlers\.ts$/,
  },
  { name: "src/router/route-trie.ts", re: /\/src\/router\/route-trie\.ts$/ },
  {
    name: "src/router/route-discovery.ts",
    re: /\/src\/router\/route-discovery\.ts$/,
  },
  {
    name: "src/router/segment-resolution/",
    re: /\/src\/router\/segment-resolution\//,
  },
  {
    name: "src/router/handler-context.ts",
    re: /\/src\/router\/handler-context\.ts$/,
  },
  { name: "src/router/middleware.ts", re: /\/src\/router\/middleware\.ts$/ },
  { name: "src/router/telemetry.ts", re: /\/src\/router\/telemetry\.ts$/ },
  {
    name: "src/router/telemetry-otel.ts",
    re: /\/src\/router\/telemetry-otel\.ts$/,
  },
  { name: "src/router/origin-guard", re: /\/src\/router\/origin-guard\// },
  { name: "src/rsc/", re: /\/packages\/rangojs-router\/src\/rsc\// },
];

// Heuristic only — file naming is a signal, not a guarantee. Hits warrant
// review; misses don't prove cleanliness.
export const APP_SERVER_PATTERNS = [
  { name: "node: built-in imports", re: /^node:[a-z]/ },
  { name: "cloudflare: imports", re: /^cloudflare:/ },
  {
    name: "*.server.{ts,tsx,js,jsx} convention",
    re: /\.server\.(tsx?|jsx?|mjs|cjs)$/,
  },
  { name: "/db.* or /database/ paths", re: /\/(db|database)[./]/ },
  {
    name: "/secrets, /credentials, /keys",
    re: /\/(secrets|credentials|keys?)\//,
  },
  {
    name: "common DB clients",
    re: /\/(pg|mysql2?|mongodb|mongoose|prisma|redis|ioredis|drizzle-orm)\//,
  },
  { name: "auth/server modules", re: /\/auth\.server\./ },
  {
    name: "node-only npm packages",
    re: /\/(bcrypt|argon2|nodemailer|@sendgrid|googleapis|@aws-sdk)\//,
  },
];

/** Excludes rows the router-internal section owns from the app heuristics. */
export function appOwnedFilter(row) {
  return !row.path.includes("/packages/rangojs-router/");
}

/**
 * Match client rows against server patterns. Returns one entry per pattern
 * with any hits: { pat, count, totalGzip, totalRendered, files }. 0-byte
 * hits (tree-shaken stubs) are included — callers decide how to treat them.
 */
export function matchLeakPatterns(rows, patterns, pathFilter) {
  const candidate = pathFilter ? rows.filter(pathFilter) : rows;
  const found = [];
  for (const pat of patterns) {
    const matched = candidate.filter((r) => pat.re.test(r.path));
    if (matched.length === 0) continue;
    const totalGzip = matched.reduce((a, r) => a + r.gzip, 0);
    const totalRendered = matched.reduce((a, r) => a + r.rendered, 0);
    found.push({
      pat: pat.name,
      count: matched.length,
      totalGzip,
      totalRendered,
      files: matched,
    });
  }
  return found;
}

export function fmt(n) {
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${n}B`;
}
