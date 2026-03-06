/**
 * Route manifest storage and retrieval.
 *
 * The route manifest maps route names to URL patterns. It is populated
 * by the virtual module (which imports from .named-routes.gen.ts files)
 * and consumed by reverse() and href() at runtime.
 *
 * See docs/manifests.md for the full data flow.
 */

// Singleton route map instance - populated incrementally as routes are encountered
let globalRouteMap: Record<string, string> = {};

// Cached complete manifest - includes all routes (including lazy includes)
// Set from runtime cache or build-time import
let cachedManifest: Record<string, string> | null = null;

// Pre-computed route entries from build-time prefix tree leaf nodes.
// Used by evaluateLazyEntry() to skip running the handler for route matching.
let cachedPrecomputedEntries: Array<{
  staticPrefix: string;
  routes: Record<string, string>;
}> | null = null;

/**
 * Register routes into the global route map.
 * Routes are merged with any existing registered routes.
 * Called by createRouter() during module evaluation.
 */
export function registerRouteMap(map: Record<string, string>): void {
  // Always merge with existing map (don't replace)
  globalRouteMap = { ...globalRouteMap, ...map };
}

/**
 * Get the globally registered route map
 *
 * Used internally by reverse to resolve route names to URLs at runtime.
 * Returns the cached manifest if available (complete with lazy includes),
 * otherwise returns the runtime-accumulated route map.
 *
 * @returns The registered route map
 * @internal
 */
export function getGlobalRouteMap(): Record<string, string> {
  // Cached manifest is complete (includes lazy routes), so prefer it
  if (cachedManifest) {
    return cachedManifest;
  }
  return globalRouteMap;
}

/**
 * Set the cached manifest (for runtime cache integration)
 *
 * This sets the complete route manifest from a runtime cache.
 * The cached manifest includes all routes (including lazy includes)
 * and takes precedence over the incrementally-built globalRouteMap.
 *
 * @param manifest - The complete route manifest to cache
 */
export function setCachedManifest(manifest: Record<string, string>): void {
  cachedManifest = manifest;
}

/**
 * Check if a cached manifest is loaded
 *
 * @returns true if a complete manifest is available
 */
export function hasCachedManifest(): boolean {
  return cachedManifest !== null;
}

/**
 * Clear the cached manifest (for testing)
 */
export function clearCachedManifest(): void {
  cachedManifest = null;
}

/**
 * Set pre-computed route entries from build-time data.
 *
 * Each entry corresponds to a leaf node in the prefix tree (no nested includes).
 * evaluateLazyEntry() checks these before running the handler, avoiding the
 * 5-50ms cost of handler evaluation for route matching on the first request.
 *
 * @param entries - Array of { staticPrefix, routes } from build-time prefix tree leaves
 */
export function setPrecomputedEntries(
  entries: Array<{
    staticPrefix: string;
    routes: Record<string, string>;
  }> | null,
): void {
  cachedPrecomputedEntries = entries;
}

/**
 * Get pre-computed route entries (if available)
 */
export function getPrecomputedEntries(): typeof cachedPrecomputedEntries {
  return cachedPrecomputedEntries;
}

// Route trie for O(path_length) matching at runtime.
// Built at build time from the route manifest and serialized into the virtual module.
let cachedRouteTrie: import("./build/route-trie.js").TrieNode | null = null;

export function setRouteTrie(trie: typeof cachedRouteTrie): void {
  cachedRouteTrie = trie;
}

export function getRouteTrie(): typeof cachedRouteTrie {
  return cachedRouteTrie;
}

// Per-router isolated data: each router gets its own manifest, trie, and
// precomputed entries so multi-router setups (e.g. site + admin via
// createHostRouter()) don't see each other's routes.
const perRouterManifestMap: Map<string, Record<string, string>> = new Map();
const perRouterTrieMap: Map<string, import("./build/route-trie.js").TrieNode> =
  new Map();
