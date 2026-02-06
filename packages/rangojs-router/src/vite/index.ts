import type { Plugin, PluginOption } from "vite";
import * as Vite from "vite";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { exposeActionId } from "./expose-action-id.ts";
import { exposeLoaderId } from "./expose-loader-id.ts";
import { exposeHandleId } from "./expose-handle-id.ts";
import { exposeLocationStateId } from "./expose-location-state-id.ts";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  getVirtualVersionContent,
  VIRTUAL_IDS,
} from "./virtual-entries.ts";
import {
  getExcludeDeps,
  getPackageAliases,
  getPublishedPackageName,
  isWorkspaceDevelopment,
} from "./package-resolution.ts";

// Re-export plugins
export { exposeActionId } from "./expose-action-id.ts";
export { exposeLoaderId } from "./expose-loader-id.ts";
export { exposeHandleId } from "./expose-handle-id.ts";
export { exposeLocationStateId } from "./expose-location-state-id.ts";

// Virtual module type declarations in ./version.d.ts

/**
 * esbuild plugin to provide rsc-router:version virtual module during optimization.
 * This is needed because esbuild runs during Vite's dependency optimization phase,
 * before Vite's plugin system can handle virtual modules.
 */
const versionEsbuildPlugin = {
  name: "@rangojs/router-version",
  setup(build: any) {
    build.onResolve({ filter: /^rsc-router:version$/ }, (args: any) => ({
      path: args.path,
      namespace: "@rangojs/router-virtual",
    }));
    build.onLoad({ filter: /.*/, namespace: "@rangojs/router-virtual" }, () => ({
      contents: `export const VERSION = "dev";`,
      loader: "js",
    }));
  },
};

/**
 * Shared esbuild options for dependency optimization.
 * Includes the version stub plugin for all environments.
 */
const sharedEsbuildOptions = {
  plugins: [versionEsbuildPlugin],
};

/**
 * RSC plugin entry points configuration.
 * All entries use virtual modules by default. Specify a path to use a custom entry file.
 */
export interface RscEntries {
  /**
   * Path to a custom browser/client entry file.
   * If not specified, a default virtual entry is used.
   */
  client?: string;

  /**
   * Path to a custom SSR entry file.
   * If not specified, a default virtual entry is used.
   */
  ssr?: string;

  /**
   * Path to a custom RSC entry file.
   * If not specified, a default virtual entry is used that imports the router from the `entry` option.
   */
  rsc?: string;
}

/**
 * Options for @vitejs/plugin-rsc integration
 */
export interface RscPluginOptions {
  /**
   * Entry points for client, ssr, and rsc environments.
   * All entries use virtual modules by default.
   * Specify paths only when you need custom entry files.
   */
  entries?: RscEntries;
}

/**
 * Base options shared by all presets
 */
interface RangoBaseOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;

  /**
   * Show startup banner. Set to false to disable.
   * @default true
   */
  banner?: boolean;
}

/**
 * Options for Node.js deployment (default)
 */
export interface RangoNodeOptions extends RangoBaseOptions {
  /**
   * Deployment preset. Defaults to 'node' when not specified.
   */
  preset?: "node";

  /**
   * Path to your router configuration file that exports the route tree.
   * This file must export a `router` object created with `createRouter()`.
   *
   * @example
   * ```ts
   * rango({ router: './src/router.tsx' })
   * ```
   */
  router: string;

  /**
   * RSC plugin configuration. By default, rsc-router includes @vitejs/plugin-rsc
   * with sensible defaults.
   *
   * Entry files (browser, ssr, rsc) are optional - if they don't exist,
   * virtual defaults are used.
   *
   * - Omit or pass `true`/`{}` to use defaults (recommended)
   * - Pass `{ entries: {...} }` to customize entry paths
   * - Pass `false` to disable (for manual @vitejs/plugin-rsc configuration)
   *
   * @default true
   */
  rsc?: boolean | RscPluginOptions;
}

/**
 * Options for Cloudflare Workers deployment
 */
export interface RangoCloudflareOptions extends RangoBaseOptions {
  /**
   * Deployment preset for Cloudflare Workers.
   * When using cloudflare preset:
   * - @vitejs/plugin-rsc is NOT added (cloudflare plugin adds it)
   * - Your worker entry (e.g., worker.rsc.tsx) imports the router directly
   * - Browser and SSR use virtual entries
   */
  preset: "cloudflare";
}

/**
 * Options for rango() Vite plugin
 */
export type RangoOptions = RangoNodeOptions | RangoCloudflareOptions;

