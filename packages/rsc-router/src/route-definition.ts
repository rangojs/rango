import type {
  RouteDefinition,
  ResolvedRouteMap,
} from "./types.js";

/**
 * Define routes or get a route key
 *
 * @overload Define a route map with patterns
 * @overload Get a route handler key (for consistency with other helpers)
 *
 * @example
 * ```typescript
 * // Define routes
 * const blogRoutes = route({
 *   index: '/blog',
 *   post: '/blog/:slug'
 * });
 *
 * // Use in handlers (optional, for consistency)
 * export default map<typeof blogRoutes>({
 *   index: () => <Component />,           // Shorthand
 *   [route('post')]: (ctx) => <Post />    // Explicit
 * });
 * ```
 */
export function route<const T extends RouteDefinition>(routes: T): ResolvedRouteMap<T>;
export function route<const T extends string>(routeName: T): T;
export function route<const T extends RouteDefinition | string>(
  input: T
): T extends string ? T : ResolvedRouteMap<T & RouteDefinition> {
  if (typeof input === 'string') {
    return input as any;
  }
  return flattenRoutes(input as RouteDefinition, "") as any;
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
 * Define a layout for a specific route
 *
 * @example
 * ```typescript
 * {
 *   [layout('index', 'root')]: <RootLayout />,
 *   [layout('post', 'blog')]: <BlogLayout />
 * }
 * ```
 */
export const layout = <const T extends string, const Name extends string>(
  routeName: T,
  name: Name
): `$layout.${T}.${Name}` => `$layout.${routeName}.${name}` as const;

/**
 * Define parallel routes for a specific route
 *
 * @example
 * ```typescript
 * {
 *   [parallel('index', 'sidebar')]: {
 *     '@sidebar': (ctx) => <Sidebar />
 *   }
 * }
 * ```
 */
export const parallel = <const T extends string, const Name extends string>(
  routeName: T,
  name: Name
): `$parallel.${T}.${Name}` => `$parallel.${routeName}.${name}` as const;

/**
 * Define middleware for a specific route
 *
 * @example
 * ```typescript
 * {
 *   [middleware('index', 'auth')]: [
 *     (ctx, next) => { console.log('auth'); next(); }
 *   ]
 * }
 * ```
 */
export const middleware = <const T extends string, const Name extends string>(
  routeName: T,
  name: Name
): `$middleware.${T}.${Name}` => `$middleware.${routeName}.${name}` as const;

/**
 * Define revalidation function for a specific route
 *
 * @example
 * ```typescript
 * {
 *   [revalidate('post')]: (ctx) => ctx.prevParams.slug !== ctx.nextParams.slug
 * }
 * ```
 */
export const revalidate = <const T extends string>(
  routeName: T
): `$revalidate.${T}` => `$revalidate.${routeName}` as const;

/**
 * Type-safe handler definition helper
 *
 * @example
 * ```typescript
 * export default map<typeof blogRoutes>({
 *   [layout('index', 'root')]: <RootLayout />,
 *   index: (ctx) => <BlogIndex />,
 *   post: (ctx) => <BlogPost slug={ctx.params.slug} />
 * });
 * ```
 */
export function map<const T extends RouteDefinition, TContext = any>(
  handlers: import("./types.js").HandlersForRouteMap<T, TContext>
): import("./types.js").HandlersForRouteMap<T, TContext> {
  // Pass-through for type safety
  return handlers;
}
