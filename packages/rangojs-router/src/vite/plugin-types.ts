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
   * Show startup banner. Set to false to disable.
   * @default true
   */
  banner?: boolean;

  /**
   * Generate named-routes.gen.ts by parsing url modules at startup.
   * Provides type-safe Handler<"name"> and href() without executing router code.
   * Set to `false` to disable (run `npx rango extract-names` manually instead).
   * @default true
   */
  staticRouteTypesGeneration?: boolean;

  /**
   * Glob patterns for files to include in route type scanning.
   * Only files matching at least one pattern will be scanned.
   * Patterns are relative to the project root.
   * When unset, all .ts/.tsx files are scanned.
   */
  include?: string[];

  /**
   * Glob patterns for files to exclude from route type scanning.
   * Takes precedence over `include`. Patterns are relative to the project root.
   * Defaults to common test/build directories.
   */
  exclude?: string[];
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
   * When omitted, auto-discovers the router by scanning for files containing
   * `createRouter`. If exactly one is found, it is used automatically.
   * If multiple are found, an error is thrown with the list of candidates.
   *
   * @example
   * ```ts
   * rango({ router: './src/router.tsx' })
   * // or simply:
   * rango()
   * ```
   */
  router?: string;

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
   * - Build-time manifest generation is auto-detected from the resolved RSC environment config
   */
  preset: "cloudflare";
}

/**
 * Options for rango() Vite plugin
 */
export type RangoOptions = RangoNodeOptions | RangoCloudflareOptions;
