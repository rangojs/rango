#!/usr/bin/env node
/**
 * Programmatic bundle analyzer for the rollup-plugin-visualizer reports
 * emitted by `tools/bundle-analyze.ts`.
 *
 * Usage:
 *   1. Build one or more wired apps with `RANGO_ANALYZE=1 pnpm exec vite build`.
 *      Wired apps: tests/cloudflare-basic, tests/cloudflare-stress-demo,
 *      examples/cloudflare-basic-nonce, examples/cloudflare-multi-router,
 *      packages/rangojs-router/e2e/test-app, packages/rangojs-router/e2e/e2e-basic.
 *   2. From the repo root: `node tools/bundle-report.mjs`
 *
 * Reads `<app>/bundle-stats/<env>.json` (raw-data dump from the visualizer).
 * The HTML treemaps are kept around for human inspection but this script
 * does not parse them.
 */
import { readFileSync, globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  APP_SERVER_PATTERNS,
  ROUTER_SERVER_PATTERNS,
  appOwnedFilter,
  extractRows,
  fmt,
  matchLeakPatterns,
} from "./lib/bundle-stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const reports = globSync("**/bundle-stats/*.json", {
  cwd: ROOT,
  exclude: (p) => p.includes("node_modules"),
}).map((p) => `${ROOT}/${p}`);

if (reports.length === 0) {
  console.error(
    "No bundle-stats reports found. Build a wired app with RANGO_ANALYZE=1 first.",
  );
  process.exit(1);
}

function appEnv(path) {
  const parts = path.split("/");
  const env = parts[parts.length - 1].replace(".json", "");
  const idx = parts.indexOf("bundle-stats");
  return { app: parts[idx - 1], env };
}

const results = new Map();
for (const r of reports.sort()) {
  const { app, env } = appEnv(r);
  const data = JSON.parse(readFileSync(r, "utf8"));
  results.set(`${app}/${env}`, extractRows(data));
}

const apps = [
  ...new Set([...results.keys()].map((k) => k.split("/")[0])),
].sort();
const envs = ["client", "ssr", "rsc"];

function shorten(p) {
  return p
    .replace(`${ROOT}/`, "")
    .replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, "")
    .replace(/^packages\/rangojs-router\//, "@rango/")
    .replace(/^node_modules\//, "nm/");
}

console.log("# Bundle Analysis Report\n");
console.log("## 1. Per-app per-env totals (gzip)\n");
console.log("| App | Client | SSR | RSC |");
console.log("|---|---|---|---|");
for (const app of apps) {
  const cells = [app];
  for (const env of envs) {
    const rows = results.get(`${app}/${env}`) ?? [];
    const total = rows.reduce((a, r) => a + r.gzip, 0);
    cells.push(rows.length ? `${fmt(total)} (${rows.length} mods)` : "—");
  }
  console.log(`| ${cells.join(" | ")} |`);
}

/**
 * Scan client bundles per-app for paths matching the given patterns and
 * print a section. `pathFilter` lets the caller exclude rows that other
 * sections own (e.g. don't double-count router internals as app leaks).
 */
function reportLeakSection({
  title,
  intro,
  patterns,
  pathFilter,
  leakLabel,
  cleanVerdict,
}) {
  console.log(`\n## ${title}\n`);
  console.log(`${intro}\n`);
  let anyLeak = false;
  for (const app of apps) {
    const rows = results.get(`${app}/client`);
    if (!rows) continue;
    const found = matchLeakPatterns(rows, patterns, pathFilter);
    if (found.length === 0) continue;
    const reallyLeaking = found.filter(
      (f) => f.totalRendered > 0 || f.totalGzip > 0,
    );
    if (reallyLeaking.length === 0) {
      const names = found.map((f) => f.pat).join(", ");
      console.log(
        `- **${app}**: ${found.length} pattern paths listed, all 0 bytes (tree-shaken stubs): ${names}`,
      );
    } else {
      anyLeak = true;
      console.log(`- **${app}** ${leakLabel}:`);
      for (const f of reallyLeaking) {
        console.log(
          `    - ${f.pat}: ${fmt(f.totalGzip)} gzip / ${fmt(f.totalRendered)} rendered (${f.count} file(s))`,
        );
        for (const file of f.files) {
          if (file.gzip > 0 || file.rendered > 0) {
            console.log(
              `        - ${shorten(file.path)} → ${fmt(file.gzip)} gz / ${fmt(file.rendered)} rendered`,
            );
          }
        }
      }
    }
  }
  if (!anyLeak) console.log(`\n${cleanVerdict}`);
}

reportLeakSection({
  title: "2. Router-internal server modules in CLIENT bundles",
  intro:
    "Modules from `@rangojs/router/src/{server,host,handlers,build,vite,rsc}` and the server-only `src/router/*` files SHOULD NOT contribute bytes to client. This audits ROUTER internals only — for app-owned leaks see Section 2b.",
  patterns: ROUTER_SERVER_PATTERNS,
  leakLabel: "⚠️ ROUTER LEAK",
  cleanVerdict:
    "**Verdict: no `@rangojs/router` server code leaks into client bundles.** (App-owned code: see Section 2b.)",
});

