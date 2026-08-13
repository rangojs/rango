/**
 * Discovery State
 *
 * Shared mutable state for the router discovery plugin.
 * Created once by createRouterDiscoveryPlugin() and passed
 * to all extracted helper functions.
 */

import type { ScanFilter } from "../../build/generate-route-types.js";
import type { ClientUrlProjection } from "../../client-urls/server-projection.js";

export const VIRTUAL_ROUTES_MANIFEST_ID = "virtual:rsc-router/routes-manifest";

export interface PluginOptions {
  enableBuildPrerender?: boolean;
  staticRouteTypesGeneration?: boolean;
  // Mutable ref for deferred auto-discovery (node preset).
  // The auto-discover config() hook populates this before configResolved.
  routerPathRef?: { path?: string };
  /** Build-time env option from rango() config. */
  buildEnv?: import("../plugin-types.js").BuildEnvOption;
  /** Deployment preset (needed for buildEnv "auto" resolution). */
  preset?: "node" | "cloudflare" | "vercel";
  /**
   * Route-discovery scan filter (glob include/exclude) from rango() config.
   * Compiled into `DiscoveryState.scanFilter` once `projectRoot` is known.
   */
  discovery?: { include?: string[]; exclude?: string[] };
  /**
   * What to do when a Prerender/Static render throws at build time, from
   * rango({ prerender: { onError } }). "fail" (default) fails the build; "warn"
   * logs and skips baking the URL. See {@link import("../plugin-types.js").RangoOptions}.
   */
  prerenderOnError?: "fail" | "warn";
  /**
   * Shared context the built-in clientChunks strategy reads. Discovery populates
   * it (registered fallback hashes + single-router name) before the client build
   * invokes the strategy. Present only when the built-in strategy is active
   * (`clientChunks: true`/default); undefined for `false` or a custom function.
   */
  clientChunkCtx?: import("../utils/client-chunks.js").ClientChunkContext;
  /**
   * rango({ headScripts }) — threaded so the dev temp server can serve the
   * REAL virtual SSR entry (getVirtualEntrySSR) for the on-demand shell
   * capture endpoint with the app's configured head-script strategy.
   */
  headScripts?: import("../plugin-types.js").HeadScriptsOption;
  /**
   * rango({ progressiveChunkSize }) — threaded alongside headScripts so the
   * temp server's virtual SSR entry bakes the app's configured Fizz outlining
   * budget into its capture/render handlers.
   */
  progressiveChunkSize?: number;
}

export interface PrecomputedEntry {
  staticPrefix: string;
  routes: Record<string, string>;
}

export interface ChunkInfo {
  fileName: string;
  exports: Array<{ name: string; handlerId: string; passthrough: boolean }>;
}

export interface PerRouterManifestEntry {
  id: string;
  routeManifest: Record<string, string>;
  routeTrailingSlash?: Record<string, string>;
  routeSearchSchemas?: Record<string, Record<string, string>>;
  sourceFile?: string;
  factoryOnlyPrefixes?: Set<string>;
}

/**
 * One Prerender+ppr URL the build must additionally produce a PPR shell entry
 * for (issue #699 producer B). `ppr` is the route's raw path option, already
 * filtered to truthy by the collector.
 */
export interface ShellPrerenderCandidate {
  urlPath: string;
  routeName: string;
  paramHash: string;
  ppr:
    | true
    | { ttl?: number; swr?: number; tags?: string[]; captureTimeout?: number };
}

export interface ClientUrlDiscoveryState {
  clientUrlSourceByReferenceId: Map<string, string>;
  clientUrlProjectionMap: Map<string, ClientUrlProjection>;
}

export interface DiscoveryState {
  resolvedEntryPath: string | undefined;
  projectRoot: string;
  isBuildMode: boolean;
  userResolveAlias: any;
  /**
   * Data-only slice of the user's resolved config (resolve.* incl. native
   * tsconfigPaths, define, oxc) mirrored into the discovery temp server so it
   * resolves and transforms modules the same way the real environment does.
   * See `utils/forward-user-plugins.ts`.
   */
  userRunnerConfig:
    | import("../utils/forward-user-plugins.js").ForwardedRunnerConfig
    | undefined;
  /**
   * User resolution plugins (resolveId/load), stripped to their resolution
   * surface, forwarded into the discovery temp server. Lets third-party
   * resolvers such as vite-tsconfig-paths participate in discovery.
   */
  userResolvePlugins: import("vite").Plugin[];
  scanFilter: ScanFilter | undefined;
  cachedRouterFiles: string[] | undefined;
  opts: PluginOptions | undefined;

