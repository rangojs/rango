/**
 * Base options shared by all presets
 */
interface RangoBaseOptions {
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
