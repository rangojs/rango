import type {
  RouteDefinition,
  ResolvedRouteMap,
  Handler,
  HandlersForRouteMap,
  MiddlewareFn,
  ShouldRevalidateFn,
  ExtractRouteParams,
} from "./types.js";
import type { ReactNode } from "react";

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
export function route<const T extends RouteDefinition>(
  routes: T
): ResolvedRouteMap<T>;
export function route<const T extends string>(routeName: T): T;
export function route<const T extends RouteDefinition | string>(
  input: T
): T extends string ? T : ResolvedRouteMap<T & RouteDefinition> {
  if (typeof input === "string") {
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
export const revalidateRoute = <
  const T extends string,
  const Name extends string = string
>(
  routeName: T,
  name?: Name
): `$revalidate.route.${T}.${string}` => {
  const revalidateName = name || "default";
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
export const revalidateLayout = <
  const T extends string,
  const L extends string,
  const Name extends string = string
>(
  routeName: T,
  layoutName: L,
  name?: Name
): `$revalidate.layout.${T}.${L}.${string}` => {
  const revalidateName = name || "default";
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
  const revalidateName = name || "default";
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
      Location: url,
      "X-RSC-Redirect": url, // Marker for soft redirect
    },
  });
}

// ============================================================================
// ARRAY-BASED API WITH AsyncLocalStorage
// ============================================================================

/**
 * Entry data structure for manifest
 * Extensible for future features (tags, cache, meta, etc.)
 */
interface EntryData {
  handler: ReactNode | Handler<any, any> | Record<string, Handler<any, any>>;
  middleware?: MiddlewareFn<any, any>[];
  revalidate?: ShouldRevalidateFn<any, any>[];
}

/**
 * Context stored in AsyncLocalStorage
 */
interface HelperContext {
  manifest: Map<string, Array<[string, EntryData]>>;
  stack: Array<[string, EntryData]>;
  counters: {
    layout: number;
    parallel: number;
    middleware: number;
    revalidate: number;
  };
}

/**
 * Lazy-loaded AsyncLocalStorage (server-only)
 * Only initialized when map() is called (server-side only)
 */
let helperContext: any = null;

function getHelperContext() {
  if (!helperContext) {
    // Synchronous dynamic require for Node.js modules in ESM
    // This only runs on the server during map() execution
    // @ts-ignore - Dynamic require in ESM context
    const AsyncLocalStorage = globalThis.AsyncLocalStorage ||
      (typeof process !== 'undefined' && eval('require("node:async_hooks").AsyncLocalStorage'));

    if (!AsyncLocalStorage) {
      throw new Error("AsyncLocalStorage not available. map() can only be called on the server.");
    }

    helperContext = new AsyncLocalStorage();
  }
  return helperContext;
}

/**
 * Route helpers provided by map()
 * These are the only typed helpers users interact with
 */
export type RouteHelpers<T extends RouteDefinition, TEnv> = {
  route: <K extends keyof ResolvedRouteMap<T> & string>(
    name: K,
    handler: Handler<ExtractRouteParams<T, K & string>, TEnv>,
    use?: () => any[]
  ) => void;
  layout: (component: ReactNode | Handler<any, TEnv>, use?: () => any[]) => void;
  parallel: <TSlots extends Record<`@${string}`, Handler<any, TEnv>>>(
    slots: TSlots,
    use?: () => any[]
  ) => void;
  middleware: (...fns: MiddlewareFn<any, TEnv>[]) => void;
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => void;
};

/**
 * Create route helper
 */
function createRouteHelper<T extends RouteDefinition, TEnv>(): RouteHelpers<T, TEnv>["route"] {
  return (name, handler, use) => {
    const ctx = getHelperContext().getStore();
    if (!ctx) throw new Error("route() must be called inside map()");

    const id = `route.${name}`;
    const entry: EntryData = {
      handler,
      middleware: [],
      revalidate: [],
    };

    // Create route's manifest entry with current stack + route entry
    const routeStack: Array<[string, EntryData]> = [...ctx.stack, [id, entry]];
    ctx.manifest.set(name as string, routeStack);

    // Process use() callback if provided
    if (use) {
      // Run use() in new context where parallel/middleware/revalidate attach to route
      getHelperContext().run(
        {
          manifest: ctx.manifest,
          stack: routeStack,
          counters: ctx.counters,
        },
        () => {
          use();
        }
      );
    }
  };
}

