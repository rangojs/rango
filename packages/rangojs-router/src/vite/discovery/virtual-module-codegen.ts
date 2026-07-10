/**
 * Virtual Module Code Generation
 *
 * Generates the code for virtual:rsc-router/routes-manifest and
 * per-router virtual modules used by the load() hook.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { jsonParseExpression } from "../utils/manifest-utils.js";
import { VIRTUAL_ROUTES_MANIFEST_ID } from "./state.js";
import type { DiscoveryState } from "./state.js";

/**
 * Serialized-payload size (bytes) at or above which the trie/precomputedEntries
 * are shipped through a runtime channel (Text module / `?raw` import) instead of
 * an inline `JSON.parse` literal (issue #665). 512KB is ~2500 routes — the
 * crossover where the channel's benefit (removing the JS compile on cloudflare,
 * reclaiming ~19% escaping bloat everywhere) clears the cost of an extra
 * artifact. Below it the inline literal wins (sub-millisecond compile, ~0 gain),
 * so the whole long tail of normal apps stays byte-identical. The compile/parse
 * cost tracks bytes, not route count, so this stays a byte threshold.
 * RANGO_MANIFEST_TEXT=1 bypasses it.
 */
const MANIFEST_EXTERNALIZE_THRESHOLD = 512 * 1024;

/**
 * Generate the code for the main virtual:rsc-router/routes-manifest module.
 */
