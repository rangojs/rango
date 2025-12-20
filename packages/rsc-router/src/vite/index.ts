import type { Plugin, PluginOption } from "vite";
import { exposeActionId } from "./expose-action-id.ts";

// Re-export plugin
export { exposeActionId } from "./expose-action-id.ts";

/**
 * RSC plugin entry points configuration
 */
export interface RscEntries {
  /**
   * Path to the browser/client entry file
   * @example "./src/entry.browser.tsx"
   */
  client: string;

  /**
   * Path to the SSR entry file
   * @example "./src/entry.ssr.tsx"
   */
  ssr: string;

  /**
   * Path to the RSC entry file
   * @example "./src/entry.rsc.tsx"
   */
  rsc: string;
}

/**
 * Options for @vitejs/plugin-rsc integration
 */
export interface RscPluginOptions {
  /**
   * Entry points for client, ssr, and rsc environments
   */
  entries: RscEntries;
}

export interface RscRouterOptions {
  /**
   * Expose $$id property on server action functions.
   * Required for action-based revalidation to work.
   * @default true
   */
  exposeActionId?: boolean;

  /**
   * RSC plugin configuration. When provided, rsc-router will automatically
   * include @vitejs/plugin-rsc with these options.
   *
   * If @vitejs/plugin-rsc is already in your config, a warning will be shown
   * and the duplicate will be skipped.
   *
   * @example
   * ```ts
   * rscRouter({
   *   rsc: {
   *     entries: {
   *       client: "./src/entry.browser.tsx",
   *       ssr: "./src/entry.ssr.tsx",
   *       rsc: "./src/entry.rsc.tsx",
   *     },
   *   },
   * })
   * ```
   */
  rsc?: RscPluginOptions;
}

/**
 * Vite plugin for rsc-router.
 *
 * Includes all necessary transforms for the router to function correctly
 * with React Server Components.
 *
 * @example
 * ```ts
 * // With automatic RSC plugin inclusion
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
 * // Or with manual RSC plugin (for advanced configuration)
 * export default defineConfig({
 *   plugins: [
 *     react(),
 *     rsc({ entries: {...} }),
 *     rscRouter(), // Will detect rsc() and skip duplicate
 *   ],
 * });
 * ```
 */
export async function rscRouter(
  options: RscRouterOptions = {}
): Promise<PluginOption[]> {
  const { exposeActionId: enableExposeActionId = true, rsc: rscOptions } =
    options;

  const plugins: PluginOption[] = [];

  // Add RSC plugin if configured
  if (rscOptions) {
    // Dynamically import @vitejs/plugin-rsc
    const { default: rsc } = await import("@vitejs/plugin-rsc");

    // Create wrapper plugin that checks for duplicates and adds RSC plugins
    let hasWarnedDuplicate = false;

    plugins.push({
      name: "rsc-router:rsc-integration",
      enforce: "pre",
      configResolved(config) {
        // Check if there's another RSC plugin (not from our integration)
        const otherRscPlugins = config.plugins.filter(
          (p) =>
            p.name.startsWith("rsc:") &&
            !p.name.startsWith("rsc-router:")
        );

        // Count how many RSC base plugins there are (rsc:minimal is the main one)
        const rscMinimalCount = config.plugins.filter(
          (p) => p.name === "rsc:minimal"
        ).length;

        if (rscMinimalCount > 1 && !hasWarnedDuplicate) {
          hasWarnedDuplicate = true;
          console.warn(
            "[rsc-router] Duplicate @vitejs/plugin-rsc detected. " +
              "Remove rsc() from your config since rsc-router includes it when the rsc option is provided."
          );
        }
      },
    });

    // Add the actual RSC plugin
    plugins.push(rsc(rscOptions));
  }

  if (enableExposeActionId) {
    plugins.push(exposeActionId());
  }

  return plugins;
}
