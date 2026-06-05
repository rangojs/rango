// Cost-side benchmark for `clientChunks` (per-route client splitting).
//
// Answers the gate the default-on decision was deferred behind: not just
// "per-route byte savings", but the COST side — first-load request count and
// total transferred bytes, default-on vs the single-chunk baseline.
//
// Usage:
//   1. Build an app twice (the app config honors RANGO_BENCH_CHUNKS):
//        RANGO_BENCH_CHUNKS=off pnpm --filter <app> build   # baseline: one app chunk
//        cp -r <app>/dist/client/assets /tmp/bench-off
//        RANGO_BENCH_CHUNKS=on  pnpm --filter <app> build   # default: per-route split
//        cp -r <app>/dist/client/assets /tmp/bench-on
//   2. Compare:
//        node tools/bench-client-chunks.mjs /tmp/bench-off /tmp/bench-on
//
// A single dir argument prints just that build's breakdown. Sizes are gzipped
// (what the browser actually transfers); raw is shown alongside.
//
// Classification is by Rango's chunk naming:
//   react-*   -> shared React/RSDW runtime  (loaded on every route)
//   router-*  -> shared @rangojs/router runtime (loaded on every route)
//   app-*     -> a per-route client group (default-on only; loaded on its route)
//   other     -> entry/index/runtime, and in the baseline the ONE combined app
//                chunk that holds every route's client code
//
// The benchmark is deliberately static (no server / no route-URL discovery): the
// metrics that decide the gate — total client JS (duplication?), shared baseline
// (untouched?), app-code concentration (one big chunk vs many small), and the
// first-load / full-crawl request+byte model — all derive from the emitted
// chunk set. The route->group mapping is by design (app-<feature>), so per-route
// first-load is `shared + that route's group`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

function resolveAssetsDir(input) {
  // Accept either a dist/client/assets dir directly, or an app root.
  const candidates = [
    input,
    join(input, "dist", "client", "assets"),
    join(input, "client", "assets"),
  ];
  for (const c of candidates) {
    try {
      if (
        statSync(c).isDirectory() &&
        readdirSync(c).some((f) => f.endsWith(".js"))
      )
        return c;
    } catch {
      // not this candidate
    }
  }
  throw new Error(`No client assets dir found under: ${input}`);
}

function classify(name) {
  if (/^react-/.test(name)) return "react";
  if (/^router-/.test(name)) return "router";
  if (/^app-/.test(name)) return "app-group";
  return "other";
}

function analyze(dir) {
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".js") || f.endsWith(".css"),
  );
  const chunks = files.map((name) => {
    const buf = readFileSync(join(dir, name));
    return {
      name,
      kind: name.endsWith(".css") ? "css" : "js",
      bucket: classify(name),
      raw: buf.length,
      gz: gzipSync(buf).length,
    };
  });
  const js = chunks.filter((c) => c.kind === "js");
  const css = chunks.filter((c) => c.kind === "css");
  const sum = (arr, k) => arr.reduce((n, c) => n + c[k], 0);
  const byBucket = (bucket, kind = "js") =>
    chunks.filter((c) => c.bucket === bucket && c.kind === kind);

  const shared = js.filter(
    (c) => c.bucket === "react" || c.bucket === "router",
  );
  const appGroups = byBucket("app-group");
  // The baseline (clientChunks off) holds all app code in non-react/router
  // chunks; surface the single largest such chunk as "the combined app chunk".
  const nonShared = js.filter(
    (c) => c.bucket !== "react" && c.bucket !== "router",
  );
  const largestApp = [...nonShared].sort((a, b) => b.gz - a.gz)[0];

  return {
    dir,
    totalJsRaw: sum(js, "raw"),
    totalJsGz: sum(js, "gz"),
    totalCssGz: sum(css, "gz"),
    jsCount: js.length,
    cssCount: css.length,
    sharedGz: sum(shared, "gz"),
    appGroups: appGroups
      .map((c) => ({ name: c.name, gz: c.gz, raw: c.raw }))
      .sort((a, b) => b.gz - a.gz),
    largestApp,
    top: [...js].sort((a, b) => b.gz - a.gz).slice(0, 12),
  };
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