export function generateRoutesManifestModule(state: DiscoveryState): string {
  const hasManifest =
    state.mergedRouteManifest &&
    Object.keys(state.mergedRouteManifest).length > 0;

  if (hasManifest) {
    // Build gen file import statements for each router with a sourceFile.
    // This creates a dependency in Vite's module graph: when the gen file
    // changes (e.g. after HMR route edits), Vite invalidates this virtual
    // module and re-evaluates it on the next request, calling
    // setCachedManifest() with fresh data. No manual sync needed.
    const genFileImports: string[] = [];
    // Per-entry NamedRoutes import var, aligned with perRouterManifests
    // (null for routers without a gen file).
    const genFileVarByEntry: Array<string | null> = [];
    let varIdx = 0;

    for (const entry of state.perRouterManifests) {
      if (entry.sourceFile) {
        const routerDir = dirname(entry.sourceFile);
        const routerBasename = basename(entry.sourceFile).replace(
          /\.(tsx?|jsx?)$/,
          "",
        );
        const genPath = join(
          routerDir,
          `${routerBasename}.named-routes.gen.js`,
        ).replaceAll("\\", "/");
        const varName = `_r${varIdx++}`;
        genFileImports.push(
          `import { NamedRoutes as ${varName} } from ${JSON.stringify(genPath)};`,
        );
        genFileVarByEntry.push(varName);
      } else {
        genFileVarByEntry.push(null);
      }
    }

    const serverImports = [
      "setCachedManifest",
      "setRouterManifest",
      ...(state.isBuildMode ? ["registerRouterManifestLoader"] : []),
      "clearAllRouterData",
    ];
    const lines = [
      `import { ${serverImports.join(", ")} } from "@rangojs/router/server";`,
      ...genFileImports,
      // Clear stale per-router cached data (manifest, trie, precomputed entries)
      // before re-populating. In Cloudflare dev mode, program reloads re-evaluate
      // this virtual module but the route-map-builder singleton retains old data
      // because it's not in the HMR invalidation chain. Without this clear, the
      // handler finds stale trie data and never rebuilds from updated urlpatterns.
      `clearAllRouterData();`,
    ];

    if (varIdx > 0) {
      lines.push(
        `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
      );
    }

    // Each router's flattened map is materialized ONCE and the same object is
    // shared between the global cachedManifest and the per-router map (a
    // single-router app previously held two byte-identical maps, and __flat
    // ran twice per router on cold start). Sharing is safe: every consumer
    // reads these maps; lazy-include deltas mutate globalRouteMap, a different
    // object (see registerRouteMap in route-map-builder.ts).
    const routerMapVars: string[] = [];
    for (const [i, entry] of state.perRouterManifests.entries()) {
      const mapVar = `__m${i}`;
      const genVar = genFileVarByEntry[i];
      const init = genVar
        ? `__flat(${genVar})`
        : jsonParseExpression(entry.routeManifest);
      lines.push(`const ${mapVar} = ${init};`);
      routerMapVars.push(mapVar);
    }

    if (routerMapVars.length === 1) {
      lines.push(`setCachedManifest(${routerMapVars[0]});`);
    } else {
      lines.push(
        `setCachedManifest({ ${routerMapVars.map((v) => `...${v}`).join(", ")} });`,
      );
    }

    for (const [i, entry] of state.perRouterManifests.entries()) {
      lines.push(
        `setRouterManifest(${JSON.stringify(entry.id)}, ${routerMapVars[i]});`,
      );
    }

    // Per-router trie and precomputedEntries are NOT inlined eagerly.
    // They live in the per-router lazy chunks (generatePerRouterModule) and
    // are loaded via ensureRouterManifest(routerId), which is awaited before
    // every request in router.fetch() and before findMatch is reached
    // (Bundle Hygiene rule #1: route data in exactly one lazy chunk).
    //
    // In dev mode, the handler also falls back to Phase 2 regex matching
    // against live router.urlpatterns, which is always correct after a
    // program reload.

    // Loaders are registered in BUILD only. ensureRouterManifest() marks a
    // loader-supplied trie authoritative (misses are hard 404s), which is only
    // valid for a build-time trie from complete discovery. In dev the loader
    // would preempt the handler's buildRouterTrieFromUrlpatterns fallback
    // (rsc/handler.ts) and can install a STALE trie after a Cloudflare program
    // reload: the per-router virtual module's only invalidation edge is the
    // gen-file import, which lags the urls.tsx edit by one reload cycle, so a
    // browser full-reload landing in that window renders a removed route from
    // the stale-but-authoritative trie and never converges. Dev must always
    // rebuild from live router.urlpatterns instead.
    if (state.isBuildMode) {
      for (const routerId of state.perRouterManifestDataMap.keys()) {
        lines.push(
          `registerRouterManifestLoader(${JSON.stringify(routerId)}, () => import(${JSON.stringify(VIRTUAL_ROUTES_MANIFEST_ID + "/" + routerId)}));`,
        );
      }
    }
    if (!state.isBuildMode && state.devServerOrigin) {
      lines.push(
        `globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(state.devServerOrigin)};`,
      );
    }
    return lines.join("\n");
  }

  if (!state.isBuildMode) {
    const origin =
      state.devServerOrigin ||
      state.devServer?.resolvedUrls?.local?.[0]?.replace(/\/$/, "") ||
      (state.devServer &&
        `http://localhost:${state.devServer.config.server.port || 5173}`);
    if (origin) {
      state.devServerOrigin = origin;
      return `globalThis.__PRERENDER_DEV_URL = ${JSON.stringify(origin)};`;
    }
  }
  return `// Route manifest will be populated at runtime`;
}

/**
 * Deterministic short hash (FNV-1a, base36) used to disambiguate staged
 * manifest filenames. The sanitized `safeId` alone collapses distinct router
 * ids — e.g. "a/b" and "a.b" both sanitize to "a_b" — which in a multi-router
 * build would overwrite one router's staged manifest with another's. Appending
 * a hash of the ORIGINAL id keeps them distinct.
 */
function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Generate the code for a per-router virtual module.
 */
export function generatePerRouterModule(
  state: DiscoveryState,
  routerId: string,
): string {
  const sourceFile = state.perRouterManifests.find(
    (e) => e.id === routerId,
  )?.sourceFile;
  const trie = state.perRouterTrieMap.get(routerId);
  const entries = state.perRouterPrecomputedMap.get(routerId);
  const lines: string[] = [];

  // No name->path map here: the eager routes-manifest module already calls
  // setRouterManifest() with __flat(NamedRoutes) for every router, so this
  // module carries only the derived match data (trie + precomputedEntries).
  // The bare gen-file import is load-bearing: it is the module-graph edge that
  // invalidates this module when routes change in dev. Without it, a Cloudflare
  // dev program reload re-imports the cached module and ensureRouterManifest()
  // re-installs a stale authoritative trie (wrong 404s until full restart).
  if (sourceFile) {
    const routerDir = dirname(sourceFile);
    const routerBasename = basename(sourceFile).replace(/\.(tsx?|jsx?)$/, "");
    const genPath = join(
      routerDir,
      `${routerBasename}.named-routes.gen.js`,
    ).replaceAll("\\", "/");
    lines.push(`import ${JSON.stringify(genPath)};`);
  }
  const hasTrie = !!trie;
  const hasEntries = !!entries && entries.length > 0;

  // The trie + precomputedEntries are the largest generated data. Inlined as a
  // `JSON.parse('<literal>')` in the JS chunk, the isolate/process must LEX and
  // compile that multi-MB source literal on first request before JSON.parse even
  // runs — pure overhead, since it is data, not logic (issue #665). It also
  // ships bloated: the build minifier re-quotes the literal to double quotes,
  // escaping every JSON `"` as `\"` (measured 5.71MB vs 4.64MB un-escaped at 26k
  // routes).
  //
  // The ONLY way to fix both is to keep the JSON out of JavaScript source — as a
  // raw asset file that never passes through the JS minifier/compiler. On
  // cloudflare that is a workerd Text module: import the staged `.txt` and the
  // isolate gets the raw un-escaped bytes as a string with no compile pass
  // (measured ~17% / ~88ms cold first-hit on a real edge deploy at 26k, and it
  // shrinks the worker upload). The CF vite plugin types `.txt` as Text;
  // wrangler's default rules type **/*.txt as Text for deploy and dev.
  //
  // Scoped to cloudflare deliberately. A Text module is the only no-JS byte
  // channel that needs no filesystem, and cloudflare is where it pays: edge cold
  // isolates spin up per-request under load and on every deploy, and Workers
  // have a hard upload-size limit. node/vercel fall through to the inline
  // literal below — an efficient runtime channel there needs `fs` (a raw asset
  // read), whose fragility (asset co-location, runtime ENOENT) is not worth a
  // large-app-only win that Fluid Compute amortizes and that essentially no real
  // app reaches. `?raw` is NOT an option: in this build it inlines the JSON as a
  // (double-quoted, compiled) JS string literal — same bloat, same compile as
  // the inline form, plus a staged file for nothing.
  //
  // Build mode only (dev rebuilds the manifest per HMR; parse cost is
  // irrelevant). Below MANIFEST_EXTERNALIZE_THRESHOLD the inline literal wins.
  // RANGO_MANIFEST_TEXT overrides: "0" forces inline, "1" forces the Text module
  // and bypasses the threshold (used by the cloudflare-basic dogfood e2e, whose
  // real manifest is below the threshold).
  const preset = state.opts?.preset ?? "node";
  const override = process.env.RANGO_MANIFEST_TEXT;
  const payload = manifestPayload(trie, hasTrie, entries, hasEntries);
  const payloadJson = hasTrie || hasEntries ? JSON.stringify(payload) : "";
  const useTextModule =
    state.isBuildMode &&
    preset === "cloudflare" &&
    override !== "0" &&
    (hasTrie || hasEntries) &&
    (override === "1" || payloadJson.length >= MANIFEST_EXTERNALIZE_THRESHOLD);

  if (useTextModule) {
    const dir = join(state.projectRoot, "node_modules", ".rango");
    mkdirSync(dir, { recursive: true });
    const safeId = `${routerId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${shortHash(routerId)}`;
    const filePath = join(dir, `manifest-${safeId}.txt`).replaceAll("\\", "/");
    writeFileSync(filePath, payloadJson);
    lines.push(`import __manifestJson from ${JSON.stringify(filePath)};`);
    lines.push(`const __manifestData = JSON.parse(__manifestJson);`);
    emitManifestExports(lines, hasTrie, hasEntries);
    return lines.join("\n");
  }

  if (hasTrie) {
    lines.push(`export const trie = ${jsonParseExpression(trie)};`);
  }
  if (hasEntries) {
    lines.push(
      `export const precomputedEntries = ${jsonParseExpression(entries)};`,
    );
  }
  return lines.join("\n") || "";
}

function manifestPayload(
  trie: unknown,
  hasTrie: boolean,
  entries: unknown,
  hasEntries: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (hasTrie) payload.t = trie;
  if (hasEntries) payload.p = entries;
  return payload;
}

function emitManifestExports(
  lines: string[],
  hasTrie: boolean,
  hasEntries: boolean,
): void {
  if (hasTrie) lines.push(`export const trie = __manifestData.t;`);
  if (hasEntries)
    lines.push(`export const precomputedEntries = __manifestData.p;`);
}
