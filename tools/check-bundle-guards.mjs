#!/usr/bin/env node
/**
 * CI bundle guards (issue #761). Supersedes check-client-leaks.mjs.
 *
 * Builds each app with RANGO_ANALYZE=1 and asserts:
 *  1. LEAKS (every app): no server-only module, and no dev-only router
 *     module (the suspense audit), contributes bytes to the
 *     CLIENT metafile — same Sections 2/2b classification as
 *     tools/bundle-report.mjs, shared via tools/lib/bundle-stats.mjs.
 *     0-byte pattern hits are tree-shaken stubs and pass; ALLOWLIST entries
 *     carry a gzip cap and reason, and a match above its cap still fails.
 *  2. ROUTER RATCHET (cloudflare-basic): the emitted client `router-*.js`
 *     chunk stays under ROUTER_CHUNK_GZIP_MAX — catches client-runtime creep
 *     the rejected-optimizations list (AGENTS.md Bundle hygiene) exists to
 *     prevent. Baseline measured 2026-07-10: 33.2KB gzip; budget 50-60KB.
 *     Re-baselined 2026-07-26 at 42.4KB for clientUrls() — see the constant.
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
  ROUTER_DEV_ONLY_PATTERNS,
  ROUTER_SERVER_PATTERNS,
  appOwnedFilter,
  extractRows,
  matchLeakPatterns,
} from "./lib/bundle-stats.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Raised 40KB -> 43KB on 2026-07-26 for clientUrls() (PR #812), measured at
// 42443B on cloudflare-basic. This was a DELIBERATE call, not a red-check
// silencing: the runtime is still well inside the 50-60KB budget above, and the
// ratchet fired exactly as intended — it forced the decision below.
//
// What the +4.3KB buys, and the known wart: the clientUrls() runtime
// (client-urls/client-urls.ts ~11.7KB rendered, plus router/trie-matching.ts
// and router/route-trie-builder.ts, whose ONLY client-graph consumer it is)
// lands in the eager router chunk, so every page of every app pays for it —
// including apps that never call clientUrls(). In cloudflare-basic the feature
// is two routes behind a separate router at /__client-urls.
//
// Why it is not simply chunk-split: `manualChunks` returning undefined does not
// move it (measured: 42443B -> 41878B, only client-root.tsx relocates). The
// implementation is pinned by the static re-export at client.tsx:262, and both
// public barrels (src/client.tsx AND src/index.ts) sit in the eager chunk, so
// re-homing the export does not help either. The real fix is a dedicated
// `@rangojs/router/client-urls` subpath whose only importer is the consumer's
// "use client" definition module — a public API change, tracked separately.
// Do NOT raise this again to absorb that; land the split instead.
//
// Re-baselined 43KB -> 44KB on 2026-09-11 (PR #848). Main had crept to 44031B
// (1B under the limit) through work landed since #812, so the ratchet was
// tripping on chunk-shape noise: #848 adds no client runtime — the chunk diff
// vs main is plugin-rsc's client-reference registration order shifting because
// a "use client" module gained a second include() mount (+4B raw, +5B gzip).
// The clientUrls() split above is still the real fix for the eager cost.
//
// Raised 44KB -> 45KB on 2026-09-28 (PR #948), measured 45002B -> 45348B
// (+346B gzip, +1.14KB raw). A deliberate call: the default document now
// renders Html.ScrollRestoration, and components/DefaultDocument.tsx is in
// every app's client build (router.ts imports it as the `document` fallback),
// so initScrollRestoration lands in the eager router chunk even for apps whose
// own document never renders it. Keeping it out would mean lazy-loading the
// init out of browser/scroll-restoration.ts, whose module state the
// navigation bridge shares; judged not worth a chunk request for ~0.35KB.
//
// Raised 45KB -> 46KB on 2026-09-30 (PR #1006), measured 45375B -> 46805B
// (+1430B gzip). A deliberate call: transition({ when }) moved from the server
// to the browser, so its decision runs in the router chunk — the per-history-
// entry memory pop reads `from` from, the one decision helper and its five
// commit sites (navigation, clientUrls() optimistic swap, pop, action,
// revalidate), the RouteLocation/context builders and Def.read(location).
// None of it can load lazily: the decision is made synchronously at commit.
// Predicate modules themselves land in the entry chunk, not here.
//
// Raised 46KB -> 47KB on 2026-10-04 (issue #1029), measured 47077B -> 47262B
// (+185B gzip). A deliberate call: useLocationState reads the location state
// of the entry on screen from React state NavigationProvider holds next to
// the payload, instead of reading history.state itself, so a value can only
// render with its entry's tree. What grew: the snapshot every commit site
// records (location-state-shared.ts locationStateSnapshot), its holder on the
// event controller and the provider's context; the hook itself shrank. None
// of it can load lazily: the snapshot is recorded in the commit and read
// during render. The step is a whole KB because main sat 27B under the old
// limit: a smaller one would leave the ratchet tripping on the next change.
//
// Raised 47KB -> 48KB on 2026-10-07 for `prefetch: false`
// (docs/design/prefetch-false.md), measured 47488B -> 48837B (+1349B gzip).
// A deliberate call: adopting a payload with deferred segments is decided
// where every partial payload is committed, so the holes, the fill request
// and its merge live in browser/partial-update.ts (armHoles, fillHoles,
// releaseHoles), with the lanes of segment-system.tsx that must not await a
// hole (settlesLoaders). An app with no flag pays for it too: deferral is a
// property of the payload, known only once one arrives. None of it can load
// lazily: the holes are armed synchronously before the adoption renders, and
// partial-update.ts is on the rejected-splits list (AGENTS.md, Bundle
// hygiene).
//
// Raised 48KB -> 48.25KB on 2026-10-08 for the one-tree click of
// `prefetch: false`, measured 49146B -> 49353B (+207B gzip): a layout
// placeholder's holes wait for what its own loading() covers, and a fill
// whose segments differ hands each boundary its hole resolved instead of a
// node (browser/partial-update.ts fillHoles; each hole is a Defer,
// browser/defer.ts). Only as far as needed: a
// lazy split of the fill was measured and rejected (48532B + 1403B split,
// against 49142B unsplit).
//
// Raised 48.25KB -> 48.375KB on 2026-10-08: a flagged layout's holes wait
// apart from the holes outside it (+98B gzip; one Defer per hole since,
// browser/defer.ts, resolved by browser/partial-update.ts fillHoles). Measured on main 8c10cc9b (#1085, #1083, #1086): 49479B,
// against main's own 47501B.
//
// Raised on 2026-10-11 for issue #1103 (+313B gzip measured on main, 47925B
// -> 48238B): a partial response re-runs a route's handler and each loader on
// its own revalidation decision, so the browser merges handle pushes per run,
// not per segment bucket (handles/pushed-by.ts mergePartialHandleData), and
// resolveDeferredHandleValues keeps the pushedBy record aligned. None of it
// can load lazily: it runs in the commit of every navigation and action.
// Combined with `prefetch: false` it measured 49816B, so 48.75KB.
//
// Tightened 48.75KB -> 48.125KB on 2026-10-11: a clientUrls() loader's
// revalidate() runs on the server, so the browser's predicate collector and
// the X-Rango-Client-Reval header plumbing left the chunk (client-urls/
// revalidate-chain.ts, revalidation-protocol.ts, the decision code in
// navigation.ts and browser/partial-update.ts). Measured on
// feat/prefetch-false-0.23 76751f37: 49815B -> 49207B (-608B gzip).
//
// Raised 48.125KB -> 48.375KB on 2026-10-12 for three bug fixes after 0.23.0,
// measured on main 49251B: a history-cache navigation merges handles onto
// the target's cached handles (pushed-by.ts withSegmentHandles, the commit-
// time reader in navigation-bridge.ts) +137B; an intercept slot's held
// loaders merge with the server render (merge-segment-loaders.ts,
// thenable-status.ts settledValue) +69B; treeless location state waits for
// the reveal barrier (NavigationProvider.tsx) +11B. Together ~49468B.
//
// Raised 48.375KB -> 48.5KB on 2026-10-13 for `Component.use` in
// clientUrls() (dc-t45), measured on main d588d049 49388B -> 49497B (+109B
// gzip; +98B without the fixture group, whose imports of the helpers add
// export entries). A deliberate call the user approved with the feature: a
// group's path(), layout() and intercept() read the mounted component's
// `.use` and merge its items (client-urls/client-urls.ts componentUse), and
// `loader`, `loading`, `revalidate`, `transition` became module-level exports
// of `@rangojs/router/client`. None of it can load lazily: the flatten runs
// synchronously when the group's module evaluates. The predicate hoist and
// its shadow graph are build-side and cost the chunk nothing. One 128B step:
// main sat 148B under the old limit, and #1137 took ~124B. Measured on top of
// #1137 (2abd2527a) with the review fixes: 49601B.
//
// Raised 48.5KB -> 48.875KB on 2026-10-13 for dc-t28 (#1129), measured on
// main ae761c590 49602B -> 50037B (+435B gzip), in two parts, as the user
// decided for #1129 (dc-c155): split them, and keep useAction in both apps'
// action-failure fixtures. Router code +154B: a loader that throws on an
// action's revalidation throws at its read (segment-system.tsx
// buildLoaderStreams inPlace on the action lane, a loader redirect() kept in
// the route's content), useAction reports it as revalidationError
// (decode-loader-results.ts revalidationErrorOf, the bridge, partial-update.ts
// action mode, event-controller.ts), and StreamedLoaderErrorBoundary resets
// on its segment's and its ancestors' loader data. None of it can load
// lazily: it runs in the action commit. The other +281B is not router code:
// cloudflare-basic's action-failure fixture imports useAction for the first
// time (the chunk drops it in an app that never calls it), to pin
// revalidationError in both apps. useAction's getActionId guidance became
// dev-only in the same change (about 225B less for every app calling it).
//
// Raised 48.875KB -> 49KB on 2026-10-13 for dc-t56 (#1151), measured on main
// be7ef4e82 50037B -> 50135B (+98B gzip): useHref() and relative
// useRouter().push/replace/prefetch fill a parameterized include() mount from
// the route params (substitutePatternParams, already in the chunk for
// useReverse) instead of emitting a literal `/:accountId/...` URL. useHref
// reads the params through a string selector, so it re-renders only when the
// mount's own values change. None of it can load lazily: both hooks resolve
// during render or in the click handler. Trimmed from +183B before raising
// (no helper, no navigateTo wrapper, href() reused for the join). One 128B
// step: main sat 11B under the old limit.
//
// Raised 49KB -> 49.375KB on 2026-10-14 for the #1164/#1165 stack, measured on
// cloudflare-basic from main 5c9d4ddf0 50164B -> 50437B (+273B gzip; the same
// change measured +261B on e9d3fcd75, the rest is gzip interplay with #1173).
// Three 128B steps, the owner's call (dc-q41, then one more step) after
// trimming. Handle values and
// useSegments() commit with the page (useCommitAnchoredState in
// browser/react/use-handle.ts; its "use no memo" opt-out saved 107B), a
// `prefetch: false` adoption commits `loading` in flushSync, and a
// back/forward restored from the history cache animates under transition():
// handlePopstate (browser/navigation-bridge.ts) commits it on the next task
// behind a generation and history-key guard, and scroll-restoration.ts
// restores in that commit. None of it can load lazily: it runs in every
// navigation's commit and every popstate.
//
// Raised 49.375KB -> 49.5KB on 2026-10-22 for rango-t126, measured on
// cloudflare-basic from main d824ba672 50517B -> 50634B (+117B gzip): an
// intercept answer to a request that held no segments keeps the page under
// the slot (browser/intercept-utils.ts wholeInterceptMatched, applied where
// partial-update.ts unpacks every partial answer). It cannot load lazily: it
// runs on every navigation and action response. One 128B step, the owner's
// call.
//
// Raised 49.5KB -> 50KB on 2026-10-22 for rango-t108, measured on
// cloudflare-basic with main d824ba672's browser source 50516B -> 50782B
// (+266B gzip): an action that did not land on the page on screen owes it one
// follow-up revalidation, which the batch's last exit runs after the
// navigation the user started settles, its stream and fill included
// (server-action-bridge.ts followUp, NavigationEntry.settled), never twice at
// once and never over a newer action's commit; and a prefetch is served
// during an action's flight. None of it can load lazily: it runs at every
// action's exit, and the action bridge is not split (AGENTS.md Bundle
// hygiene). Rounded up to 50KB, the owner's call (rango-t108 D4, then the
// review fixes).
const ROUTER_CHUNK_GZIP_MAX = 50 * 1024;
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
    ...matchLeakPatterns(rows, ROUTER_DEV_ONLY_PATTERNS),
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
