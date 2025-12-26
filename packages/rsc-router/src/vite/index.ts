import type { Plugin, PluginOption } from "vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exposeActionId } from "./expose-action-id.ts";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  getVirtualEntryRSC,
  VIRTUAL_IDS,
} from "./virtual-entries.ts";

// Re-export plugin
export { exposeActionId } from "./expose-action-id.ts";

/**
 * Default entry file paths (relative to project root)
 */
const DEFAULT_ENTRY_PATHS = {
  client: "./src/entry.browser.tsx",
  ssr: "./src/entry.ssr.tsx",
  rsc: "./src/entry.rsc.tsx",
} as const;

/**
 * RSC plugin entry points configuration
 */
export interface RscEntries {
  /**
   * Path to the browser/client entry file.
   * If the file doesn't exist, a default virtual entry is used.
   * @default "./src/entry.browser.tsx"
   */
  client?: string;

  /**
   * Path to the SSR entry file.
   * If the file doesn't exist, a default virtual entry is used.
   * @default "./src/entry.ssr.tsx"
   */
  ssr?: string;

  /**
   * Path to the RSC entry file.
   * If the file doesn't exist, a default virtual entry is used.
   * The default expects a router export from "./src/router.tsx".
   * @default "./src/entry.rsc.tsx"
   */
  rsc?: string;
}

/**
 * Options for @vitejs/plugin-rsc integration
 */
export interface RscPluginOptions {
  /**
   * Entry points for client, ssr, and rsc environments.
   * All entries have sensible defaults and can be omitted.
   * If entry files don't exist, virtual defaults are provided.
   */
  entries?: RscEntries;
}

/**
 * Base options shared by all presets
 */
interface RscRouterBaseOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;
}

/**
 * Options for Node.js deployment (default)
 */
export interface RscRouterNodeOptions extends RscRouterBaseOptions {
  /**
   * Deployment preset. Defaults to 'node' when not specified.
   */
  preset?: "node";

  /**
   * Path to the router entry file that exports your route configuration.
   * This file must export a `router` object.
   *
   * @example
   * ```ts
   * rscRouter({ entry: './src/router.tsx' })
   * ```
   */
  entry: string;

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
export interface RscRouterCloudflareOptions extends RscRouterBaseOptions {
  /**
   * Deployment preset for Cloudflare Workers.
   * When using cloudflare preset:
   * - @vitejs/plugin-rsc is NOT added (cloudflare plugin adds it)
   * - Router is expected at ./src/router.tsx (or specify with `entry`)
   * - Worker entry is expected at ./src/worker.rsc.tsx
   * - Browser and SSR use virtual entries by default
   */
  preset: "cloudflare";

