/**
 * Discovery State
 *
 * Shared mutable state for the router discovery plugin.
 * Created once by createRouterDiscoveryPlugin() and passed
 * to all extracted helper functions.
 */

import type { ScanFilter } from "../../build/generate-route-types.js";

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
  preset?: "node" | "cloudflare";
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
  routeSearchSchemas?: Record<string, Record<string, string>>;
  sourceFile?: string;
  factoryOnlyPrefixes?: Set<string>;
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
  mergedPrecomputedEntries: PrecomputedEntry[] | null;
  mergedRouteTrie: any;

  perRouterTrieMap: Map<string, any>;
  perRouterPrecomputedMap: Map<string, PrecomputedEntry[]>;
  perRouterManifestDataMap: Map<string, Record<string, string>>;

  prerenderManifestEntries: Record<string, string> | null;
  staticManifestEntries: Record<string, string> | null;
  handlerChunkInfoMap: Map<string, ChunkInfo>;
  staticHandlerChunkInfoMap: Map<string, ChunkInfo>;
  rscEntryFileName: string | null;
  resolvedPrerenderModules: Map<string, string[]> | undefined;
  resolvedStaticModules: Map<string, string[]> | undefined;

  discoveryDone: Promise<void> | null;
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
): DiscoveryState {
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
    mergedPrecomputedEntries: null,
    mergedRouteTrie: null,

    perRouterTrieMap: new Map(),
    perRouterPrecomputedMap: new Map(),
    perRouterManifestDataMap: new Map(),

    prerenderManifestEntries: null,
    staticManifestEntries: null,
    handlerChunkInfoMap: new Map(),
    staticHandlerChunkInfoMap: new Map(),
    rscEntryFileName: null,
    resolvedPrerenderModules: undefined,
    resolvedStaticModules: undefined,

    discoveryDone: null,
    devServerOrigin: null,
    devServer: null,
    selfWrittenGenFiles: new Map(),
    SELF_WRITE_WINDOW_MS: 5_000,
    lastDiscoveryError: null,
  };
}
