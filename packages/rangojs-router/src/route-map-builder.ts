/**
 * Client-safe route map builder
 *
 * Provides a fluent API for building route maps with prefixes.
 * Can be imported in client code without pulling in server dependencies.
 *
 * @example
 * ```typescript
 * import { createRouteMap, registerRouteMap } from "rsc-router/browser";
 *
 * const routeMap = createRouteMap()
 *   .add(homeRoutes)
 *   .add(blogRoutes, "blog")
 *   .add(shopRoutes, "shop");
 *
 * registerRouteMap(routeMap.routes);
 *
 * declare global {
 *   namespace RSCRouter {
 *     interface RegisteredRoutes extends typeof routeMap.routes {}
 *   }
 * }
 * ```
 */

import type { PrefixRoutePatterns } from "./href.js";

/**
 * Route map builder interface
 *
 * Accumulates route types through the builder chain for type-safe href.
 */
export interface RouteMapBuilder<TRoutes extends Record<string, string> = {}> {
  /**
   * Add routes without prefix
   */
  add<T extends Record<string, string>>(routes: T): RouteMapBuilder<TRoutes & T>;

  /**
   * Add routes with prefix (only URL patterns are prefixed, keys stay unchanged)
   * @param routes - Route definitions to add
   * @param prefix - URL prefix WITHOUT leading slash (e.g., "blog" not "/blog")
   */
  add<T extends Record<string, string>, P extends string>(
    routes: T,
    prefix: P
  ): RouteMapBuilder<TRoutes & PrefixRoutePatterns<T, `/${P}`>>;

  /**
   * The accumulated route map (for typeof extraction in module augmentation)
   */
  readonly routes: TRoutes;
}

/**
 * Add routes to a map with optional prefix
 * Keys stay unchanged for composability - only URL patterns get prefixed.
 *
 * @param routeMap - The map to add routes to
 * @param routes - Routes to add
 * @param prefix - Optional prefix for URL paths WITHOUT leading slash (keys stay unchanged)
 */
function addRoutes(
  routeMap: Record<string, string>,
  routes: Record<string, string>,
  prefix: string = ""
): void {
  // Normalize prefix: remove leading slash if accidentally provided
  const normalizedPrefix = prefix.startsWith("/") ? prefix.slice(1) : prefix;

  for (const [key, pattern] of Object.entries(routes)) {
    const prefixedPattern =
      normalizedPrefix && pattern !== "/"
        ? `/${normalizedPrefix}${pattern}`
        : normalizedPrefix && pattern === "/"
          ? `/${normalizedPrefix}`
          : pattern;
    // Use original key - enables reusable route modules
    routeMap[key] = prefixedPattern;
  }
}

/**
 * Create a new route map builder
 *
 * @returns A builder for accumulating routes with type-safe prefixes
 *
 * @example
 * ```typescript
 * const routeMap = createRouteMap()
 *   .add(homeRoutes)
 *   .add(blogRoutes, "blog");
 *
 * // Types are accumulated through the chain
 * type AppRoutes = typeof routeMap.routes;
 * ```
 */
export function createRouteMap(): RouteMapBuilder<{}> {
  const routeMap: Record<string, string> = {};

  const builder: RouteMapBuilder<any> = {
    add(routes: Record<string, string>, prefix?: string) {
      addRoutes(routeMap, routes, prefix);
      return builder;
    },
    get routes() {
      return routeMap;
    },
  };

  return builder;
}

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
 * Register the route map globally for href to use at runtime
 *
 * Call this after building your route map to make it available to href.
 * Routes are merged with any existing registered routes.
 *
 * @param map - The route map to register
 *
 * @example
 * ```typescript
 * const routeMap = createRouteMap()
 *   .add(homeRoutes)
 *   .add(blogRoutes, "blog");
 *
 * registerRouteMap(routeMap.routes);
 * ```
 */
export function registerRouteMap(map: Record<string, string>): void {
  // Always merge with existing map (don't replace)
  globalRouteMap = { ...globalRouteMap, ...map };
}

/**
 * Get the globally registered route map
 *
 * Used internally by href to resolve route names to URLs at runtime.
 * Returns the cached manifest if available (complete with lazy includes),
 * otherwise returns the runtime-accumulated route map.
 *
 * @returns The registered route map
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
  entries: Array<{ staticPrefix: string; routes: Record<string, string> }> | null,
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

// Route ancestry map: route name -> array of shortCodes from root to route.
// Used by layout() to skip non-ancestor subtrees during manifest evaluation.
let cachedRouteAncestry: Record<string, string[]> | null = null;

export function setRouteTrie(trie: typeof cachedRouteTrie): void {
  cachedRouteTrie = trie;
}

export function getRouteTrie(): typeof cachedRouteTrie {
  return cachedRouteTrie;
}

export function setRouteAncestry(map: typeof cachedRouteAncestry): void {
  cachedRouteAncestry = map;
}

export function getRouteAncestry(): typeof cachedRouteAncestry {
  return cachedRouteAncestry;
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
