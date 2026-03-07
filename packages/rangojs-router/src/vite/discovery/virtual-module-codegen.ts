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
        // Routers without sourceFile: inline their manifest data directly
        routersWithoutGenFile.push({
          id: entry.id,
          manifest: entry.routeManifest,
        });
      }
    }

    const lines = [
      `import { setCachedManifest, setPrecomputedEntries, setRouteTrie, setRouterManifest, registerRouterManifestLoader, clearAllRouterData } from "@rangojs/router/server";`,
      ...genFileImports,
      // Clear stale per-router cached data (manifest, trie, precomputed entries)
      // before re-populating. In Cloudflare dev mode, program reloads re-evaluate
      // this virtual module but the route-map-builder singleton retains old data
      // because it's not in the HMR invalidation chain. Without this clear, the
      // handler finds stale trie data and never rebuilds from updated urlpatterns.
      `clearAllRouterData();`,
    ];

    // Flatten NamedRoutes entries: search schema objects -> plain string paths
    if (genFileVars.length > 0) {
      lines.push(
        `function __flat(r) { const o = {}; for (const [k, v] of Object.entries(r)) o[k] = typeof v === "string" ? v : v.path; return o; }`,
      );
    }

    // Build the merged manifest from gen file imports + inlined data
    if (genFileVars.length === 1 && routersWithoutGenFile.length === 0) {
      lines.push(`setCachedManifest(__flat(${genFileVars[0]}));`);
    } else {
      const parts: string[] = [];
      for (const v of genFileVars) parts.push(`...__flat(${v})`);
      for (const { manifest } of routersWithoutGenFile)
        parts.push(`...${jsonParseExpression(manifest)}`);
      lines.push(`setCachedManifest({ ${parts.join(", ")} });`);
    }

    // Set per-router manifests
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

    // In dev mode, skip trie and precomputed entries injection. These are
    // computed once during initial discovery and become stale after route
    // changes. A stale trie would incorrectly match removed routes. The
    // handler falls back to Phase 2 regex matching against the live
    // router.urlpatterns, which is always correct after a program reload.
    // In build mode, the trie is always fresh (built from the final route
    // tree) so it's safe to inject.
    if (state.isBuildMode) {
      if (
        state.mergedPrecomputedEntries &&
        state.mergedPrecomputedEntries.length > 0
      ) {
        lines.push(
          `setPrecomputedEntries(${jsonParseExpression(state.mergedPrecomputedEntries)});`,
        );
      }
      if (state.mergedRouteTrie) {
        lines.push(
          `setRouteTrie(${jsonParseExpression(state.mergedRouteTrie)});`,
        );
      }
    }

    // Register lazy loaders for per-router manifest modules.
    // Each import() uses a static string literal so Rollup creates separate chunks.
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

  // No manifest: either discovery hasn't completed or no runner (Cloudflare dev).
  // Still inject __PRERENDER_DEV_URL so the prerender store can fetch on-demand.
  // Re-resolve origin now since the server is listening by module load time.
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
    // Import manifest from the gen file so HMR auto-propagates
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
  return lines.join("\n") || "// empty router manifest";
}
