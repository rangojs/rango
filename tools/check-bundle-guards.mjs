#!/usr/bin/env node
/**
 * CI bundle guards (issue #761). Supersedes check-client-leaks.mjs.
 *
 * Builds each app with RANGO_ANALYZE=1 and asserts:
 *  1. LEAKS (every app): no server-only module contributes bytes to the
 *     CLIENT metafile — same Sections 2/2b classification as
 *     tools/bundle-report.mjs, shared via tools/lib/bundle-stats.mjs.
 *     0-byte pattern hits are tree-shaken stubs and pass; ALLOWLIST entries
 *     carry a gzip cap and reason, and a match above its cap still fails.
 *  2. ROUTER RATCHET (cloudflare-basic): the emitted client `router-*.js`
 *     chunk stays under ROUTER_CHUNK_GZIP_MAX — catches client-runtime creep
 *     the rejected-optimizations list (AGENTS.md Bundle hygiene) exists to
 *     prevent. Baseline measured 2026-07-10: 33.2KB gzip; budget 50-60KB.
 *  3. EAGER MANIFEST CEILING (cloudflare-stress-demo): the eager
 *     `virtual:rsc-router/routes-manifest` module stays tiny in the RSC
 *     metafile. Measured 284B gzip at 26k routes; the regression mode is
 *     route data inlined eagerly (commit d10a2470, -219KB when fixed). The
 *     single-router shape of this is also guarded structurally by
 *     e2e/build-test-app.setup.ts; this asserts it at stress scale.
 *
 * Default apps balance coverage against CI minutes (CF + node presets +
 * stress scale). `--all` sweeps every analyzer-wired app (bundle-analysis
 * skill / nightly use).
 *
 * Usage: node tools/check-bundle-guards.mjs [--all]
 *        (root script: check:bundle-guards)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  APP_SERVER_PATTERNS,
  ROUTER_SERVER_PATTERNS,
  appOwnedFilter,
  extractRows,
  matchLeakPatterns,
} from "./lib/bundle-stats.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ROUTER_CHUNK_GZIP_MAX = 40 * 1024;
const EAGER_MANIFEST_GZIP_MAX = 2 * 1024;

const DEFAULT_APPS = [
  "tests/cloudflare-basic",
  "tests/cloudflare-stress-demo",
  "packages/rangojs-router/e2e/test-app",
];
const ALL_APPS = [
  ...DEFAULT_APPS,
  "examples/cloudflare-basic-nonce",
  "examples/cloudflare-multi-router",
  "packages/rangojs-router/e2e/e2e-basic",
];

// Known-benign modules matching a server pattern: path regex + max gzip
// bytes + reason. A match above its cap still fails.
const ALLOWLIST = [
  {
    re: /\/packages\/rangojs-router\/src\/rsc\/nonce\.ts$/,
    maxGzip: 256,
    reason: "public ContextVar token; crypto tree-shaken",
  },
];

const apps = process.argv.includes("--all") ? ALL_APPS : DEFAULT_APPS;

function shorten(p) {
  return p.replace(`${ROOT}/`, "");
}

function buildApp(appDir) {
  rmSync(resolve(appDir, "dist"), { recursive: true, force: true });
  rmSync(resolve(appDir, "bundle-stats"), { recursive: true, force: true });
  // Direct binary when available; the pnpm wrapper can fail locally
  // (verifyDepsBeforeRun) — see AGENTS.md environment gotchas.
  const localVite = resolve(appDir, "node_modules/.bin/vite");
  const [cmd, args] = existsSync(localVite)
    ? [localVite, ["build"]]
    : ["pnpm", ["exec", "vite", "build"]];
  console.log(`\nBuilding ${shorten(appDir)} with RANGO_ANALYZE=1 ...`);
  execFileSync(cmd, args, {
    cwd: appDir,
    stdio: "inherit",
    env: { ...process.env, RANGO_ANALYZE: "1" },
  });
}

function readRows(appDir, env) {
  const stats = resolve(appDir, `bundle-stats/${env}.json`);
  if (!existsSync(stats)) return null;
  return extractRows(JSON.parse(readFileSync(stats, "utf8")));
}

function checkLeaks(app, rows, failures) {
  const found = [
    ...matchLeakPatterns(rows, ROUTER_SERVER_PATTERNS),
    ...matchLeakPatterns(rows, APP_SERVER_PATTERNS, appOwnedFilter),
  ];
  const seen = new Set();
  for (const f of found) {
    for (const file of f.files) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      if (file.gzip === 0 && file.rendered === 0) continue;
      const entry = ALLOWLIST.find((a) => a.re.test(file.path));
      if (entry && file.gzip <= entry.maxGzip) {
        console.log(
          `Allowlisted: ${shorten(file.path)} (${file.gzip}B gzip <= ${entry.maxGzip}B cap; ${entry.reason})`,
        );
      } else {
        const capNote = entry
          ? ` (allowlisted at ${entry.maxGzip}B cap — exceeded)`
          : "";
        failures.push(
          `[${app}] LEAK: ${shorten(file.path)} — ${file.gzip}B gzip / ${file.rendered}B rendered (pattern: ${f.pat})${capNote}`,
        );
      }
    }
  }
  console.log(`[${app}] leak scan: ${rows.length} client modules.`);
}

function checkRouterRatchet(app, appDir, failures) {
  const assetsDir = resolve(appDir, "dist/client/assets");
  const chunk = existsSync(assetsDir)
    ? readdirSync(assetsDir).find((f) => /^router-.*\.js$/.test(f))
    : undefined;
  if (!chunk) {
    failures.push(
      `[${app}] RATCHET: no client router-*.js chunk found — getManualChunks shape changed?`,
    );
    return;
  }
  const gzip = gzipSync(readFileSync(join(assetsDir, chunk))).length;
  console.log(
    `[${app}] router chunk ${chunk}: ${gzip}B gzip (max ${ROUTER_CHUNK_GZIP_MAX}B).`,
  );
  if (gzip > ROUTER_CHUNK_GZIP_MAX) {
    failures.push(
      `[${app}] RATCHET: client router chunk ${chunk} is ${gzip}B gzip > ${ROUTER_CHUNK_GZIP_MAX}B. ` +
        `New client runtime crept in — see AGENTS.md Bundle hygiene (rejected optimizations) before raising the limit.`,
    );
  }
}

function checkEagerManifestCeiling(app, appDir, failures) {
  const rows = readRows(appDir, "rsc");
  if (!rows) {
    failures.push(`[${app}] CEILING: missing rsc metafile.`);
    return;
  }
  // Exact eager module id (resolveId returns "\0" + the virtual id verbatim);
  // per-router lazy modules carry a "/<routerId>" suffix.
  const eager = rows.find(
    (r) => r.path === "\0virtual:rsc-router/routes-manifest",
  );
  if (!eager) {
    failures.push(
      `[${app}] CEILING: eager routes-manifest module not found in the rsc metafile.`,
    );
    return;
  }
  console.log(
    `[${app}] eager routes-manifest: ${eager.gzip}B gzip (max ${EAGER_MANIFEST_GZIP_MAX}B).`,
  );
  if (eager.gzip > EAGER_MANIFEST_GZIP_MAX) {
    failures.push(
      `[${app}] CEILING: eager routes-manifest is ${eager.gzip}B gzip > ${EAGER_MANIFEST_GZIP_MAX}B — ` +
        `route data is being inlined eagerly again (regression mode of d10a2470).`,
    );
  }
}

const failures = [];
for (const app of apps) {
  const appDir = resolve(ROOT, app);
  buildApp(appDir);
  const clientRows = readRows(appDir, "client");
  if (!clientRows) {
    failures.push(`[${app}] missing client metafile after analyzer build.`);
    continue;
  }
  checkLeaks(app, clientRows, failures);
  if (app === "tests/cloudflare-basic") {
    checkRouterRatchet(app, appDir, failures);
  }
  if (app === "tests/cloudflare-stress-demo") {
    checkEagerManifestCeiling(app, appDir, failures);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} bundle-guard failure(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nTriage with the bundle-analysis skill (packages/rangojs-router/skills/bundle-analysis/SKILL.md):`,
  );
  console.error(
    `  full report: node tools/bundle-report.mjs; treemaps: <app>/bundle-stats/*.html`,
  );
  console.error(
    `A truly benign leak gets an ALLOWLIST entry in tools/check-bundle-guards.mjs with a cap and reason.`,
  );
  process.exit(1);
}

console.log(`\nOK: bundle guards green across ${apps.length} app(s).`);
