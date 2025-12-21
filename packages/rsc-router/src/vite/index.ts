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
 * Base options shared across all presets
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
 * Options for Node.js deployment (default preset)
 */
export interface RscRouterNodeOptions extends RscRouterBaseOptions {
  /**
   * Deployment preset. Defaults to 'node'.
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
   * Automatically configures RSC plugin with cloudflare-specific options.
   * Uses convention-based entry at ./src/router.tsx.
   */
  preset: "cloudflare";
}

/**
 * Union type for all rscRouter options
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
 * Create a virtual modules plugin for default entry files.
 * File existence checks are deferred to configResolved hook when config.root is available.
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc: string },
  routerEntry: string
): Plugin {
  // Virtual modules are populated in configResolved when we have the correct root
  let virtualModules: Record<string, string> = {};

  return {
    name: "rsc-router:virtual-entries",
    enforce: "pre",

    configResolved(config) {
      const root = config.root;

      // Track which entries need virtual modules
      const useVirtual = {
        client: !fileExists(root, entries.client),
        ssr: !fileExists(root, entries.ssr),
        rsc: !fileExists(root, entries.rsc),
      };

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
    },

    resolveId(id) {
      if (id in virtualModules) {
        return "\0" + id;
      }
      return null;
    },

    load(id) {
      if (id.startsWith("\0virtual:rsc-router/")) {
        const virtualId = id.slice(1);
        return virtualModules[virtualId];
      }
      return null;
    },
  };
}

/**
 * Plugin to ensure resolvedUrls is available during cloudflare plugin startup.
 * Required for RSC plugin to have the origin during transform in cloudflare dev mode.
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
 * Type guard for cloudflare options
 */
function isCloudflarePreset(
  options: RscRouterOptions
): options is RscRouterCloudflareOptions {
  return options.preset === "cloudflare";
}

/**
 * Vite plugin for rsc-router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example Node.js deployment (default)
 * ```ts
 * export default defineConfig({
 *   plugins: [react(), rscRouter({ entry: './src/router.tsx' })],
 * });
 * ```
 *
 * @example Cloudflare Workers deployment
 * ```ts
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rscRouter({ preset: 'cloudflare' }),
 *     cloudflare({ ... }),
 *   ],
 * });
 * ```
 */
export async function rscRouter(
  options: RscRouterOptions
): Promise<PluginOption[]> {
  const plugins: PluginOption[] = [];
  const enableExposeActionId = options.exposeActionId ?? true;

  // Dynamically import @vitejs/plugin-rsc
  const { default: rsc } = await import("@vitejs/plugin-rsc");

  if (isCloudflarePreset(options)) {
    // Cloudflare preset: convention-based entries with cloudflare-specific RSC options
    plugins.push(ensureResolvedUrls());

    // Add RSC plugin with cloudflare-specific options and entries
    plugins.push(
      rsc({
        loadModuleDevProxy: true,
        serverHandler: false,
        entries: {
          rsc: "./src/worker.rsc.tsx",
          ssr: "./src/entry.ssr.tsx",
          client: "./src/entry.browser.tsx",
        },
      }) as PluginOption
    );
  } else {
    // Node preset (default): full virtual entries support
    const { entry, rsc: rscOption = true } = options;

    if (rscOption !== false) {
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

      // Add virtual entries plugin (file existence checks are deferred to configResolved)
      plugins.push(createVirtualEntriesPlugin(entryPaths, entry));

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
