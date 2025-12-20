import type { Plugin, PluginOption } from "vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { exposeActionId } from "./expose-action-id.ts";
import {
  VIRTUAL_ENTRY_BROWSER,
  VIRTUAL_ENTRY_SSR,
  VIRTUAL_ENTRY_RSC,
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

export interface RscRouterOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;

  /**
   * RSC plugin configuration. By default, rsc-router includes @vitejs/plugin-rsc
   * with sensible defaults.
   *
   * Entry files are optional - if they don't exist, virtual defaults are used.
   * The only required file is `./src/router.tsx` which defines your routes.
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
 * Check if a file exists relative to the project root
 */
function fileExists(root: string, relativePath: string): boolean {
  const absolutePath = resolve(root, relativePath);
  return existsSync(absolutePath);
}

/**
 * Create a virtual modules plugin for default entry files
 */
function createVirtualEntriesPlugin(
  entries: { client: string; ssr: string; rsc: string },
  root: string
): Plugin {
  // Track which entries need virtual modules
  const useVirtual = {
    client: !fileExists(root, entries.client),
    ssr: !fileExists(root, entries.ssr),
    rsc: !fileExists(root, entries.rsc),
  };

  const virtualModules: Record<string, string> = {};

  if (useVirtual.client) {
    virtualModules[VIRTUAL_IDS.browser] = VIRTUAL_ENTRY_BROWSER;
  }
  if (useVirtual.ssr) {
    virtualModules[VIRTUAL_IDS.ssr] = VIRTUAL_ENTRY_SSR;
  }
  if (useVirtual.rsc) {
    virtualModules[VIRTUAL_IDS.rsc] = VIRTUAL_ENTRY_RSC;
  }

  return {
    name: "rsc-router:virtual-entries",
    enforce: "pre",

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
 * Vite plugin for rsc-router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * Entry files are optional - if they don't exist, sensible defaults are used.
 * The only required file is `./src/router.tsx` which exports your router.
 *
 * @example
 * ```ts
 * // Minimal setup - just create src/router.tsx and you're done!
 * export default defineConfig({
 *   plugins: [react(), rscRouter()],
 * });
 * ```
 */
export async function rscRouter(
  options: RscRouterOptions = {}
): Promise<PluginOption[]> {
  const { exposeActionId: enableExposeActionId = true, rsc: rscOption = true } =
    options;

  const plugins: PluginOption[] = [];

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
    plugins.push(createVirtualEntriesPlugin(entryPaths, projectRoot));

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

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  return plugins;
}
