#!/usr/bin/env node
/**
 * CI guard for server-code-in-client-bundle leaks.
 *
 * Builds tests/cloudflare-basic with RANGO_ANALYZE=1, then runs the same
 * server-in-client classification as tools/bundle-report.mjs Sections 2/2b
 * (shared via tools/lib/bundle-stats.mjs) against the CLIENT metafile.
 * Exits non-zero when any server-only module contributes bytes to the client
 * bundle beyond the ALLOWLIST below. 0-byte pattern hits are tree-shaken
 * stubs and pass.
 *
 * Usage: node tools/check-client-leaks.mjs   (root script: check:client-leaks)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_SERVER_PATTERNS,
  ROUTER_SERVER_PATTERNS,
  appOwnedFilter,
  extractRows,
  matchLeakPatterns,
} from "./lib/bundle-stats.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_DIR = resolve(ROOT, "tests/cloudflare-basic");
const CLIENT_STATS = resolve(APP_DIR, "bundle-stats/client.json");

// Known-benign modules matching a server pattern: path regex + max gzip
// bytes + reason. A match above its cap still fails.
const ALLOWLIST = [
  {
    re: /\/packages\/rangojs-router\/src\/rsc\/nonce\.ts$/,
    maxGzip: 256,
    reason: "public ContextVar token; crypto tree-shaken",
  },
];

function buildApp() {
  rmSync(resolve(APP_DIR, "dist"), { recursive: true, force: true });
  rmSync(resolve(APP_DIR, "bundle-stats"), { recursive: true, force: true });
  // Direct binary when available; the pnpm wrapper can fail locally
  // (verifyDepsBeforeRun) — see AGENTS.md environment gotchas.
  const localVite = resolve(APP_DIR, "node_modules/.bin/vite");
  const [cmd, args] = existsSync(localVite)
    ? [localVite, ["build"]]
    : ["pnpm", ["exec", "vite", "build"]];
  console.log(`Building tests/cloudflare-basic with RANGO_ANALYZE=1 ...`);
  execFileSync(cmd, args, {
    cwd: APP_DIR,
    stdio: "inherit",
    env: { ...process.env, RANGO_ANALYZE: "1" },
  });
}

buildApp();

if (!existsSync(CLIENT_STATS)) {
  console.error(
    `Missing ${relative(ROOT, CLIENT_STATS)} — the analyzer did not emit the client metafile.`,
  );
  process.exit(1);
}
const rows = extractRows(JSON.parse(readFileSync(CLIENT_STATS, "utf8")));

const found = [
  ...matchLeakPatterns(rows, ROUTER_SERVER_PATTERNS),
  ...matchLeakPatterns(rows, APP_SERVER_PATTERNS, appOwnedFilter),
];

const leaks = [];
const allowed = [];
const seen = new Set();
for (const f of found) {
  for (const file of f.files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    // Tree-shaken stub guard; extractRows already drops 0-byte rows.
    if (file.gzip === 0 && file.rendered === 0) continue;
    const entry = ALLOWLIST.find((a) => a.re.test(file.path));
    if (entry && file.gzip <= entry.maxGzip) {
      allowed.push({ file, entry });
    } else {
      leaks.push({ file, pat: f.pat, entry });
    }
  }
}

function shorten(p) {
  return p.replace(`${ROOT}/`, "");
}

for (const { file, entry } of allowed) {
  console.log(
    `Allowlisted: ${shorten(file.path)} (${file.gzip}B gzip <= ${entry.maxGzip}B cap; ${entry.reason})`,
  );
}

if (leaks.length > 0) {
  console.error(
    `\nREAL LEAK: ${leaks.length} server-only module(s) contribute bytes to the tests/cloudflare-basic CLIENT bundle:\n`,
  );
  for (const { file, pat, entry } of leaks) {
    const capNote = entry
      ? ` (allowlisted at ${entry.maxGzip}B cap — exceeded)`
      : "";
    console.error(
      `  - ${shorten(file.path)} — ${file.gzip}B gzip / ${file.rendered}B rendered (pattern: ${pat})${capNote}`,
    );
  }
  console.error(
    `\nTriage with the bundle-analysis skill (packages/rangojs-router/skills/bundle-analysis/SKILL.md):`,
  );
  console.error(
    `  full report: node tools/bundle-report.mjs; treemap: tests/cloudflare-basic/bundle-stats/client.html`,
  );
  console.error(
    `A truly benign module gets an ALLOWLIST entry in tools/check-client-leaks.mjs with a cap and reason.`,
  );
  process.exit(1);
}

console.log(
  `OK: no server code leaks into the client bundle (${rows.length} client modules scanned; ${allowed.length} allowlisted).`,
);
