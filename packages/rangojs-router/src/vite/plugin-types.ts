// -- Build-time environment types -------------------------------------------

/**
 * Context passed to a buildEnv factory function.
 * Provides Vite config details for conditional env setup.
 */
export interface BuildEnvFactoryContext {
  /** Vite project root directory. */
  root: string;
  /** Vite mode (e.g. "development", "production"). */
  mode: string;
  /** Vite command ("serve" for dev, "build" for production). */
  command: "serve" | "build";
  /** Router deployment preset. */
  preset: "node" | "cloudflare";
}

/**
 * Factory function that creates build-time environment bindings.
 * Called once at plugin startup. Return `dispose` to clean up resources.
 */
export type BuildEnvFactory = (
  ctx: BuildEnvFactoryContext,
) => Promise<BuildEnvResult> | BuildEnvResult;

/**
 * Result of resolving build-time environment bindings.
 */
export interface BuildEnvResult {
  /** Environment bindings available to Prerender/Static handlers via ctx.env. */
  env: Record<string, unknown>;
  /** Called after build completes to clean up resources (e.g., miniflare). */
  dispose?: () => Promise<void> | void;
}

/**
 * Build-time environment configuration for Prerender and Static handlers.
 *
 * - `false` (default): no build-time env, `ctx.env` throws.
 * - `"auto"`: calls `wrangler.getPlatformProxy()` (cloudflare preset only).
 * - Object: used directly as `ctx.env` during build.
 * - Factory: called once at startup, must return `{ env, dispose? }`.
 */
export type BuildEnvOption =
  | false
  | "auto"
  | Record<string, unknown>
  | BuildEnvFactory;

// -- Plugin options ---------------------------------------------------------

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
   * Environment bindings available to Prerender and Static handlers at build
   * time via `ctx.env`. Applies to both production build and dev on-demand
   * prerender (`/__rsc_prerender`).
   *
   * This is the build-time env supplied by the Vite plugin, not the live
   * request env. It is shared across all prerender invocations for the build.
   *
   * @default false
   */
  buildEnv?: BuildEnvOption;
}

/**
 * Options for Node.js deployment (default)
 */
export interface RangoNodeOptions extends RangoBaseOptions {
  /**
   * Deployment preset. Defaults to 'node' when not specified.
   */
  preset?: "node";
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
