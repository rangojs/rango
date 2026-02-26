import type { Plugin } from "vite";
import * as Vite from "vite";
import { getPublishedPackageName } from "./package-resolution.js";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  VIRTUAL_IDS,
} from "../plugins/virtual-entries.js";

/**
 * esbuild plugin to provide rsc-router:version virtual module during optimization.
 * This is needed because esbuild runs during Vite's dependency optimization phase,
 * before Vite's plugin system can handle virtual modules.
 */
const versionEsbuildPlugin = {
  name: "@rangojs/router-version",
  setup(build: any): void {
    build.onResolve({ filter: /^rsc-router:version$/ }, (args: any) => ({
      path: args.path,
      namespace: "@rangojs/router-virtual",
    }));
    build.onLoad(
      { filter: /.*/, namespace: "@rangojs/router-virtual" },
      () => ({
        contents: `export const VERSION = "dev";`,
        loader: "js",
      }),
    );
  },
};

/**
 * Shared esbuild options for dependency optimization.
 * Includes the version stub plugin for all environments.
 */
export const sharedEsbuildOptions: {
  plugins: (typeof versionEsbuildPlugin)[];
} = {
  plugins: [versionEsbuildPlugin],
};

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
export function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPath?: string,
): Plugin {
  // Build virtual modules map based on which entries use virtual IDs
  const virtualModules: Record<string, string> = {};

  if (entries.client === VIRTUAL_IDS.browser) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (entries.ssr === VIRTUAL_IDS.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }
  if (entries.rsc === VIRTUAL_IDS.rsc && routerPath) {
    // Convert relative path to absolute for virtual module imports
    const absoluteRouterPath = routerPath.startsWith(".")
      ? "/" + routerPath.slice(2) // ./src/router.tsx -> /src/router.tsx
      : routerPath;
    virtualModules[VIRTUAL_IDS.rsc] = getVirtualEntryRSC(absoluteRouterPath);
  }

  return {
    name: "@rangojs/router:virtual-entries",
    enforce: "pre",

    resolveId(id) {
      if (id in virtualModules) {
        return "\0" + id;
      }
      // Handle if the id already has the null prefix (RSC plugin wrapper imports)
      if (id.startsWith("\0") && id.slice(1) in virtualModules) {
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
 * - dynamic/static mixed imports: expected for router internals (e.g. request-context, cache-scope)
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
    warning.code === "EMPTY_BUNDLE"
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
  // Check both npm install path and workspace symlink resolved path
  const packageName = getPublishedPackageName();
  if (
    normalized.includes(`node_modules/${packageName}/`) ||
    normalized.includes("packages/rsc-router/") ||
    normalized.includes("packages/rangojs-router/")
  ) {
    return "router";
  }
  return undefined;
}
