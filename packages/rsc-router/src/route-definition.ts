import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
} from "./types.js";

/**
 * Define a route map with patterns
 *
 * @example
 * ```typescript
 * const blogRoutes = route({
 *   index: '/blog',
 *   post: '/blog/:slug',
 *   category: '/blog/:category/:id'
 * });
 * ```
 */
export function route<const T extends RouteDefinition>(
  routes: T
): ResolvedRouteMap<T> {
  return flattenRoutes(routes, "") as ResolvedRouteMap<T>;
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
      // Direct route pattern
      flattened[key] = value;
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(value, `${prefix}${key}.`);
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

/**
 * Type-safe handler definition helper
 *
 * @example
 * ```typescript
 * export default map<typeof blogRoutes>({
 *   [route.layout]: BlogLayout,
 *   index: (ctx) => <BlogIndex />,
 *   post: (ctx) => <BlogPost slug={ctx.params.slug} />
 * });
 * ```
 */
export function map<T extends RouteDefinition, TContext = any>(
  handlers: HandlersForRouteMap<T, TContext>
): HandlersForRouteMap<T, TContext> {
  // Pass-through for type safety
  return handlers;
}