/**
 * Create a virtual modules plugin for default entry files.
 * Provides virtual module content when entries use VIRTUAL_IDS (no custom entry configured).
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  routerPath?: string
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
 * Manual chunks configuration for client build.
 * Splits React and router packages into separate chunks for better caching.
 */
function getManualChunks(id: string): string | undefined {
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

/**
 * Plugin providing rsc-router:version virtual module.
 * Exports VERSION that changes when RSC modules change (dev) or at build time (production).
 *
 * The version is used for:
 * 1. Cache invalidation - CFCacheStore uses VERSION to invalidate stale cache
 * 2. Version mismatch detection - client sends version, server reloads on mismatch
 *
 * In dev mode, the version updates when:
 * - Server starts (initial version)
 * - RSC modules change via HMR (triggers version module invalidation)
 *
 * Client-only HMR changes don't update the version since they don't affect
 * server-rendered content or cached RSC payloads.
 * @internal
 */
function createVersionPlugin(): Plugin {
  // Generate version at plugin creation time (build/server start)
  const buildVersion = Date.now().toString(16);
  let currentVersion = buildVersion;
  let isDev = false;
  let server: any = null;

  return {
    name: "@rangojs/router:version",
    enforce: "pre",

    configResolved(config) {
      isDev = config.command === "serve";
    },

    configureServer(devServer) {
      server = devServer;
    },

    resolveId(id) {
      if (id === VIRTUAL_IDS.version) {
        return "\0" + id;
      }
      return null;
    },

    load(id) {
      if (id === "\0" + VIRTUAL_IDS.version) {
        return getVirtualVersionContent(currentVersion);
      }
      return null;
    },

    // Track RSC module changes and update version
    hotUpdate(ctx) {
      if (!isDev) return;

      // Check if this is an RSC environment update (not client/ssr)
      // RSC modules affect server-rendered content and cached payloads
      // In Vite 6, environment is accessed via `this.environment`
      const isRscModule = this.environment?.name === "rsc";

      if (isRscModule && ctx.modules.length > 0) {
        // Update version when RSC modules change
        currentVersion = Date.now().toString(16);
        console.log(
          `[rsc-router] RSC module changed, version updated: ${currentVersion}`
        );

        // Invalidate the version module so it gets reloaded with new version
        if (server) {
          const rscEnv = server.environments?.rsc;
          if (rscEnv?.moduleGraph) {
            const versionMod = rscEnv.moduleGraph.getModuleById(
              "\0" + VIRTUAL_IDS.version
            );
            if (versionMod) {
              rscEnv.moduleGraph.invalidateModule(versionMod);
            }
          }
        }
      }
    },
  };
}

/**
 * Plugin that auto-injects VERSION into custom entry.rsc files.
 * If a custom entry.rsc file uses createRSCHandler but doesn't pass version,
 * this transform adds the import and property automatically.
 * @internal
 */
function createVersionInjectorPlugin(rscEntryPath: string): Plugin {
  let projectRoot = "";
  let resolvedEntryPath = "";

  return {
    name: "@rangojs/router:version-injector",
    enforce: "pre",

    configResolved(config) {
      projectRoot = config.root;
      resolvedEntryPath = resolve(projectRoot, rscEntryPath);
    },

    transform(code, id) {
      // Only transform the RSC entry file
      const normalizedId = Vite.normalizePath(id);
      const normalizedEntry = Vite.normalizePath(resolvedEntryPath);

      if (normalizedId !== normalizedEntry) {
        return null;
      }

      // Check if file uses createRSCHandler
      if (!code.includes("createRSCHandler")) {
        return null;
      }

      // Check if VERSION is already imported
      if (code.includes("@rangojs/router:version")) {
        return null;
      }

      // Check if version property is already being passed
      // Look for version: in the createRSCHandler call
      const handlerCallMatch = code.match(/createRSCHandler\s*\(\s*\{/);
      if (!handlerCallMatch) {
        return null;
      }

      // Add VERSION import after the last import statement
      const lastImportIndex = code.lastIndexOf("import ");
      if (lastImportIndex === -1) {
        return null;
      }

      // Find the end of the last import statement
      const afterLastImport = code.indexOf("\n", lastImportIndex);
      if (afterLastImport === -1) {
        return null;
      }

      // Find next line that's not an import continuation
      let insertIndex = afterLastImport + 1;
      while (
        insertIndex < code.length &&
        (code.slice(insertIndex).match(/^\s*(from|import)\s/) ||
          code[insertIndex] === "\n")
      ) {
        const nextNewline = code.indexOf("\n", insertIndex);
        if (nextNewline === -1) break;
        insertIndex = nextNewline + 1;
      }

      // Insert VERSION import
      const versionImport = `import { VERSION } from "@rangojs/router:version";\n`;
      let newCode = code.slice(0, insertIndex) + versionImport + code.slice(insertIndex);

      // Add version: VERSION to createRSCHandler call
      // Find createRSCHandler({ and add version: VERSION right after the opening brace
      newCode = newCode.replace(
        /createRSCHandler\s*\(\s*\{/,
        "createRSCHandler({\n  version: VERSION,"
      );

      return {
        code: newCode,
        map: null,
      };
    },
  };
}

const _require = createRequire(import.meta.url);
const _rangoVersion: string = _require("../../package.json").version;

let _bannerPrinted = false;

function printBanner(
  mode: "dev" | "build",
  preset: string,
  version: string
): void {
  if (_bannerPrinted) return;
  _bannerPrinted = true;

  // ANSI codes
  const dim = "\x1b[2m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";

  const banner = `
${dim}   ✦        ✦          ✧.           .          .${reset}
${dim}  ╱${reset}   ${bold}╔═╗${reset}${dim}             ╱                   ✦             *${reset}
${dim}      ${reset}${bold}║ ║${reset}${dim} ${reset}${bold}╔═╗${reset}${dim}                    *                ✧.   ╱${reset}
${dim}   ${reset}${bold}╔╗ ║ ║ ║ ║  ╦═╗╔═╗╔╗╔╔═╗╔═╗${reset}${dim}             ✧              ✦${reset}
${dim}   ${reset}${bold}║║ ║ ╠═╝ ║  ╠╦╝╠═╣║║║║ ╦║ ║${reset}${dim}        *           ✧${reset}
${dim}   ${reset}${bold}║╚═╝ ╔═══╝  ╩╚═╩ ╩╝╚╝╚═╝╚═╝${reset}${dim}            ✦          .      *${reset}
${dim}   ${reset}${bold}╚══╗ ║${reset}${dim}        RSC Wrangler         ✧                ✦${reset}
${dim}      ${reset}${bold}║ ║${reset}${dim}                          *            ✧.    ╱${reset}
${dim}      ${reset}${bold}╚═╝${reset}${dim}                               ✦            *${reset}

   v${version} · ${preset} · ${mode}
`;

  console.log(banner);
}

/**
 * Vite plugin for @rangojs/router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rango({ router: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rango({ preset: 'cloudflare' }),
 *     cloudflare({ viteEnvironment: { name: 'rsc' } }),
 *   ],
 * });
 * ```
 */
export async function rango(
  options: RangoOptions
): Promise<PluginOption[]> {
  const preset = options.preset ?? "node";
  const enableExposeActionId = options.exposeActionId ?? true;
  const showBanner = options.banner ?? true;

  const plugins: PluginOption[] = [];

  // Get package resolution info (workspace vs npm install)
  const rangoAliases = getPackageAliases();
  const excludeDeps = getExcludeDeps();

  // Track RSC entry path for version injection
  let rscEntryPath: string | null = null;

  if (preset === "cloudflare") {
    // Cloudflare preset: configure entries for cloudflare worker setup
    // Router is not needed here - worker.rsc.tsx imports it directly

    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    // Only client and ssr entries - rsc entry is handled by cloudflare plugin
    // Always use virtual modules for cloudflare preset
    const finalEntries: { client: string; ssr: string } = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
    };

    plugins.push({
      name: "@rangojs/router:cloudflare-integration",
      enforce: "pre",
      config() {
        // Configure environments for cloudflare deployment
        return {
          // Exclude rsc-router modules from optimization to prevent module duplication
          // This ensures the same Context instance is used by both browser entry and RSC proxy modules
          optimizeDeps: {
            exclude: excludeDeps,
            esbuildOptions: sharedEsbuildOptions,
          },
          resolve: {
            alias: rangoAliases,
          },
          environments: {
            client: {
              build: {
                rollupOptions: {
                  output: {
                    manualChunks: getManualChunks,
                  },
                },
              },
              // Pre-bundle rsc-html-stream to prevent discovery during first request
              // Exclude rsc-router modules to ensure same Context instance
              optimizeDeps: {
                include: ["rsc-html-stream/client"],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            ssr: {
              // Build SSR inside RSC directory so wrangler can deploy self-contained dist/rsc
              build: {
                outDir: "./dist/rsc/ssr",
              },
              resolve: {
                // Ensure single React instance in SSR child environment
                dedupe: ["react", "react-dom"],
              },
              // Pre-bundle SSR entry and React for proper module linking with childEnvironments
              // Exclude rsc-router modules to ensure same Context instance
              optimizeDeps: {
                entries: [finalEntries.ssr],
                include: [
                  "react",
                  "react-dom/server.edge",
                  "react/jsx-runtime",
                  "rsc-html-stream/server",
                ],
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
            rsc: {
              // RSC environment needs exclude list and esbuild options
              // Exclude rsc-router modules to prevent createContext in RSC environment
              optimizeDeps: {
                exclude: excludeDeps,
                esbuildOptions: sharedEsbuildOptions,
              },
            },
          },
        };
      },

      configResolved(config) {
        if (showBanner) {
          const mode = config.command === "serve" ? "dev" : "build";
          printBanner(mode, "cloudflare", _rangoVersion);
        }
      },
    });

    plugins.push(createVirtualEntriesPlugin(finalEntries));

    // Add RSC plugin with cloudflare-specific options
    // Note: loadModuleDevProxy should NOT be used with childEnvironments
    // since SSR runs in workerd alongside RSC
    plugins.push(
      rsc({
        get entries() {
          return finalEntries;
        },
        serverHandler: false,
      }) as PluginOption
    );
  } else {
    // Node preset: full RSC plugin integration
    const nodeOptions = options as RangoNodeOptions;
    const routerPath = nodeOptions.router;
    const rscOption = nodeOptions.rsc ?? true;

    // Add RSC plugin by default (can be disabled with rsc: false)
    if (rscOption !== false) {
      // Dynamically import @vitejs/plugin-rsc
      const { default: rsc } = await import("@vitejs/plugin-rsc");

      // Resolve entry paths: use explicit config or virtual modules
      const userEntries =
        typeof rscOption === "boolean" ? {} : rscOption.entries || {};
      const finalEntries = {
        client: userEntries.client ?? VIRTUAL_IDS.browser,
        ssr: userEntries.ssr ?? VIRTUAL_IDS.ssr,
        rsc: userEntries.rsc ?? VIRTUAL_IDS.rsc,
      };

      // Track RSC entry for version injection (only if custom entry provided)
      rscEntryPath = userEntries.rsc ?? null;

      // Create wrapper plugin that checks for duplicates
      let hasWarnedDuplicate = false;

      plugins.push({
        name: "@rangojs/router:rsc-integration",
        enforce: "pre",

        config() {
          // Configure environments for RSC
          // When using virtual entries, we need to explicitly configure optimizeDeps
          // so Vite pre-bundles React before processing the virtual modules.
          // Without this, the dep optimizer may run multiple times with different hashes,
          // causing React instance mismatches.
          const useVirtualClient = finalEntries.client === VIRTUAL_IDS.browser;
          const useVirtualSSR = finalEntries.ssr === VIRTUAL_IDS.ssr;
          const useVirtualRSC = finalEntries.rsc === VIRTUAL_IDS.rsc;

          return {
            // Exclude rsc-router modules from optimization to prevent module duplication
            // This ensures the same Context instance is used by both browser entry and RSC proxy modules
            optimizeDeps: {
              exclude: excludeDeps,
              esbuildOptions: sharedEsbuildOptions,
            },
            resolve: {
              alias: rangoAliases,
            },
            environments: {
              client: {
                build: {
                  rollupOptions: {
                    output: {
                      manualChunks: getManualChunks,
                    },
                  },
                },
                // Always exclude rsc-router modules, conditionally add virtual entry
                optimizeDeps: {
                  exclude: excludeDeps,
                  esbuildOptions: sharedEsbuildOptions,
                  ...(useVirtualClient && {
                    // Tell Vite to scan the virtual entry for dependencies
                    entries: [VIRTUAL_IDS.browser],
                  }),
                },
              },
              ...(useVirtualSSR && {
                ssr: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.ssr],
                    // Pre-bundle React for SSR to ensure single instance
                    include: ["react", "react-dom/server.edge", "react/jsx-runtime"],
                    exclude: excludeDeps,
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
              ...(useVirtualRSC && {
                rsc: {
                  optimizeDeps: {
                    entries: [VIRTUAL_IDS.rsc],
                    // Pre-bundle React for RSC to ensure single instance
                    include: ["react", "react/jsx-runtime"],
                    esbuildOptions: sharedEsbuildOptions,
                  },
                },
              }),
            },
          };
        },

        configResolved(config) {
          if (showBanner) {
            const mode = config.command === "serve" ? "dev" : "build";
            printBanner(mode, "node", _rangoVersion);
          }

          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal"
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rango({ rsc: false }) for manual configuration."
            );
          }
        },
      });

      // Add virtual entries plugin
      plugins.push(createVirtualEntriesPlugin(finalEntries, routerPath));

      // Add the RSC plugin directly
      // Cast to PluginOption to handle type differences between bundled vite types
      plugins.push(
        rsc({
          entries: finalEntries,
        }) as PluginOption
      );
    }
  }

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  // Always add exposeLoaderId for GET-based loader fetching with useFetchLoader
  plugins.push(exposeLoaderId());

  // Always add exposeHandleId for auto-generated handle IDs
  plugins.push(exposeHandleId());

  // Always add exposeLocationStateId for auto-generated location state keys
  plugins.push(exposeLocationStateId());

  // Add version virtual module plugin for cache invalidation
  plugins.push(createVersionPlugin());

  // Add version injector for custom entry.rsc files
  if (rscEntryPath) {
    plugins.push(createVersionInjectorPlugin(rscEntryPath));
  }

  // Transform CJS vendor files to ESM for browser compatibility
  // optimizeDeps.include doesn't work because the file is loaded after initial optimization
  plugins.push(createCjsToEsmPlugin());

  return plugins;
}

/**
 * Transform CJS vendor files from @vitejs/plugin-rsc to ESM for browser compatibility.
 * The react-server-dom vendor files are shipped as CJS which doesn't work in browsers.
 */
function createCjsToEsmPlugin(): Plugin {
  return {
    name: "@rangojs/router:cjs-to-esm",
    enforce: "pre",
    transform(code, id) {
      const cleanId = id.split("?")[0];

      // Transform the client.browser.js entry point to re-export from CJS
      if (
        cleanId.includes("vendor/react-server-dom/client.browser.js") ||
        cleanId.includes("vendor\\react-server-dom\\client.browser.js")
      ) {
        const isProd = process.env.NODE_ENV === "production";
        const cjsFile = isProd
          ? "./cjs/react-server-dom-webpack-client.browser.production.js"
          : "./cjs/react-server-dom-webpack-client.browser.development.js";

        return {
          code: `export * from "${cjsFile}";`,
          map: null,
        };
      }

      // Transform the actual CJS files to ESM
      if (
        (cleanId.includes("vendor/react-server-dom/cjs/") ||
          cleanId.includes("vendor\\react-server-dom\\cjs\\")) &&
        cleanId.includes("client.browser")
      ) {
        let transformed = code;

        // Extract the license comment to preserve it
        const licenseMatch = transformed.match(/^\/\*\*[\s\S]*?\*\//);
        const license = licenseMatch ? licenseMatch[0] : "";
        if (license) {
          transformed = transformed.slice(license.length);
        }

        // Remove "use strict" (both dev and prod have this)
        transformed = transformed.replace(/^\s*["']use strict["'];\s*/, "");

        // Remove the conditional IIFE wrapper (development only)
        transformed = transformed.replace(
          /^\s*["']production["']\s*!==\s*process\.env\.NODE_ENV\s*&&\s*\(function\s*\(\)\s*\{/,
          ""
        );

        // Remove the closing of the conditional IIFE at the end (development only)
        transformed = transformed.replace(/\}\)\(\);?\s*$/, "");

        // Replace require('react') and require('react-dom') with imports (development)
        transformed = transformed.replace(
          /var\s+React\s*=\s*require\s*\(\s*["']react["']\s*\)\s*,[\s\n]+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import React from "react";\nimport ReactDOM from "react-dom";\nvar '
        );

        // Replace require('react-dom') only (production - doesn't import React)
        transformed = transformed.replace(
          /var\s+ReactDOM\s*=\s*require\s*\(\s*["']react-dom["']\s*\)\s*,/g,
          'import ReactDOM from "react-dom";\nvar '
        );

        // Transform exports.xyz = function() to export function xyz()
        transformed = transformed.replace(
          /exports\.(\w+)\s*=\s*function\s*\(/g,
          "export function $1("
        );

        // Transform exports.xyz = value to export const xyz = value
        transformed = transformed.replace(
          /exports\.(\w+)\s*=/g,
          "export const $1 ="
        );

        // Reconstruct with license at the top
        transformed = license + "\n" + transformed;

        return {
          code: transformed,
          map: null,
        };
      }

      return null;
    },
  };
}

