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
 * Define revalidation function for a route handler
 *
 * Only called when evaluating whether to revalidate the route handler itself.
 * Supports multiple named revalidations per route. They execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @example
 * ```typescript
 * {
 *   // Global route revalidation - applies to all route handlers
 *   [revalidateRoute('*', 'default')]: ({ defaultShouldRevalidate }) => defaultShouldRevalidate,
 *
 *   // Route-specific revalidation
 *   [revalidateRoute('products.detail', 'params')]: ({ currentParams, nextParams }) => {
 *     return currentParams.slug !== nextParams.slug;
 *   },
 *
 *   // Single name can be omitted for simple case
 *   [revalidateRoute('about')]: () => false  // Never revalidate
 * }
 * ```
 */
export const revalidateRoute = <const T extends string, const Name extends string = string>(
  routeName: T,
  name?: Name
): `$revalidate.route.${T}.${string}` => {
  const revalidateName = name || 'default';
  return `$revalidate.route.${routeName}.${revalidateName}` as const;
};

/**
 * Define revalidation function for a specific layout
 *
 * Only called when evaluating whether to revalidate the specified layout.
 * Supports multiple named revalidations per layout. They execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @example
 * ```typescript
 * {
 *   // Global layout revalidation - applies to all layouts named "shop"
 *   [revalidateLayout('*', 'shop', 'default')]: ({ context }) => context.get('shopChanged'),
 *
 *   // Route-specific layout revalidation
 *   [revalidateLayout('products.detail', 'shop', 'user')]: ({ context }) => {
 *     return context.user?.id !== context.prevUser?.id;
 *   },
 *
 *   // Single name can be omitted for simple case
 *   [revalidateLayout('checkout.*', 'checkout')]: () => true  // Always revalidate
 * }
 * ```
 */
export const revalidateLayout = <const T extends string, const L extends string, const Name extends string = string>(
  routeName: T,
  layoutName: L,
  name?: Name
): `$revalidate.layout.${T}.${L}.${string}` => {
  const revalidateName = name || 'default';
  return `$revalidate.layout.${routeName}.${layoutName}.${revalidateName}` as const;
};

/**
 * Define revalidation function for a specific parallel route
 *
 * Only called when evaluating whether to revalidate the specified parallel route.
 * Supports multiple named revalidations per parallel route. They execute in order
 * and short-circuit on first `true` (OR logic).
 *
 * @example
 * ```typescript
 * {
 *   // Global parallel revalidation - applies to all "@sidebar" parallels
 *   [revalidateParallel('*', 'sidebar', '@sidebar', 'default')]: ({ context }) => {
 *     return context.get('sidebarChanged');
 *   },
 *
 *   // Route-specific parallel revalidation
 *   [revalidateParallel('products.detail', 'related', '@related', 'params')]: ({ currentParams, nextParams }) => {
 *     return currentParams.slug !== nextParams.slug;
 *   },
 *
 *   // Single name can be omitted for simple case
 *   [revalidateParallel('cart', 'summary', '@summary')]: () => true  // Always revalidate
 * }
 * ```
 */
export const revalidateParallel = <
  const T extends string,
  const P extends string,
  const S extends string,
  const Name extends string = string
>(
  routeName: T,
  parallelName: P,
  slotName: S,
  name?: Name
): `$revalidate.parallel.${T}.${P}.${S}.${string}` => {
  const revalidateName = name || 'default';
  return `$revalidate.parallel.${routeName}.${parallelName}.${slotName}.${revalidateName}` as const;
};

/**
 * Create a soft redirect response for SPA navigation
 *
 * Soft redirects stay within the SPA and do a partial RSC fetch to the target URL.
 * Use this for auth redirects or navigation that should feel seamless.
 *
 * For hard redirects (full page reload), use `Response.redirect()` directly.
 *
 * @param url - Destination URL
 * @param status - HTTP status code (default: 302)
 *
 * @example
 * ```typescript
 * [middleware('checkout.*', 'auth')]: [
 *   (ctx, next) => {
 *     if (!ctx.get('user')) {
 *       return redirect('/login'); // Soft redirect - SPA navigation
 *     }
 *     next();
 *   }
 * ]
 *
 * // Hard redirect (full page reload):
 * return Response.redirect('/login', 302);
 * ```
 */
export function redirect(url: string, status: number = 302): Response {
  return new Response(null, {
    status,
    headers: {
      'Location': url,
      'X-RSC-Redirect': url,  // Marker for soft redirect
    },
  });
}

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
