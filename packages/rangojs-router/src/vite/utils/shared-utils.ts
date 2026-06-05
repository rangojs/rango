import type { Plugin, ResolvedConfig } from "vite";
import * as Vite from "vite";
import { getPublishedPackageName } from "./package-resolution.js";
import { performanceTracksOptimizeDepsPlugin } from "../plugins/performance-tracks.js";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  getVirtualVersionContent,
  VIRTUAL_IDS,
} from "../plugins/virtual-entries.js";

// Cloudflare preset: @cloudflare/vite-plugin sets optimizeDeps.entries (string
// or array) on the rsc environment. Single source for both the discovery plugin
// and the version injector so they target the same entry.
export function resolveRscEntryFromConfig(
  config: ResolvedConfig,
): string | undefined {
  const entries = (config.environments as any)?.["rsc"]?.optimizeDeps?.entries;
  if (typeof entries === "string") return entries;
  if (Array.isArray(entries) && entries.length > 0) return entries[0];
  return undefined;
}

/**
 * Rolldown plugin to provide the version virtual module during dependency
 * optimization. Vite 8 optimizes deps with Rolldown (a Rollup-style plugin
 * pipeline that is separate from the main plugin set), so this is a
 * resolveId/load plugin under optimizeDeps.rolldownOptions. Any dep pulled into
 * optimization that imports the version virtual module gets a "dev" stub here;
 * the real VERSION is injected into runtime modules by the version plugin.
 */
const versionRolldownPlugin = {
  name: "@rangojs/router-version",
  resolveId(id: string): string | undefined {
    if (id === VIRTUAL_IDS.version) return "\0" + VIRTUAL_IDS.version;
    return undefined;
  },
  load(id: string): string | undefined {
    if (id === "\0" + VIRTUAL_IDS.version) {
      return getVirtualVersionContent("dev");
    }
    return undefined;
  },
};

/**
 * Shared Rolldown options for dependency optimization (Vite 8).
 * Includes the version stub plugin and the performance-tracks RSDW patch.
 */
export const sharedRolldownOptions: {
  plugins: any[];
} = {
  plugins: [versionRolldownPlugin, performanceTracksOptimizeDepsPlugin()],
};

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
export function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPathRef?: { path?: string },
): Plugin {
  // Build virtual modules map based on which entries use virtual IDs
  const virtualModules: Record<string, string> = {};

  if (entries.client === VIRTUAL_IDS.browser) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (entries.ssr === VIRTUAL_IDS.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }

  // RSC entry is resolved lazily in load() because routerPath may be
  // set after plugin creation (e.g. by the auto-discover config() hook).
  // Track all known virtual IDs for resolveId (content is separate).
  const knownIds = new Set(Object.keys(virtualModules));
  if (entries.rsc === VIRTUAL_IDS.rsc) {
    knownIds.add(VIRTUAL_IDS.rsc);
  }

  return {
    name: "@rangojs/router:virtual-entries",
    enforce: "pre",

    resolveId(id) {
      if (knownIds.has(id)) {
        return "\0" + id;
      }
      // Handle if the id already has the null prefix (RSC plugin wrapper imports)
      if (id.startsWith("\0") && knownIds.has(id.slice(1))) {
        return id;
      }
      return null;
    },

    load(id) {
      if (id.startsWith("\0virtual:rsc-router/")) {
        const virtualId = id.slice(1);
        if (virtualId in virtualModules) {
          return virtualModules[virtualId];
        }
        // Lazy RSC entry: routerPath may have been set by a config() hook
        if (virtualId === VIRTUAL_IDS.rsc && routerPathRef?.path) {
          const raw = routerPathRef.path.startsWith(".")
            ? "/" + routerPathRef.path.slice(2) // ./src/router.tsx -> /src/router.tsx
            : routerPathRef.path;
          // Normalize backslashes for Windows (path.join/slice preserve native separators)
          const absoluteRouterPath = raw.replaceAll("\\", "/");
          return getVirtualEntryRSC(absoluteRouterPath);
        }
      }
      return null;
    },
  };
}

/**
 * Rollup onwarn handler that suppresses known harmless warnings:
 * - "use client" directives: handled by the RSC plugin, not relevant to Rollup
 * - sourcemap errors: caused by "use client" directive at line 1:0 confusing sourcemap resolution
 * - sourcemap incomplete: plugins that transform without generating sourcemaps (router + RSC plugin)
 * - dynamic/static mixed imports: expected for router internals (e.g. request-context, cache-scope).
 *   Under Rolldown (Vite 8) this surfaces as the INEFFECTIVE_DYNAMIC_IMPORT code emitted directly
 *   by the bundler, rather than the vite:reporter message handled below (Rollup/Vite 7 shape).
 * - empty bundle: @vitejs/plugin-rsc scan build (step 1/5) produces an empty "index" chunk
 *   because the RSC entry is fully externalized during client-reference analysis
 */
export function onwarn(
  warning: Vite.Rollup.RollupLog,
  defaultHandler: (warning: Vite.Rollup.RollupLog) => void,
): void {
  if (
    warning.code === "MODULE_LEVEL_DIRECTIVE" ||
    warning.code === "SOURCEMAP_ERROR" ||
    warning.code === "EMPTY_BUNDLE" ||
    warning.code === "INEFFECTIVE_DYNAMIC_IMPORT"
  ) {
    return;
  }
  // @vitejs/plugin-rsc@0.5.14: rsc:virtual:vite-rsc/assets-manifest renderChunk
  // returns { code } without map, causing Rollup to warn about incorrect sourcemaps.
  // This is harmless (simple string replacement). Remove this suppression if a
  // future version of @vitejs/plugin-rsc fixes the missing sourcemap.
  if (warning.message?.includes("Sourcemap is likely to be incorrect")) {
    return;
  }
  if (
    warning.plugin === "vite:reporter" &&
    warning.message?.includes(
      "dynamic import will not move module into another chunk",
    )
  ) {
    return;
  }
  defaultHandler(warning);
}

/**
 * Manual chunks configuration for client build.
 * Splits React and router packages into separate chunks for better caching.
 */
export function getManualChunks(id: string): string | undefined {
  const normalized = Vite.normalizePath(id);

  if (
    normalized.includes("node_modules/react/") ||
    normalized.includes("node_modules/react-dom/") ||
    normalized.includes("node_modules/react-server-dom-webpack/") ||
    normalized.includes("node_modules/@vitejs/plugin-rsc/")
  ) {
    return "react";
  }
  // Use dynamic package name from package.json
  // Check both npm install path and workspace symlink resolved path.
  //
  // The workspace patterns are anchored to the package's own `src`/`dist` so
  // they match the router runtime but NOT consumer apps that merely live under a
  // `packages/rangojs-router/` ancestor (the in-repo e2e apps at
  // `packages/rangojs-router/e2e/<app>/src/...`). Without the anchor those apps'
  // own client components were force-merged into the shared "router" chunk,
  // which both misrepresented real-consumer bundles and blocked `clientChunks`
  // splitting from relocating them.
  const packageName = getPublishedPackageName();
  if (
    normalized.includes(`node_modules/${packageName}/`) ||
    /\/packages\/(rsc-router|rangojs-router)\/(src|dist)\//.test(normalized)
  ) {
    return "router";
  }
  return undefined;
}
