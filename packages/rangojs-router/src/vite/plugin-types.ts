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
 * Document script strategy. See {@link RangoBaseOptions.headScripts}.
 */
export type HeadScriptsOption = "preinit" | "preload";

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
   * How the document ships its JavaScript.
   *
   * - `"preinit"` (**default**): client-reference chunks render as EXECUTING
   *   `<script type="module" async>` tags hoisted into `<head>` (upgrading
   *   plugin-rsc's modulepreload hints in place), and the browser entry ships
   *   as Fizz `bootstrapModules` — a head `modulepreload fetchpriority=low`
   *   hint plus the executing end-of-shell `id="_R_"` module script. Chunk
   *   execution overlaps body streaming instead of waiting for the hydration
   *   import walk; under PPR everything lands in the stored shell prelude.
   * - `"preload"`: the previous behavior — `<link rel="modulepreload">` hints
   *   only, entry as an inline `import()` script at end of shell. Chunks
   *   fetch+compile early but execute only when hydration imports them.
   *
   * Build-only for the chunk half: plugin-rsc resolves no JS deps per client
   * reference in dev, so dev documents carry no head chunk scripts in either
   * mode (the bootstrap conversion does apply in dev). Trades and upstream
   * limits are documented in src/ssr/preinit-client-references.ts.
   *
   * Wired in the generated virtual SSR entry
   * (`src/ssr/preinit-client-references.ts` has the mechanism); apps with a
   * custom SSR entry choose per-handler via `SSRDependencies.headScripts` and
   * `installClientReferencePreinit`.
   *
   * @default "preinit"
   */
  headScripts?: HeadScriptsOption;

  /**
   * React Fizz `progressiveChunkSize`, forwarded to the document renders the
   * generated SSR entry performs: renderToReadableStream (live SSR) and
   * prerender (PPR shell capture); resume() inherits the capture value from
   * the stored postponed state.
   *
   * Controls COMPLETED-boundary outlining. Once the shell exceeds this budget
   * (React's default is 12800 bytes — any real document), Fizz moves every
   * completed Suspense boundary over ~500 bytes out of its document position
   * to an end-of-stream `<div hidden>` + `$RC()` script reveal. Raise it (e.g.
   * `Number.MAX_SAFE_INTEGER`) to keep completed content inline: in-place for
   * non-executing HTML consumers, no reveal step. Boundaries with suspensey
   * content (hoisted stylesheets) still outline — their reveal must wait for
   * the CSS. Trade-off: inline content delays later shell bytes behind it,
   * which is why React outlines by default.
   *
   * When UNSET, document renders whose matched chain has a
   * `loader(Def, { ssr: false })` entry auto-raise to MAX_SAFE_INTEGER — the
   * loader was awaited before first flush precisely so its content ships
   * in-place, and outlining the boundary it feeds would defeat that. Setting
   * an explicit value disables the auto-raise. The auto-raise is live-SSR
   * only; captured shells use the explicit value or React's default.
   *
   * Apps with a custom SSR entry set this per-handler via
   * `SSRDependencies.progressiveChunkSize`.
   */
  progressiveChunkSize?: number;

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

  /**
   * What to do when a `Prerender` route's or `Static` handler's render throws at
   * build time. Otherwise the route error boundary catches it and the rendered
   * error page is baked as the artifact, then served as an HTTP 200 — a silent,
   * user-visible breakage (issue #587). Independent of this setting, a render may
   * `throw new Skip()` (from `@rangojs/router`) to skip a single URL/handler.
   *
   * - `"fail"` (**default**): fail the build, naming the URL/handler and the
   *   original render error.
   * - `"warn"`: log a warning and skip baking the artifact — it is never served as a
   *   baked 200 error page. `"warn"` is a build-unblock, NOT a runtime contract for
   *   the skipped entry: the route falls through to normal resolution, which may
   *   render live (its handler is still bundled — e.g. when nothing else baked) or
   *   404 (once prerender handler eviction has run for other baked entries), so the
   *   outcome depends on the rest of the build, and a skipped `Static()` handler's
   *   evicted code can surface as an error. For DEFINED runtime behavior use
   *   `Passthrough()` (a live fallback) or `throw new Skip()` (an intentional skip);
   *   otherwise prefer the default `"fail"`.
   *
   * @default "fail"
   */
  prerender?: {
    onError?: "fail" | "warn";
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
   * Path to a host-router entry (a module that calls `createHostRouter()` and
   * exports the instance) to serve instead of a single `createRouter()` app.
   * Root-relative (e.g. `"./src/worker.rsc.tsx"`).
   *
   * Set this when the app is a multi-app host router: auto-discovery otherwise
   * finds the sub-apps' multiple `createRouter()` files and cannot pick an entry.
   * When omitted, rango auto-detects a single `createHostRouter()` file if the
   * app has several `createRouter()` files. The host module must export the
   * `HostRouter` instance (default export or a named `hostRouter`/`router`
   * export), not a Cloudflare-style `{ fetch }` object.
   */
  hostRouter?: string;

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
  /** Node runtime for the function. @default "nodejs24.x" */
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
   * Path to a host-router entry (a module that calls `createHostRouter()` and
   * exports the instance) to serve instead of a single `createRouter()` app.
   * Root-relative (e.g. `"./src/worker.rsc.tsx"`).
   *
   * Set this when the app is a multi-app host router: auto-discovery otherwise
   * finds the sub-apps' multiple `createRouter()` files and cannot pick an entry.
   * When omitted, rango auto-detects a single `createHostRouter()` file if the
   * app has several `createRouter()` files. The host module must export the
   * `HostRouter` instance (default export or a named `hostRouter`/`router`
   * export), not a Cloudflare-style `{ fetch }` object. The Vercel function then
   * runs `hostRouter.match()` for every request (single-function deploy).
   */
  hostRouter?: string;

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