/**
 * Create layout helper
 */
function createLayoutHelper<TEnv>(): RouteHelpers<any, TEnv>["layout"] {
  return (component, use) => {
    const ctx = getHelperContext().getStore();
    if (!ctx) throw new Error("layout() must be called inside map()");

    const id = `$layout.${ctx.counters.layout++}`;
    const entry: EntryData = {
      handler: component,
      middleware: [],
      revalidate: [],
    };

    // Check if this is an orphan layout (no child routes)
    if (!use) {
      // No use callback = just add to parent stack
      ctx.stack.push([id, entry]);
      return;
    }

    // Track routes before executing use()
    const routesBefore = new Set(ctx.manifest.keys());

    // Run use() in new context with extended stack
    getHelperContext().run(
      {
        manifest: ctx.manifest,
        stack: [...ctx.stack, [id, entry]],
        counters: ctx.counters,
      },
      () => {
        use();
      }
    );

    // Check if any routes were added
    const routesAfter = Array.from(ctx.manifest.keys());
    const newRoutes = routesAfter.filter((r) => !routesBefore.has(r));

    // If no new routes, this is an orphan layout - add to parent stack
    if (newRoutes.length === 0) {
      ctx.stack.push([id, entry]);
    }
  };
}

/**
 * Create parallel helper
 */
function createParallelHelper<TEnv>(): RouteHelpers<any, TEnv>["parallel"] {
  return (slots, use) => {
    const ctx = getHelperContext().getStore();
    if (!ctx) throw new Error("parallel() must be called inside map()");

    const id = `$parallel.${ctx.counters.parallel++}`;
    const entry: EntryData = {
      handler: slots,
      middleware: [],
      revalidate: [],
    };

    // Add parallel to current stack
    ctx.stack.push([id, entry]);

    // Process use() callback if provided
    if (use) {
      // Run use() in context where middleware/revalidate attach to parallel entry
      getHelperContext().run(
        {
          manifest: ctx.manifest,
          stack: [...ctx.stack],
          counters: ctx.counters,
        },
        () => {
          use();
        }
      );
    }
  };
}

/**
 * Create middleware helper
 */
function createMiddlewareHelper<TEnv>(): RouteHelpers<any, TEnv>["middleware"] {
  return (...fns) => {
    const ctx = getHelperContext().getStore();
    if (!ctx) throw new Error("middleware() must be called inside map()");

    // Attach to last entry in stack
    if (ctx.stack.length > 0) {
      const lastEntry = ctx.stack[ctx.stack.length - 1][1];
      if (!lastEntry.middleware) lastEntry.middleware = [];
      lastEntry.middleware.push(...fns);
    }
  };
}

/**
 * Create revalidate helper
 */
function createRevalidateHelper<TEnv>(): RouteHelpers<any, TEnv>["revalidate"] {
  return (fn) => {
    const ctx = getHelperContext().getStore();
    if (!ctx) throw new Error("revalidate() must be called inside map()");

    // Attach to last entry in stack
    if (ctx.stack.length > 0) {
      const lastEntry = ctx.stack[ctx.stack.length - 1][1];
      if (!lastEntry.revalidate) lastEntry.revalidate = [];
      lastEntry.revalidate.push(fn);
    }
  };
}

/**
 * Type-safe handler definition helper
 *
 * **New Array-based API with use() pattern:**
 * ```typescript
 * export default map<typeof shopRoutes>(({ route, layout, middleware, parallel, revalidate }) => [
 *   layout(<RootLayout />, () => [
 *     middleware(...loggerMiddleware),
 *     parallel({ "@banner": () => <Banner /> }),
 *
 *     layout(<ShopLayout />, () => [
 *       route("index", IndexRoute, () => [
 *         parallel({ "@sidebar": () => <Sidebar /> })
 *       ]),
 *
 *       route("products.detail", ProductsRoute, () => [
 *         revalidate(productRevalidation),
 *         parallel({ "@related": (ctx) => <Related slug={ctx.params.slug} /> })
 *       ]),
 *     ])
 *   ])
 * ])
 * ```
 *
 * **Features:**
 * - use() callbacks for configuration
 * - Orphan layouts (no child routes = extend parent)
 * - Multiple middleware/revalidate calls
 * - Parallel slots share config
 * - AsyncLocalStorage for implicit context
 */
