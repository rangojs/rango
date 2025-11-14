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
 * // Define routes (use relative paths when mounting at a prefix)
 * const blogRoutes = route({
 *   index: '/',
 *   post: '/:slug'
 * });
 *
 * // Mount at /blog prefix in router:
 * router.route('/blog', blogRoutes).map(() => import('./blog.js'));
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
      // Direct route pattern - include prefix
      flattened[prefix + key] = value;
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
 * Supports multiple named revalidations per route. They execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @example
 * ```typescript
 * {
 *   // Global revalidation - applies to all routes
 *   [revalidate('*', 'default')]: ({ defaultShouldRevalidate }) => defaultShouldRevalidate,
 *
 *   // Route-specific revalidations (multiple)
 *   [revalidate('post', 'auth')]: ({ context }) => context.user?.id !== context.prevUser?.id,
 *   [revalidate('post', 'cache')]: ({ currentParams, nextParams }) => {
 *     return currentParams.slug !== nextParams.slug;
 *   },
 *
 *   // Single name can be omitted for simple case
 *   [revalidate('about')]: () => false  // Never revalidate
 * }
 * ```
 */
export const revalidate = <const T extends string, const Name extends string = string>(
  routeName: T,
  name?: Name
): `$revalidate.${T}.${string}` => {
  const revalidateName = name || 'default';
  return `$revalidate.${routeName}.${revalidateName}` as const;
};

/**
 * Type-safe handler definition helper
 *
 * Supports two patterns for type-safe context:
 *
 * **Pattern 1: Module Augmentation (Recommended - No imports needed)**
 * ```typescript
 * // In router.tsx:
 * declare global {
 *   namespace RSCRouter {
 *     interface Env extends RouterEnv<AppBindings, AppVariables> {}
 *   }
 * }
 *
 * // In handler file - context is automatically typed!
 * export default map<typeof shopRoutes>({
 *   [middleware('*', 'auth')]: [
 *     (ctx, next) => {
 *       ctx.set('user', ...) // Type-safe via global augmentation!
 *     }
 *   ]
 * })
 * ```
 *
 * **Pattern 2: Explicit Generic (Alternative - Explicit imports)**
 * ```typescript
 * import type { AppEnv } from '../router.js';
 *
 * export default map<typeof blogRoutes, AppEnv>({
 *   [middleware('*', 'auth')]: [
 *     (ctx, next) => {
 *       ctx.set('user', ...) // Type-safe via explicit generic!
 *     }
 *   ]
 * })
 * ```
 */
export function map<const T extends RouteDefinition, TEnv = import("./types.js").DefaultEnv>(
  handlers: import("./types.js").HandlersForRouteMap<T, TEnv> | Record<string, any>
): import("./types.js").HandlersForRouteMap<T, TEnv> {
  // Pass-through for type safety
  // Union with Record<string, any> allows object literals with inferred string index signatures
  return handlers as import("./types.js").HandlersForRouteMap<T, TEnv>;
}
