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
  preset: "node" | "cloudflare" | "vercel";
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

// -- Client chunking --------------------------------------------------------

/**
 * Metadata for one client ("use client") module, passed to a {@link ClientChunks}
 * function. Mirrors the shape `@vitejs/plugin-rsc` passes to its own
 * `clientChunks` option.
 */
export interface ClientChunkMeta {
  /** Absolute module id of the "use client" file. */
  id: string;
  /** Normalized (posix) module id — convenient for path-based matching. */
  normalizedId: string;
  /**
   * The RSC/server chunk that statically imports this client reference. This is
   * the key used for the default grouping when no override is supplied: a single
   * router that statically imports every route yields ONE `serverChunk`, hence
   * one client chunk for all routes.
   */
  serverChunk: string;
}

/**
 * Controls how client ("use client") components are grouped into browser
 * chunks, i.e. per-route / per-feature code splitting of the client bundle.
 *
 * Without splitting, a single router ships ONE client chunk containing every
 * route's client components (and their CSS) — navigating to one route downloads
 * every other route's client code. (Host sub-apps loaded via a dynamic `import()`
 * are the exception: each forms its own chunk.) This option controls how that
 * monolith is split.
 *
 * Behavior branches:
 * - `true` / omitted (**default**, pre-1.0): Rango's built-in **directory
 *   strategy**. It splits app `"use client"` modules by **route id** — the segment
 *   after a route-root directory (`routes`, `app`, `pages`, `features`, `handlers`,
 *   …) — so `routes/dashboard/**` becomes `app-dashboard` at any nesting depth.
 *   Where it finds NO route structure (a flat `src/components/`, or host sub-apps
 *   already split by a dynamic `import()`), it inherits the default grouping
 *   unchanged — so the shared `src/components` chunk stays shared and host apps do
 *   not leak across each other. Shared runtime (React, the router, `node_modules`)
 *   is never split.
 * - `false`: opt out — inherit `@vitejs/plugin-rsc`'s default grouping everywhere
 *   (one chunk per router / per host sub-app).
 * - function: full override. Return a chunk group name, or `undefined` to fall
 *   back to the default grouping for that one module. Forwarded directly to
 *   `@vitejs/plugin-rsc`'s `clientChunks`.
 *
 * Every module maps to exactly one group, so there is no byte duplication: a
 * component used by two routes lives in one group and is fetched whenever it
 * renders. Put genuinely shared client components OUTSIDE route directories so
 * they land in the shared group rather than one route's chunk.
 *
 * @default true
 */
export type ClientChunks =
  | boolean
  | ((meta: ClientChunkMeta) => string | undefined);

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
   * Group client ("use client") components into browser chunks for per-route /
   * per-feature code splitting. On by default (pre-1.0); pass `false` to opt out.
   * See {@link ClientChunks}.
   *
   * @default true
   */
  clientChunks?: ClientChunks;

  /**
   * Filter which files route discovery scans, by glob. Paths are matched
   * root-relative (e.g. `src/routes/**`). `include` restricts discovery to
   * matching files; `exclude` removes matches (the defaults cover tests, dist,
   * coverage, etc.). Mirrors the CLI's `--include`/`--exclude`.
   *
   * @example
   * rango({ discovery: { include: ["src/routes/**"] } })
   */
  discovery?: {
    include?: string[];
    exclude?: string[];
  };
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
   * Environment bindings available to Prerender and Static handlers at build
   * time via `ctx.env`. Shared across all prerender invocations for the build.
   *
   * `"auto"` is Cloudflare-only (it resolves the wrangler platform proxy), so it
   * is not accepted on the Node preset — pass an object or a factory instead.
   *
   * @default false
   */
  buildEnv?: Exclude<BuildEnvOption, "auto">;
}

/**
 * Options for Cloudflare Workers deployment
 */
export interface RangoCloudflareOptions extends RangoBaseOptions {
  /**
   * Deployment preset for Cloudflare Workers.
   * When using cloudflare preset:
   * - @vitejs/plugin-rsc IS still added by rango(), but with `serverHandler: false`
   *   (the cloudflare plugin owns the RSC worker/server entry); only `client` and
   *   `ssr` virtual entries are configured, no rsc entry
   * - Your worker entry (e.g., worker.rsc.tsx) imports the router directly
   * - Browser and SSR use virtual entries
   * - Build-time manifest generation is auto-detected from the resolved RSC environment config
   */
  preset: "cloudflare";

  /**
   * Environment bindings available to Prerender and Static handlers at build
   * time via `ctx.env`. Shared across all prerender invocations for the build.
   *
   * `"auto"` resolves the Cloudflare platform proxy via wrangler
   * `getPlatformProxy()`.
   *
   * @default false
   */
  buildEnv?: BuildEnvOption;
}

/**
 * Per-function knobs for the Vercel deployment, written into the generated
 * `.vc-config.json` (and `config.json` for `functionName`).
 */
export interface VercelPresetOptions {
  /** Node runtime for the function. @default "nodejs22.x" */
  runtime?: string;
  /** Max execution time in seconds. @default 30 */
  maxDuration?: number;
  /** Function memory in MB (platform default when omitted). */
  memory?: number;
  /** Regions to pin the function to (platform default when omitted). */
  regions?: string[];
  /**
   * Function name — the `<name>.func` directory and the `config.json` route
   * destination. @default "index"
   */
  functionName?: string;
}

/**
 * Options for Vercel Functions deployment.
 *
 * Builds like the node preset (Vercel runs Node Functions, not Workers): rango
 * owns the RSC entry, `process.env.NODE_ENV` is folded for the build, and after
 * the build a `.vercel/output` directory (Build Output API v3) is assembled from
 * `dist/` — a single streaming Node Function plus the static client assets. The
 * app must install `@vercel/functions` (used by `VercelCacheStore` and the
 * generated function launcher).
 */
export interface RangoVercelOptions extends RangoBaseOptions {
  /**
   * Deployment preset for Vercel Functions.
   */
  preset: "vercel";

  /**
   * Environment bindings available to Prerender and Static handlers at build
   * time via `ctx.env`. `"auto"` is Cloudflare-only; pass an object or a factory.
   *
   * @default false
   */
  buildEnv?: Exclude<BuildEnvOption, "auto">;

  /**
   * Vercel function configuration written into the Build Output.
   */
  vercel?: VercelPresetOptions;
}

/**
 * Options for rango() Vite plugin
 */
export type RangoOptions =
  | RangoNodeOptions
  | RangoCloudflareOptions
  | RangoVercelOptions;