const perRouterPrecomputedEntriesMap: Map<
  string,
  Array<{ staticPrefix: string; routes: Record<string, string> }>
> = new Map();

/**
 * Clear all cached route data (global and per-router).
 * Called during HMR when route definitions change so the handler rebuilds
 * the trie from the updated router.urlpatterns on the next request.
 *
 * The virtual module calls this before repopulating with fresh data,
 * preventing stale entries from removed routes from accumulating.
 */
export function clearAllRouterData(): void {
  globalRouteMap = {};
  cachedManifest = null;
  cachedPrecomputedEntries = null;
  cachedRouteTrie = null;
  globalSearchSchemas.clear();
  perRouterManifestMap.clear();
  perRouterTrieMap.clear();
  perRouterPrecomputedEntriesMap.clear();
}

export function setRouterManifest(
  routerId: string,
  manifest: Record<string, string>,
): void {
  perRouterManifestMap.set(routerId, manifest);
}

/** @internal */
export function getRouterManifest(
  routerId: string,
): Record<string, string> | undefined {
  return perRouterManifestMap.get(routerId);
}

export function setRouterTrie(
  routerId: string,
  trie: import("./build/route-trie.js").TrieNode,
): void {
  perRouterTrieMap.set(routerId, trie);
}

export function getRouterTrie(
  routerId: string,
): import("./build/route-trie.js").TrieNode | undefined {
  return perRouterTrieMap.get(routerId);
}

export function setRouterPrecomputedEntries(
  routerId: string,
  entries: Array<{ staticPrefix: string; routes: Record<string, string> }>,
): void {
  perRouterPrecomputedEntriesMap.set(routerId, entries);
}

export function getRouterPrecomputedEntries(
  routerId: string,
): Array<{ staticPrefix: string; routes: Record<string, string> }> | undefined {
  return perRouterPrecomputedEntriesMap.get(routerId);
}

// Lazy loader registry: per-router manifest modules are loaded on first request
// via import() to keep startup fast and allow Rollup to code-split per router.
const routerManifestLoaders: Map<string, () => Promise<any>> = new Map();

export function registerRouterManifestLoader(
  routerId: string,
  loader: () => Promise<any>,
): void {
  routerManifestLoaders.set(routerId, loader);
}

export async function ensureRouterManifest(routerId: string): Promise<void> {
  if (perRouterManifestMap.has(routerId)) return;
  const loader = routerManifestLoaders.get(routerId);
  if (loader) {
    const mod = await loader();
    if (mod.manifest) perRouterManifestMap.set(routerId, mod.manifest);
    if (mod.trie) perRouterTrieMap.set(routerId, mod.trie);
    if (mod.precomputedEntries)
      perRouterPrecomputedEntriesMap.set(routerId, mod.precomputedEntries);
    routerManifestLoaders.delete(routerId);
  }
}

// Dev-mode manifest readiness gate.
// The Vite discovery plugin calls setManifestReadyPromise() before starting
// discovery, and resolves it when discovery completes. The handler awaits
// waitForManifestReady() on first request if the manifest isn't yet available.
let manifestReadyPromise: Promise<void> | null = null;

export function setManifestReadyPromise(promise: Promise<void>): void {
  manifestReadyPromise = promise;
}

export function waitForManifestReady(): Promise<void> | null {
  return manifestReadyPromise;
}

// ============================================================================
// Search Schema Registry
// ============================================================================

import type { SearchSchema } from "./search-params.js";

// Global search schema map: route name -> search schema descriptor.
// Populated by path() when a search option is provided.
const globalSearchSchemas: Map<string, SearchSchema> = new Map();

export function registerSearchSchema(
  routeName: string,
  schema: SearchSchema,
): void {
  globalSearchSchemas.set(routeName, schema);
}

export function getSearchSchema(routeName: string): SearchSchema | undefined {
  return globalSearchSchemas.get(routeName);
}
