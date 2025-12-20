import type { Plugin, PluginOption } from "vite";
import { exposeActionId } from "./expose-action-id.ts";

// Re-export plugin
export { exposeActionId } from "./expose-action-id.ts";

/**
 * Default entry points for RSC environments
 */
const DEFAULT_ENTRIES = {
  client: "./src/entry.browser.tsx",
  ssr: "./src/entry.ssr.tsx",
  rsc: "./src/entry.rsc.tsx",
} as const;

/**
 * RSC plugin entry points configuration
 */
export interface RscEntries {
  /**
   * Path to the browser/client entry file
   * @default "./src/entry.browser.tsx"
   */
  client?: string;

  /**
   * Path to the SSR entry file
   * @default "./src/entry.ssr.tsx"
   */
  ssr?: string;

  /**
   * Path to the RSC entry file
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
   * with sensible entry point defaults.
   *
   * - Omit or pass `true`/`{}` to use default entry points (recommended)
   * - Pass `{ entries: {...} }` to customize entry points
   * - Pass `false` to disable (if you want to configure @vitejs/plugin-rsc manually)
   *
   * @default true
   *
   * @example
   * ```ts
   * // Disable auto-inclusion (for manual RSC plugin configuration)
   * rscRouter({ rsc: false })
   *
   * // Customize entries
   * rscRouter({
   *   rsc: {
   *     entries: {
   *       client: "./src/custom-entry.browser.tsx",
   *     },
   *   },
   * })
   * ```
   */
  rsc?: boolean | RscPluginOptions;
}

/**
 * Vite plugin for rsc-router.
 *
 * Includes @vitejs/plugin-rsc and all necessary transforms for the router
 * to function correctly with React Server Components.
 *
 * @example
 * ```ts
 * // Minimal setup - uses default entry points
 * export default defineConfig({
 *   plugins: [react(), rscRouter()],
 * });
 *
 * // With custom entries
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rscRouter({
 *       rsc: {
 *         entries: {
 *           client: "./src/entry.browser.tsx",
 *           ssr: "./src/entry.ssr.tsx",
 *           rsc: "./src/entry.rsc.tsx",
 *         },
 *       },
 *     }),
 *   ],
 * });
 *
 * // With manual RSC plugin (for advanced configuration)
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rsc({ entries: {...} }),
 *     rscRouter({ rsc: false }),
 *   ],
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

    // Resolve entries with defaults
    const userEntries =
      typeof rscOption === "boolean" ? {} : rscOption.entries || {};
    const resolvedEntries = {
      client: userEntries.client ?? DEFAULT_ENTRIES.client,
      ssr: userEntries.ssr ?? DEFAULT_ENTRIES.ssr,
      rsc: userEntries.rsc ?? DEFAULT_ENTRIES.rsc,
    };

    // Create wrapper plugin that checks for duplicates
    let hasWarnedDuplicate = false;

    plugins.push({
      name: "rsc-router:rsc-integration",
      enforce: "pre",
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

    // Add the actual RSC plugin with resolved entries
    plugins.push(rsc({ entries: resolvedEntries }));
  }

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  return plugins;
}
