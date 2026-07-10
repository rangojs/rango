/**
 * Route manifest storage and retrieval.
 *
 * The route manifest maps route names to URL patterns. It is populated
 * by the virtual module (which imports from .named-routes.gen.ts files)
 * and consumed by reverse() and href() at runtime.
 *
 * See docs/manifests.md for the full data flow.
 */

let globalRouteMap: Record<string, string> = {};

let cachedManifest: Record<string, string> | null = null;

/**
 * Register routes into the global route map.
 * Routes are merged with any existing registered routes.
 * Called by createRouter() during module evaluation, and by lazy-include
 * expansion (src/router/lazy-includes.ts) with each expansion's route delta.
 *
 * Merges IN PLACE — O(|map|), not O(total routes). The previous
 * `globalRouteMap = { ...globalRouteMap, ...map }` copy made every
 * lazy-include first hit O(total routes) on the request path: with a 26k-route
 * manifest the spread measured 8.9ms/call (M4, node), paid once per level of a
 * nested async-include chain (3 calls on a 3-level chain — the 464ms edge
 * cold-hit in issue #666).
 *
 * In-place mutation is safe because every getGlobalRouteMap() consumer reads
 * it fresh per call (server/request-context.ts, rsc/loader-fetch.ts,
 * router/intercept-resolution.ts, testing/generated-routes.ts,
 * rsc/manifest-init.ts) — none memoizes the returned reference. If you add a
 * consumer that caches the map object, it will now observe later
 * registrations; snapshot it yourself if you need frozen contents.
 */
export function registerRouteMap(map: Record<string, string>): void {
  Object.assign(globalRouteMap, map);
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
  rootScopeRoutes.clear();
  perRouterRootScopeRoutes.clear();
  globalSearchSchemas.clear();
  perRouterSearchSchemas.clear();
  perRouterManifestMap.clear();
  perRouterTrieMap.clear();
  perRouterPrecomputedEntriesMap.clear();
  authoritativeTrieRouters.clear();
  // Clear the loader registry too: a loader that survives a clear closes over
  // a module import whose data predates the clear, and re-running it would
  // re-install that stale trie as authoritative.
  routerManifestLoaders.clear();
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

// Routers whose trie came from the COMPLETE build manifest (deserialized via
// ensureRouterManifest). For these, a trie miss is a real 404 and findMatch
// skips the regex fallback scan — the only remaining route-count-proportional
// match path (#664). Dev rebuilds (manifest-init.ts, router-discovery HMR
// pushes) deliberately never mark authoritative: the dev-only trie-gap warning
// in find-match.ts depends on the fallback running on misses, and dev route
// churn (HMR, dev-time routes) makes a stale-trie 404 unacceptable there.
const authoritativeTrieRouters: Set<string> = new Set();

export function markRouterTrieAuthoritative(routerId: string): void {
  authoritativeTrieRouters.add(routerId);
}

export function isRouterTrieAuthoritative(routerId: string): boolean {
  return authoritativeTrieRouters.has(routerId);
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
  // Gate on the trie: it is the only data the lazy loader supplies (the
  // name->path map is pre-set by the eager virtual module's
  // setRouterManifest() and never comes from the loader). Gating on the
  // manifest instead would let the loader be skipped while the per-router
  // trie is missing, and findMatch would fall back to insertion-order regex
  // matching — which mishandles wildcard priority (catch-alls match before
  // specific routes).
  if (perRouterTrieMap.has(routerId)) return;
  const loader = routerManifestLoaders.get(routerId);
  if (loader) {
    const mod = await loader();
    if (mod.trie) {
      perRouterTrieMap.set(routerId, mod.trie);
      // A trie serialized into the build manifest comes from complete
      // discovery — misses are authoritative 404s (see find-match.ts).
      markRouterTrieAuthoritative(routerId);
    }
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

// Tracks whether each route is at root scope (no named include boundary above).
// Used by dot-local reverse resolution to decide whether bare-name fallback
// is allowed after scoped lookups are exhausted.
//
// Both this and the search-schema registry below are keyed by route NAME and
// registered by path() at evaluation time. Two routers can legally declare the
// same route name (per-router manifests keep them apart), so each registry has
// a per-router tier consulted first; the global tier is the fallback for
// contexts with no router identity (single-router apps, unit tests, evaluation
// outside generateManifestFull). Without the per-router tier, the
// last-evaluated router silently won for BOTH routers.
const rootScopeRoutes: Map<string, boolean> = new Map();
const perRouterRootScopeRoutes: Map<string, Map<string, boolean>> = new Map();

/**
 * Register whether a route is at root scope.
 * Called by path() during route evaluation.
 */
export function registerRouteRootScope(
  routeName: string,
  rootScoped: boolean,
  routerId?: string,
): void {
  rootScopeRoutes.set(routeName, rootScoped);
  if (routerId) {
    let perRouter = perRouterRootScopeRoutes.get(routerId);
    if (!perRouter) {
      perRouter = new Map();
      perRouterRootScopeRoutes.set(routerId, perRouter);
    }
    perRouter.set(routeName, rootScoped);
  }
}

/**
 * Check if a route is at root scope.
 * Returns undefined if the route has not been registered (e.g. in unit tests).
 */
export function isRouteRootScoped(
  routeName: string,
  routerId?: string,
): boolean | undefined {
  if (routerId) {
    const scoped = perRouterRootScopeRoutes.get(routerId)?.get(routeName);
    if (scoped !== undefined) return scoped;
  }
  return rootScopeRoutes.get(routeName);
}

import type { SearchSchema } from "./search-params.js";

const globalSearchSchemas: Map<string, SearchSchema> = new Map();
const perRouterSearchSchemas: Map<
  string,
  Map<string, SearchSchema>
> = new Map();

export function registerSearchSchema(
  routeName: string,
  schema: SearchSchema,
  routerId?: string,
): void {
  globalSearchSchemas.set(routeName, schema);
  if (routerId) {
    let perRouter = perRouterSearchSchemas.get(routerId);
    if (!perRouter) {
      perRouter = new Map();
      perRouterSearchSchemas.set(routerId, perRouter);
    }
    perRouter.set(routeName, schema);
  }
}

export function getSearchSchema(
  routeName: string,
  routerId?: string,
): SearchSchema | undefined {
  if (routerId) {
    const schema = perRouterSearchSchemas.get(routerId)?.get(routeName);
    if (schema !== undefined) return schema;
  }
  return globalSearchSchemas.get(routeName);
}
