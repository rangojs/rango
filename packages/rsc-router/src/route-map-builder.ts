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

// Singleton route map instance - populated when routes.ts is imported
let globalRouteMap: Record<string, string> = {};

/**
 * Register the route map globally for href to use at runtime
 *
 * Call this after building your route map to make it available to href.
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
  globalRouteMap = map;
}

/**
 * Get the globally registered route map
 *
 * Used internally by href to resolve route names to URLs at runtime.
 *
 * @returns The registered route map
 */
export function getGlobalRouteMap(): Record<string, string> {
  return globalRouteMap;
}