export function map<
  const T extends RouteDefinition,
  TEnv = import("./types.js").DefaultEnv
>(
  builder:
    | ((helpers: RouteHelpers<T, TEnv>) => any[])
    | import("./types.js").HandlersForRouteMap<T, TEnv>
    | Record<string, any>
): import("./types.js").HandlersForRouteMap<T, TEnv> {
  // Check if it's a builder function (array-based API)
  if (typeof builder === "function") {
    const manifest = new Map<string, Array<[string, EntryData]>>();
    const counters = { layout: 0, parallel: 0, middleware: 0, revalidate: 0 };

    // Create helpers
    const helpers: RouteHelpers<T, TEnv> = {
      route: createRouteHelper<T, TEnv>(),
      layout: createLayoutHelper<TEnv>(),
      parallel: createParallelHelper<TEnv>(),
      middleware: createMiddlewareHelper<TEnv>(),
      revalidate: createRevalidateHelper<TEnv>(),
    };

    // Execute builder in AsyncLocalStorage context
    getHelperContext().run(
      {
        manifest,
        stack: [],
        counters,
      },
      () => {
        builder(helpers);
      }
    );

    // Convert manifest to old format for compatibility
    const result: any = {};
    for (const [routeName, entries] of manifest.entries()) {
      // Find the route entry (ID starts with "route.")
      const routeEntry = entries.find(([id]) => id.startsWith("route."));
      if (!routeEntry) {
        throw new Error(`No route entry found for ${routeName}`);
      }
      result[routeName] = routeEntry[1].handler;

      // Add layouts, parallels, middleware, revalidation
      let layoutCounter = 0;
      let parallelCounter = 0;

      for (const [id, entry] of entries) {
        // Skip the route entry itself
        if (id === routeEntry[0]) continue;

        if (id.startsWith("$layout.")) {
          const layoutName = `layout-${layoutCounter++}`;
          result[`$layout.${routeName}.${layoutName}`] = entry.handler;

          // Add layout's middleware
          if (entry.middleware && entry.middleware.length > 0) {
            result[`$middleware.${routeName}.${layoutName}`] = entry.middleware;
          }

          // Add layout's revalidation
          if (entry.revalidate && entry.revalidate.length > 0) {
            for (let j = 0; j < entry.revalidate.length; j++) {
              result[`$revalidate.route.${routeName}.${layoutName}-${j}`] = entry.revalidate[j];
            }
          }
        } else if (id.startsWith("$parallel.")) {
          const parallelName = `parallel-${parallelCounter++}`;
          result[`$parallel.${routeName}.${parallelName}`] = entry.handler;

          // Add parallel's middleware
          if (entry.middleware && entry.middleware.length > 0) {
            result[`$middleware.${routeName}.${parallelName}`] = entry.middleware;
          }

          // Add parallel's revalidation
          if (entry.revalidate && entry.revalidate.length > 0) {
            for (let j = 0; j < entry.revalidate.length; j++) {
              result[`$revalidate.route.${routeName}.${parallelName}-${j}`] = entry.revalidate[j];
            }
          }
        }
      }

      // Add route-level middleware and revalidation
      if (routeEntry[1].middleware && routeEntry[1].middleware.length > 0) {
        result[`$middleware.${routeName}.route`] = routeEntry[1].middleware;
      }
      if (routeEntry[1].revalidate && routeEntry[1].revalidate.length > 0) {
        for (let j = 0; j < routeEntry[1].revalidate.length; j++) {
          result[`$revalidate.route.${routeName}.route-${j}`] = routeEntry[1].revalidate[j];
        }
      }
    }

    console.log("[map] Manifest:", manifest);
    console.log("[map] Result:", Object.keys(result));
    return result as import("./types.js").HandlersForRouteMap<T, TEnv>;
  }

  // Object-based API (legacy)
  return builder as import("./types.js").HandlersForRouteMap<T, TEnv>;
}