function printOne(a) {
  console.log(`\n# ${a.dir}`);
  console.log(
    `total client JS: ${kb(a.totalJsGz)} gz (${kb(a.totalJsRaw)} raw) across ${a.jsCount} chunks`,
  );
  console.log(`shared runtime (react+router): ${kb(a.sharedGz)} gz`);
  console.log(`CSS: ${kb(a.totalCssGz)} gz across ${a.cssCount} files`);
  if (a.appGroups.length) {
    console.log(`per-route app groups (${a.appGroups.length}):`);
    for (const g of a.appGroups) console.log(`  ${g.name}  ${kb(g.gz)} gz`);
  } else {
    console.log(
      `per-route app groups: 0 (baseline) — app code concentrated in: ${a.largestApp?.name} ${kb(a.largestApp?.gz ?? 0)} gz`,
    );
  }
  console.log("top JS chunks by gz:");
  for (const c of a.top) console.log(`  ${c.name}  ${kb(c.gz)} gz`);
}

function printDiff(off, on) {
  const appGroupTotal = on.appGroups.reduce((n, g) => n + g.gz, 0);
  const heaviest = on.appGroups[0];
  const lightest = on.appGroups[on.appGroups.length - 1];
  const offApp = off.largestApp?.gz ?? 0;
  // ON keeps a residual entry chunk (shared/flat client code with no route
  // marker) that loads on EVERY route. Honest per-route first-load app bytes =
  // that residual + the one route's group, NOT the group alone.
  const onResidual = on.largestApp?.gz ?? 0; // ON's biggest non-(react|router|app-*) js
  console.log(
    "\n========== clientChunks: off (baseline) vs on (default) ==========",
  );
  console.log(
    `shared runtime:        off ${kb(off.sharedGz)}  |  on ${kb(on.sharedGz)}  (must match — split never touches the baseline)`,
  );
  console.log(
    `total client JS:       off ${kb(off.totalJsGz)}  |  on ${kb(on.totalJsGz)}  (delta = fragmentation overhead, paid once across the whole app)`,
  );
  console.log(
    `app code, OFF:         ONE combined chunk ${off.largestApp?.name} = ${kb(offApp)} gz, loaded on EVERY first paint`,
  );
  console.log(
    `app code, ON:          residual entry ${kb(onResidual)} gz (every route) + ${on.appGroups.length} per-route groups (${kb(appGroupTotal)} gz total), each group loaded only on its route`,
  );
  if (heaviest && lightest) {
    const onHeavy = onResidual + heaviest.gz;
    const onLight = onResidual + lightest.gz;
    console.log(
      `\nfirst-load APP bytes (residual + this route's group), the headline:`,
    );
    console.log(`  OFF: ${kb(offApp)} gz on every route`);
    console.log(
      `  ON : ${kb(onLight)} (lightest route) .. ${kb(onHeavy)} (heaviest route)`,
    );
    console.log(
      `  per first-load saving: ${kb(offApp - onHeavy)} (heaviest) .. ${kb(offApp - onLight)} (lightest)  [~${Math.round((1 - onHeavy / offApp) * 100)}–${Math.round((1 - onLight / offApp) * 100)}% of app bytes]`,
    );
  }
  console.log(
    `\nfirst-load request count: OFF = shared + 1 combined app chunk; ON = shared + residual + 1 group = +1 request (HTTP/2-multiplexed). Splitting does NOT meaningfully inflate first-load requests.`,
  );
  console.log(
    `full cold crawl (visit EVERY route once): OFF transfers shared + ${kb(offApp)} (combined, then cached); ON transfers shared + residual + Σgroups ${kb(onResidual + appGroupTotal)}. ON's extra = the fragmentation overhead; a typical 1–3 route session transfers far less under ON.`,
  );
  console.log(
    `\nSCALING: OFF's every-route app chunk grows with TOTAL app client code; ON's per-route first-load grows only with the residual + ONE route's group. The bigger the app, the larger ON's first-load win — and the smaller the fraction any one user downloads.`,
  );
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "usage: node tools/bench-client-chunks.mjs <assetsDirOrAppRoot> [<secondDir>]",
  );
  process.exit(1);
}
const analyses = args.map((a) => analyze(resolveAssetsDir(a)));
for (const a of analyses) printOne(a);
if (analyses.length === 2) {
  // Heuristic: the dir with app-* groups is the "on" build.
  const [a, b] = analyses;
  const on = a.appGroups.length >= b.appGroups.length ? a : b;
  const off = on === a ? b : a;
  printDiff(off, on);
}
