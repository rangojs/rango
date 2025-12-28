/**
 * Client-safe route utilities
 *
 * These utilities can be imported in client code without pulling in server dependencies.
 */

import type { RouteDefinition, RouteConfig, ResolvedRouteMap } from "./types.js";

/**
 * Check if a value is a RouteConfig object
 */
function isRouteConfig(value: unknown): value is RouteConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "path" in value &&
    typeof (value as RouteConfig).path === "string"
  );
}

/**
 * Flatten nested route definitions
 */
function flattenRoutes(
  routes: RouteDefinition,
  prefix: string
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(routes)) {
    if (typeof value === "string") {
      // Direct route pattern - include prefix
      flattened[prefix + key] = value;
    } else if (isRouteConfig(value)) {
      // Route config object - extract path
      flattened[prefix + key] = value.path;
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(value, `${prefix}${key}.`);
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

/**
 * Define routes with type safety (client-safe version)
 *
 * This is a client-safe version of the route function that can be imported
 * in client code without pulling in server dependencies.
 *
 * @param input - Route definition object
 * @returns Flattened route map with full type information
 *
 * @example
 * ```typescript
 * const shopRoutes = route({
 *   index: "/",
 *   cart: "/cart",
 *   products: {
 *     detail: "/product/:slug",
 *     category: "/products/:category",
 *   },
 * });
 * // Result: { index: "/", cart: "/cart", "products.detail": "/product/:slug", "products.category": "/products/:category" }
 * ```
 */
export function route<const T extends RouteDefinition>(
  input: T
): ResolvedRouteMap<T> {
  return flattenRoutes(input as RouteDefinition, "") as ResolvedRouteMap<T>;
}