  /**
   * Path to the router entry file.
   * @default "./src/router.tsx"
   */
  entry?: string;
}

/**
 * Options for rscRouter plugin
 */
export type RscRouterOptions = RscRouterNodeOptions | RscRouterCloudflareOptions;

/**
 * Check if a file exists relative to the project root
 */
function fileExists(root: string, relativePath: string): boolean {
  const absolutePath = resolve(root, relativePath);
  return existsSync(absolutePath);
}

/**
 * Plugin to alias @vitejs/plugin-rsc internal imports to rsc-router re-exports.
 * This allows consumers to use rsc-router without installing @vitejs/plugin-rsc directly.
 */
function aliasPluginRscInternals(): Plugin {
  return {
    name: "rsc-router:alias-plugin-rsc",
    enforce: "pre",
    config() {
      return {
        resolve: {
          alias: {
            "@vitejs/plugin-rsc/utils/rpc": "rsc-router/internal/deps/utils-rpc",
          },
        },
      };
    },
  };
}

/**
 * Plugin to ensure resolved URLs are available for cloudflare dev server.
 * The cloudflare plugin needs server.resolvedUrls to be set.
 */
function ensureResolvedUrls(): Plugin {
  return {
    name: "rsc-router:ensure-resolved-urls",
    enforce: "pre",
    configureServer(server) {
      const port = server.config.server.port ?? 5173;
      const host = server.config.server.host || "localhost";
      const https = server.config.server.https;
      const protocol = https ? "https" : "http";
      const hostStr = typeof host === "string" ? host : "localhost";

      if (!server.resolvedUrls) {
        (server as unknown as { resolvedUrls: object }).resolvedUrls = {
          local: [`${protocol}://${hostStr}:${port}/`],
          network: [],
        };
      }
    },
  };
}

/**
 * Create a virtual modules plugin for default entry files
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc?: string },
  initialRoot: string,
  routerEntry: string,
  options?: { forCloudflare?: boolean }
): Plugin {
  const forCloudflare = options?.forCloudflare ?? false;

  // These will be computed in configResolved when we have the final root (cloudflare only)
  let virtualModules: Record<string, string> = {};
  let initialized = false;

  function initializeVirtualModules(root: string) {
    if (initialized && !forCloudflare) return;
    initialized = true;

    // Track which entries need virtual modules
    const useVirtual = {
      client: !fileExists(root, entries.client),
      ssr: !fileExists(root, entries.ssr),
      rsc: entries.rsc ? !fileExists(root, entries.rsc) : false,
    };

    virtualModules = {};

    if (useVirtual.client) {
      virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
    }
    if (useVirtual.ssr) {
      virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
    }
    if (useVirtual.rsc) {
      // Convert relative path to absolute for virtual module imports
      const absoluteRouterPath = routerEntry.startsWith(".")
        ? "/" + routerEntry.slice(2) // ./src/router.tsx -> /src/router.tsx
        : routerEntry;
      virtualModules[VIRTUAL_IDS.rsc] = getVirtualEntryRSC(absoluteRouterPath);
    }
  }

  // Initialize with initial root (may be updated in configResolved for cloudflare)
  initializeVirtualModules(initialRoot);

  return {
    name: "rsc-router:virtual-entries",
    enforce: "pre",

    configResolved: forCloudflare
      ? (config) => {
          // Re-initialize with the resolved root for cloudflare
          initialized = false;
          initializeVirtualModules(config.root);
        }
      : undefined,

    resolveId(id) {
      if (id in virtualModules) {
        return "\0" + id;
      }
      // For cloudflare: handle if the id already has the null prefix
      if (forCloudflare && id.startsWith("\0") && id.slice(1) in virtualModules) {
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
 * Vite plugin for rsc-router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rscRouter({ entry: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rscRouter({ preset: 'cloudflare' }),
 *     cloudflare({ viteEnvironment: { name: 'rsc' } }),
 *   ],
 * });
 * ```
 */
export async function rscRouter(
  options: RscRouterOptions
): Promise<PluginOption[]> {
  const preset = options.preset ?? "node";
  const enableExposeActionId = options.exposeActionId ?? true;

  const plugins: PluginOption[] = [];

  // Add alias for @vitejs/plugin-rsc internals so consumers don't need to install it directly
  plugins.push(aliasPluginRscInternals());

  if (preset === "cloudflare") {
    // Cloudflare preset: configure entries for cloudflare worker setup
    const routerEntry = options.entry ?? "./src/router.tsx";

    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    let projectRoot = process.cwd();
    // Only client and ssr entries - rsc entry is handled by cloudflare plugin
    let finalEntries: { client: string; ssr: string } = {
      client: VIRTUAL_IDS.browser,
      ssr: VIRTUAL_IDS.ssr,
    };

    // Ensure resolved URLs are available for cloudflare dev server
    plugins.push(ensureResolvedUrls());

    plugins.push({
      name: "rsc-router:cloudflare-integration",
      enforce: "pre",
      config(config) {
        projectRoot = config.root || process.cwd();
        // Use real files if they exist, otherwise virtual
        finalEntries = {
          client: fileExists(projectRoot, DEFAULT_ENTRY_PATHS.client)
            ? DEFAULT_ENTRY_PATHS.client
            : VIRTUAL_IDS.browser,
          ssr: fileExists(projectRoot, DEFAULT_ENTRY_PATHS.ssr)
            ? DEFAULT_ENTRY_PATHS.ssr
            : VIRTUAL_IDS.ssr,
        };

        // Configure environments for cloudflare deployment
        return {
          environments: {
            rsc: {
              build: {
                rollupOptions: {
                  // Ensure `default` export only in cloudflare entry output
                  preserveEntrySignatures: "exports-only",
                },
              },
            },
            ssr: {
              // Build SSR inside RSC directory so wrangler can deploy self-contained dist/rsc
              build: {
                outDir: "./dist/rsc/ssr",
              },
              resolve: {
                noExternal: true,
              },
            },
          },
        };
      },
    });

    plugins.push(
      createVirtualEntriesPlugin(
        { client: DEFAULT_ENTRY_PATHS.client, ssr: DEFAULT_ENTRY_PATHS.ssr },
        projectRoot,
        routerEntry,
        { forCloudflare: true }
      )
    );

    // Add RSC plugin with cloudflare-specific options
    plugins.push(
      rsc({
        get entries() {
          return finalEntries;
        },
        serverHandler: false,
        loadModuleDevProxy: true,
      }) as PluginOption
    );
  } else {
    // Node preset: full RSC plugin integration
    const nodeOptions = options as RscRouterNodeOptions;
    const entry = nodeOptions.entry;
    const rscOption = nodeOptions.rsc ?? true;

    // Add RSC plugin by default (can be disabled with rsc: false)
    if (rscOption !== false) {
      // Dynamically import @vitejs/plugin-rsc
      const { default: rsc } = await import("@vitejs/plugin-rsc");

      // Resolve entry paths
      const userEntries =
        typeof rscOption === "boolean" ? {} : rscOption.entries || {};
      const entryPaths = {
        client: userEntries.client ?? DEFAULT_ENTRY_PATHS.client,
        ssr: userEntries.ssr ?? DEFAULT_ENTRY_PATHS.ssr,
        rsc: userEntries.rsc ?? DEFAULT_ENTRY_PATHS.rsc,
      };

      // Use process.cwd() as initial root - will be updated in config hook
      let projectRoot = process.cwd();

      // Create wrapper plugin that checks for duplicates and sets up virtual entries
      let hasWarnedDuplicate = false;

      // Determine initial entries (will be finalized in config hook)
      let finalEntries = { ...entryPaths };

      plugins.push({
        name: "rsc-router:rsc-integration",
        enforce: "pre",

        config(config) {
          projectRoot = config.root || process.cwd();

          // Check which entry files exist and use virtual modules for missing ones
          finalEntries = {
            client: fileExists(projectRoot, entryPaths.client)
              ? entryPaths.client
              : VIRTUAL_IDS.browser,
            ssr: fileExists(projectRoot, entryPaths.ssr)
              ? entryPaths.ssr
              : VIRTUAL_IDS.ssr,
            rsc: fileExists(projectRoot, entryPaths.rsc)
              ? entryPaths.rsc
              : VIRTUAL_IDS.rsc,
          };
        },

        configResolved(config) {
          // Count how many RSC base plugins there are (rsc:minimal is the main one)
          const rscMinimalCount = config.plugins.filter(
            (p) => p.name === "rsc:minimal"
          ).length;

          if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
            hasWarnedDuplicate = true;
            console.warn(
              "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
                "Remove rsc() from your config or use rscRouter({ rsc: false }) for manual configuration."
            );
          }
        },
      });

      // Add virtual entries plugin
      plugins.push(createVirtualEntriesPlugin(entryPaths, projectRoot, entry));

      // Add the RSC plugin directly with a getter for entries
      // This ensures the plugin is in the array before configResolved runs
      // Cast to PluginOption to handle type differences between bundled vite types
      plugins.push(
        rsc({
          get entries() {
            return finalEntries;
          },
        }) as PluginOption
      );
    }
  }

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  return plugins;
}

