/**
 * Virtual Module Code Generation
 *
 * Generates the code for virtual:rsc-router/routes-manifest and
 * per-router virtual modules used by the load() hook.
 */

import { dirname, basename, join } from "node:path";
import { jsonParseExpression } from "../utils/manifest-utils.js";
import { VIRTUAL_ROUTES_MANIFEST_ID } from "./state.js";
import type { DiscoveryState } from "./state.js";

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
    const genFileVars: string[] = [];
    const routersWithoutGenFile: Array<{
      id: string;
      manifest: Record<string, string>;
    }> = [];
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
        genFileVars.push(varName);
      } else {
        routersWithoutGenFile.push({
          id: entry.id,
          manifest: entry.routeManifest,
        });
      }
    }

    const lines = [
      `import { setCachedManifest, setRouterManifest, registerRouterManifestLoader, clearAllRouterData } from "@rangojs/router/server";`,
      ...genFileImports,
      // Clear stale per-router cached data (manifest, trie, precomputed entries)
      // before re-populating. In Cloudflare dev mode, program reloads re-evaluate
      // this virtual module but the route-map-builder singleton retains old data
      // because it's not in the HMR invalidation chain. Without this clear, the
      // handler finds stale trie data and never rebuilds from updated urlpatterns.
      `clearAllRouterData();`,
    ];

    if (genFileVars.length > 0) {
      lines.push(
        `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
      );
    }

    if (genFileVars.length === 1 && routersWithoutGenFile.length === 0) {
      lines.push(`setCachedManifest(__flat(${genFileVars[0]}));`);
    } else {
      const parts: string[] = [];
      for (const v of genFileVars) parts.push(`...__flat(${v})`);
      for (const { manifest } of routersWithoutGenFile)
        parts.push(`...${jsonParseExpression(manifest)}`);
      lines.push(`setCachedManifest({ ${parts.join(", ")} });`);
    }

    let genVarIdx = 0;
    for (const entry of state.perRouterManifests) {
      if (entry.sourceFile) {
        const varName = genFileVars[genVarIdx++];
        lines.push(
          `setRouterManifest(${JSON.stringify(entry.id)}, __flat(${varName}));`,
        );
      } else {
        lines.push(
          `setRouterManifest(${JSON.stringify(entry.id)}, ${jsonParseExpression(entry.routeManifest)});`,
        );
      }
    }

    // Per-router trie and precomputedEntries are NOT inlined eagerly.
    // They live in the per-router lazy chunks (generatePerRouterModule) and
    // are loaded via ensureRouterManifest(routerId), which is awaited before
    // every request in router.fetch() and before findMatch is reached.
    // Inlining the merged versions here would duplicate the per-router data
    // (the merged trie/precomputedEntries equal the per-router data for
    // single-router apps; for multi-router, the merged trie is dead code
    // because find-match.ts only consumes per-router tries).
    //
    // In dev mode, the handler also falls back to Phase 2 regex matching
    // against live router.urlpatterns, which is always correct after a
    // program reload.

    for (const routerId of state.perRouterManifestDataMap.keys()) {
      lines.push(
        `registerRouterManifestLoader(${JSON.stringify(routerId)}, () => import(${JSON.stringify(VIRTUAL_ROUTES_MANIFEST_ID + "/" + routerId)}));`,
      );
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
 * Generate the code for a per-router virtual module.
 */
export function generatePerRouterModule(
  state: DiscoveryState,
  routerId: string,
): string {
  // Find the per-router entry to get the gen file path
  const routerEntry = state.perRouterManifests.find((e) => e.id === routerId);
  const trie = state.perRouterTrieMap.get(routerId);
  const entries = state.perRouterPrecomputedMap.get(routerId);
  const lines: string[] = [];

  if (routerEntry?.sourceFile) {
    const routerDir = dirname(routerEntry.sourceFile);
    const routerBasename = basename(routerEntry.sourceFile).replace(
      /\.(tsx?|jsx?)$/,
      "",
    );
    const genPath = join(
      routerDir,
      `${routerBasename}.named-routes.gen.js`,
    ).replaceAll("\\", "/");
    lines.push(`import { NamedRoutes as _r } from ${JSON.stringify(genPath)};`);
    lines.push(
      `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
    );
    lines.push(`export const manifest = __flat(_r);`);
  } else {
    const manifest = state.perRouterManifestDataMap.get(routerId);
    if (manifest) {
      lines.push(`export const manifest = ${jsonParseExpression(manifest)};`);
    }
  }
  if (trie) {
    lines.push(`export const trie = ${jsonParseExpression(trie)};`);
  }
  if (entries && entries.length > 0) {
    lines.push(
      `export const precomputedEntries = ${jsonParseExpression(entries)};`,
    );
  }
  return lines.join("\n") || "";
}