  mergedRouteManifest: Record<string, string> | null;
  perRouterManifests: PerRouterManifestEntry[];

  perRouterTrieMap: Map<string, any>;
  perRouterPrecomputedMap: Map<string, PrecomputedEntry[]>;
  perRouterManifestDataMap: Map<string, Record<string, string>>;
  clientUrlSourceByReferenceId?: Map<string, string>;
  clientUrlProjectionMap?: Map<string, ClientUrlProjection>;

  prerenderManifestEntries: Record<string, string> | null;
  staticManifestEntries: Record<string, string> | null;
  /**
   * Build-time PPR shell candidates: prerender routes that ALSO declare the
   * `ppr` path option (issue #699 producer B). Collected by
   * expandPrerenderRoutes; consumed by the post-build shell capture phase.
   */
  shellCandidates: ShellPrerenderCandidate[] | null;
  /**
   * Raw prerender payload JSON strings keyed by manifest key, retained in
   * memory so the shell capture phase can seed an in-realm prerender store
   * without re-reading staged asset files.
   */
  prerenderPayloadValues: Map<string, string> | null;
  /**
   * The buildStart temp RSC server, kept alive past discovery when shell
   * candidates exist: the shell capture phase (buildApp post) reuses its
   * realm — tries installed, registry populated — after the client build has
   * produced the asset URLs the prelude must embed. Deferred as a PAIR with
   * the buildEnv; closed by the buildApp post hook's finally (success) or
   * buildEnd (aborted build).
   */
  shellPhaseTempServer: import("vite").ViteDevServer | null;
  handlerChunkInfoMap: Map<string, ChunkInfo>;
  staticHandlerChunkInfoMap: Map<string, ChunkInfo>;
  rscEntryFileName: string | null;
  resolvedPrerenderModules: Map<string, string[]> | undefined;
  resolvedStaticModules: Map<string, string[]> | undefined;

  discoveryDone: Promise<void> | null;
  /** Monotonic Cloudflare-dev generation installed by the routes manifest. */
  devDiscoveryEpoch?: number;
  devServerOrigin: string | null;
  devServer: any;
  selfWrittenGenFiles: Map<string, { at: number; hash: string }>;
  SELF_WRITE_WINDOW_MS: number;

  /** Resolved build-time env bindings (set during buildStart/configureServer). */
  resolvedBuildEnv?: Record<string, unknown>;
  /** Cleanup function for build-time env resources (e.g., miniflare). */
  buildEnvDispose?: (() => Promise<void> | void) | null;

  /**
   * Set when the most recent HMR re-discovery threw. Cleared on the next
   * successful discovery. Surfaced via debug logs so we can detect "manifest
   * frozen at last-good after error → user fix in non-route file → no
   * rediscovery trigger" scenarios.
   */
  lastDiscoveryError?: { message: string; at: number } | null;
}

export function createDiscoveryState(
  entryPath: string | undefined,
  opts: PluginOptions | undefined,
): DiscoveryState & ClientUrlDiscoveryState {
  return {
    resolvedEntryPath: entryPath,
    projectRoot: "",
    isBuildMode: false,
    userResolveAlias: undefined,
    userRunnerConfig: undefined,
    userResolvePlugins: [],
    scanFilter: undefined,
    cachedRouterFiles: undefined,
    opts,

    mergedRouteManifest: null,
    perRouterManifests: [],

    perRouterTrieMap: new Map(),
    perRouterPrecomputedMap: new Map(),
    perRouterManifestDataMap: new Map(),
    clientUrlSourceByReferenceId: new Map(),
    clientUrlProjectionMap: new Map(),

    prerenderManifestEntries: null,
    staticManifestEntries: null,
    shellCandidates: null,
    prerenderPayloadValues: null,
    shellPhaseTempServer: null,
    handlerChunkInfoMap: new Map(),
    staticHandlerChunkInfoMap: new Map(),
    rscEntryFileName: null,
    resolvedPrerenderModules: undefined,
    resolvedStaticModules: undefined,

    discoveryDone: null,
    devDiscoveryEpoch: opts?.preset === "cloudflare" ? Date.now() : undefined,
    devServerOrigin: null,
    devServer: null,
    selfWrittenGenFiles: new Map(),
    SELF_WRITE_WINDOW_MS: 5_000,
    lastDiscoveryError: null,
  };
}