reportLeakSection({
  title: "2b. App-owned server-shaped modules in CLIENT bundles",
  intro:
    "Heuristic check for app code that *looks* server-only: `node:` imports, `*.server.ts` convention, common server packages, db/auth/secrets paths. Hits are not guaranteed leaks — confirm by inspecting the file. Misses don't prove cleanliness; some leaks won't match these patterns.",
  patterns: APP_SERVER_PATTERNS,
  pathFilter: appOwnedFilter,
  leakLabel: "⚠️ APP LEAK CANDIDATE",
  cleanVerdict:
    "**Verdict: no app-owned server-shaped modules detected in client bundles.** (Heuristic — does not cover every leak shape.)",
});

console.log(
  "\n## 3. Cross-env duplication (same source file in multiple envs)\n",
);
console.log(
  "Some duplication is expected (React in client+ssr, segment-system on both). Flagging anything large:\n",
);
for (const app of apps) {
  const byPath = new Map();
  for (const env of envs) {
    const rows = results.get(`${app}/${env}`) ?? [];
    for (const r of rows) {
      if (!byPath.has(r.path)) byPath.set(r.path, {});
      byPath.get(r.path)[env] = { gzip: r.gzip, rendered: r.rendered };
    }
  }
  const inAll3 = [...byPath.entries()].filter(
    ([, e]) => e.client?.gzip && e.ssr?.gzip && e.rsc?.gzip,
  );
  const tripleCost = inAll3.reduce(
    (a, [, e]) => a + e.client.gzip + e.ssr.gzip + e.rsc.gzip,
    0,
  );
  console.log(
    `- **${app}**: ${inAll3.length} files in all 3 envs, ${fmt(tripleCost)} total gzip cost across envs`,
  );
  const top = inAll3
    .map(([p, e]) => [p, e.client.gzip + e.ssr.gzip + e.rsc.gzip, e])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
  for (const [p, totalGzip, e] of top) {
    if (totalGzip < 200) break;
    console.log(
      `    - ${fmt(totalGzip)}  ${shorten(p)}  (c:${fmt(e.client.gzip)} s:${fmt(e.ssr.gzip)} r:${fmt(e.rsc.gzip)})`,
    );
  }
}

console.log(
  "\n## 4. Router chunk breakdown (largest @rango/ modules per CLIENT)\n",
);
for (const app of apps) {
  const rows = results.get(`${app}/client`) ?? [];
  const rangoRows = rows.filter((r) =>
    r.path.includes("packages/rangojs-router/src/"),
  );
  const total = rangoRows.reduce((a, r) => a + r.gzip, 0);
  if (total < 100) continue;
  console.log(`\n### ${app}\n`);
  console.log(
    `Total @rango contribution to client: ${fmt(total)} gzip across ${rangoRows.length} files\n`,
  );
  console.log("Top 12:");
  for (const r of rangoRows.sort((a, b) => b.gzip - a.gzip).slice(0, 12)) {
    console.log(`  ${fmt(r.gzip).padStart(6)}  ${shorten(r.path)}`);
  }
}

console.log("\n## 5. SSR drilldown\n");
for (const app of apps) {
  const rows = results.get(`${app}/ssr`) ?? [];
  if (rows.length === 0) continue;
  const total = rows.reduce((a, r) => a + r.gzip, 0);
  console.log(`\n### ${app} SSR — ${fmt(total)} gzip\n`);
  console.log("Top 8:");
  for (const r of rows.sort((a, b) => b.gzip - a.gzip).slice(0, 8)) {
    console.log(`  ${fmt(r.gzip).padStart(6)}  ${shorten(r.path)}`);
  }
}

console.log(
  "\n## 6. RSC drilldown for cloudflare-stress-demo (route manifest sanity)\n",
);
{
  const rows = results.get(`cloudflare-stress-demo/rsc`);
  if (rows) {
    const total = rows.reduce((a, r) => a + r.gzip, 0);
    console.log(`Total: ${fmt(total)} gzip across ${rows.length} files\n`);
    console.log("Top 15:");
    for (const r of rows.sort((a, b) => b.gzip - a.gzip).slice(0, 15)) {
      console.log(`  ${fmt(r.gzip).padStart(6)}  ${shorten(r.path)}`);
    }
  } else {
    console.log("(stress-demo not built — skip)");
  }
}

const REACT_PATTERNS = [
  { label: "react", re: /\/(react)\/(cjs|index)/ },
  { label: "react-dom", re: /\/react-dom\/(cjs|client|index|server)/ },
  { label: "rsd-webpack-client", re: /react-server-dom-webpack-client/ },
  { label: "rsd-webpack-server", re: /react-server-dom-webpack-server/ },
  { label: "scheduler", re: /\/scheduler\// },
];
console.log("\n## 7. React payload across envs\n");
for (const app of apps) {
  console.log(`\n### ${app}\n`);
  console.log("|       | client | ssr | rsc |");
  console.log("|---|---|---|---|");
  for (const pat of REACT_PATTERNS) {
    const cells = [pat.label];
    for (const env of envs) {
      const rows = results.get(`${app}/${env}`) ?? [];
      const matched = rows.filter((r) => pat.re.test(r.path));
      const total = matched.reduce((a, r) => a + r.gzip, 0);
      cells.push(total > 0 ? fmt(total) : "—");
    }
    console.log(`| ${cells.join(" | ")} |`);
  }
}
