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
  include?: string[];
  exclude?: string[];
  // Mutable ref for deferred auto-discovery (node preset).
  // The auto-discover config() hook populates this before configResolved.
  routerPathRef?: { path?: string };
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
  handlerChunkInfo: ChunkInfo | null;
  staticHandlerChunkInfo: ChunkInfo | null;
  rscEntryFileName: string | null;
  resolvedPrerenderModules: Map<string, string[]> | undefined;
  resolvedStaticModules: Map<string, string[]> | undefined;

  discoveryDone: Promise<void> | null;
  devServerOrigin: string | null;
  devServer: any;
  selfWrittenGenFiles: Map<string, { at: number; hash: string }>;
  SELF_WRITE_WINDOW_MS: number;
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
    handlerChunkInfo: null,
    staticHandlerChunkInfo: null,
    rscEntryFileName: null,
    resolvedPrerenderModules: undefined,
    resolvedStaticModules: undefined,

    discoveryDone: null,
    devServerOrigin: null,
    devServer: null,
    selfWrittenGenFiles: new Map(),
    SELF_WRITE_WINDOW_MS: 5_000,
  };
}
