import type { ReactNode } from "react";
import type { AllUseItems } from "./route-types.js";

/**
 * Global namespace for module augmentation
 *
 * Users can augment this to provide type-safe context globally:
 *
 * @example
 * ```typescript
 * // In router.tsx or env.d.ts
 * declare global {
 *   namespace RSCRouter {
 *     interface Env extends RouterEnv<AppBindings, AppVariables> {}
 *   }
 * }
 *
 * // Now all handlers have type-safe context without imports!
 * export default map<typeof shopRoutes>({
 *   [middleware('*', 'auth')]: [
 *     (ctx, next) => {
 *       ctx.set('user', ...) // Type-safe!
 *     }
 *   ]
 * })
 * ```
 */
declare global {
  namespace RSCRouter {
    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface Env {
      // Empty by default - users augment with their RouterEnv
    }

    // eslint-disable-next-line @typescript-eslint/no-empty-interface
    interface RegisteredRoutes {
      // Empty by default - users augment with their merged route maps for type-safe href()
    }
  }
}

/**
 * Get registered routes or fallback to generic Record<string, string>
 * When RSCRouter.RegisteredRoutes is augmented, provides autocomplete for route names
 * When not augmented, allows any string (no autocomplete)
 */
export type GetRegisteredRoutes = keyof RSCRouter.RegisteredRoutes extends never
  ? Record<string, string>
  : RSCRouter.RegisteredRoutes;

/**
 * Default environment type - uses global augmentation if available, any otherwise
 */
export type DefaultEnv = keyof RSCRouter.Env extends never ? any : RSCRouter.Env;

/**
 * Router environment (Hono-inspired type-safe context)
 *
 * @template TBindings - Platform bindings (DB, KV, secrets, etc.)
 * @template TVariables - Middleware-injected variables (user, permissions, etc.)
 *
 * @example
 * ```typescript
 * interface AppBindings {
 *   DB: D1Database;
 *   KV: KVNamespace;
 *   STRIPE_KEY: string;
 * }
 *
 * interface AppVariables {
 *   user?: { id: string; name: string };
 *   permissions?: string[];
 * }
 *
 * type AppEnv = RouterEnv<AppBindings, AppVariables>;
 * const router = createRSCRouter<AppEnv>();
 * ```
 */
export interface RouterEnv<TBindings = {}, TVariables = {}> {
  Bindings: TBindings;
  Variables: TVariables;
}

/**
 * Extract param names from a route pattern
 * Example: "/blog/:slug/:id" => { slug: string, id: string }
 */
/**
 * Extract route params from a pattern with depth limit to prevent infinite recursion
 * Examples:
 * - "/products/:id" → { id: string }
 * - "/products/:category/:id" → { category: string; id: string }
 * - "/:slug/reviews/:reviewId" → { slug: string; reviewId: string }
 */
export type ExtractParams<
  T extends string,
  Depth extends readonly unknown[] = []
> = Depth['length'] extends 10
  ? { [key: string]: string } // Fallback to generic params if too deep
  : T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof ExtractParams<`/${Rest}`, readonly [...Depth, unknown]>]: string }
    : T extends `${infer _Start}:${infer Param}`
      ? { [K in Param]: string }
      : {};

/**
 * Route definition - maps route names to patterns
 */
export type RouteDefinition = {
  [key: string]: string | RouteDefinition;
};

/**
 * Recursively flatten nested routes with depth limit to prevent infinite recursion
 * Transforms: { products: { detail: "/product/:slug" } } => { "products.detail": "/product/:slug" }
 */
type FlattenRoutes<
  T extends RouteDefinition,
  Prefix extends string = "",
  Depth extends readonly unknown[] = []
> = Depth['length'] extends 5
  ? never
  : {
      [K in keyof T]: T[K] extends string
        ? Record<`${Prefix}${K & string}`, T[K]>
        : T[K] extends RouteDefinition
          ? FlattenRoutes<T[K], `${Prefix}${K & string}.`, readonly [...Depth, unknown]>
          : never;
    }[keyof T];

/**
 * Union to intersection helper
 */
type UnionToIntersection<U> = (
  U extends unknown ? (k: U) => void : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Resolved route map - flattened route definitions with full paths
 */
export type ResolvedRouteMap<T extends RouteDefinition> = UnionToIntersection<FlattenRoutes<T>>;

/**
 * Handler function that receives context and returns React content
 */
export type Handler<TParams = {}, TEnv = any> = (
  ctx: HandlerContext<TParams, TEnv>
) => ReactNode | Promise<ReactNode>;

/**
 * Context passed to handlers (Hono-inspired type-safe context)
 *
 * Provides type-safe access to:
 * - Route params (from URL pattern)
 * - Request data (request, searchParams, pathname, url)
 * - Platform bindings (env.DB, env.KV, env.SECRETS)
 * - Middleware variables (var.user, var.permissions)
 * - Getter/setter for variables (get('user'), set('user', ...))
 *
 * **Important:** System parameters (query params starting with `_rsc`) are filtered out.
 * Handlers see only user-facing query params. Access raw request via `_originalRequest`.
 *
 * @example
 * ```typescript
 * const handler = (ctx: HandlerContext<{ slug: string }, AppEnv>) => {
 *   ctx.params.slug        // Route param (string)
 *   ctx.env.DB             // Binding (D1Database)
 *   ctx.var.user           // Variable (User | undefined)
 *   ctx.get('user')        // Alternative getter
 *   ctx.set('user', {...}) // Setter
 *
 *   // Clean URLs (system params filtered):
 *   ctx.url                // No _rsc* params
 *   ctx.searchParams       // No _rsc* params
 *
 *   // Advanced: access raw request
 *   ctx._originalRequest   // Full request with all params
 * }
 * ```
 */
export type HandlerContext<TParams = {}, TEnv = any> = {
  params: TParams;
  request: Request;
  searchParams: URLSearchParams;  // Filtered (no _rsc* params)
  pathname: string;
  url: URL;                       // Filtered (no _rsc* params)
  env: TEnv extends RouterEnv<infer B, any> ? B : {};
  var: TEnv extends RouterEnv<any, infer V> ? V : {};
  get: TEnv extends RouterEnv<any, infer V>
    ? <K extends keyof V>(key: K) => V[K]
    : (key: string) => any;
  set: TEnv extends RouterEnv<any, infer V>
    ? <K extends keyof V>(key: K, value: V[K]) => void
    : (key: string, value: any) => void;
  _originalRequest: Request;      // Raw request (includes all system params)
  /**
   * Access loader data (loaders must be defined in scope)
   *
   * Loaders are executed in parallel and memoized per request.
   * Multiple calls to use() with the same loader return the same promise.
   *
   * @example
   * ```typescript
   * route("cart", async (ctx) => {
   *   const cart = await ctx.use(CartLoader);
   *   return <CartPage cart={cart} />;
   * });
   * ```
   */
  use: <T, TLoaderParams = any>(loader: LoaderDefinition<T, TLoaderParams>) => Promise<T>;
};

/**
 * Generic params type - flexible object with string keys
 * Users can narrow this by explicitly typing their params:
 *
 * @example
 * ```typescript
 * [revalidate('post')]: (({ currentParams, nextParams }: RevalidateParams<{ slug: string }>) => {
 *   currentParams.slug // typed as string
 *   return currentParams.slug !== nextParams.slug;
 * })
 * ```
 */
export type GenericParams = { [key: string]: string | undefined };

/**
 * Helper type for revalidation handler params
 * Allows inline type annotation for stricter param typing
 *
 * @example
 * ```typescript
 * [revalidate('post')]: (params: RevalidateParams<{ slug: string }>) => {
 *   params.currentParams.slug // typed as string
 *   return params.defaultShouldRevalidate;
 * }
 * ```
 */
export type RevalidateParams<TParams = GenericParams, TEnv = any> = Parameters<ShouldRevalidateFn<TParams, TEnv>>[0];

/**
 * Should revalidate function signature (inspired by React Router)
 *
 * Determines whether a route segment should re-render during partial navigation.
 * Multiple revalidation functions can be defined per route - they execute in order.
 *
 * **Return Types:**
 * - `boolean` - Hard decision: immediately returns this value (short-circuits)
 * - `{ defaultShouldRevalidate: boolean }` - Soft decision: updates suggestion for next revalidator
 *
 * **Execution Flow:**
 * 1. Start with built-in `defaultShouldRevalidate` (true if params changed)
 * 2. Execute global revalidators first, then route-specific
 * 3. Hard decision (boolean): stop immediately and use that value
 * 4. Soft decision (object): update suggestion and continue to next revalidator
 * 5. If all return soft decisions: use the final suggestion
 *
 * @param args.currentParams - Previous route params (generic by default, can be narrowed)
 * @param args.currentUrl - Previous URL
 * @param args.nextParams - Next route params (generic by default, can be narrowed)
 * @param args.nextUrl - Next URL
 * @param args.defaultShouldRevalidate - Current suggestion (updated by soft decisions)
 * @param args.context - App context (db, user, etc.)
 * @param args.actionResult - Result from action (future support)
 * @param args.formData - Form data from action (future support)
 * @param args.formMethod - HTTP method from action (future support)
 *
 * @returns Hard decision (boolean) or soft suggestion (object)
 *
 * @example
 * ```typescript
 * // Hard decision - definitive answer
 * [revalidate('post')]: ({ currentParams, nextParams }) => {
 *   return currentParams.slug !== nextParams.slug; // boolean - short-circuits
 * }
 *
 * // Soft decision - allows downstream revalidators to override
 * [revalidate('*', 'global')]: ({ defaultShouldRevalidate }) => {
 *   return { defaultShouldRevalidate: true }; // object - continues to next
 * }
 *
 * // Explicit typing for stricter params
 * [revalidate('post')]: ((params: RevalidateParams<{ slug: string }>) => {
 *   return params.currentParams.slug !== params.nextParams.slug;
 * })
 * ```
 */
export type ShouldRevalidateFn<TParams = GenericParams, TEnv = any> = (args: {
  currentParams: TParams;
  currentUrl: URL;
  nextParams: TParams;
  nextUrl: URL;
  defaultShouldRevalidate: boolean;
  context: HandlerContext<TParams, TEnv>;
  // Segment metadata (which segment is being evaluated):
  segmentType: 'layout' | 'route' | 'parallel';
  layoutName?: string;      // Layout name (e.g., "root", "shop", "auth") - only for layouts
  slotName?: string;        // Slot name (e.g., "@sidebar", "@modal") - only for parallels
  // Action context (populated when revalidation triggered by server action):
  actionId?: string;        // Action identifier (e.g., "actions/shop.actions!addToCart")
  actionUrl?: URL;          // URL where action was executed
  actionResult?: any;       // Return value from action execution
  formData?: FormData;      // FormData from action request
  method?: string;          // Request method: 'GET' for navigation, 'POST' for actions
  routeName?: string;       // Route name where action was executed (e.g., "products.detail")
}) => boolean | { defaultShouldRevalidate: boolean };

/**
 * Middleware function signature
 *
 * Middleware can either call `next()` to continue the pipeline,
 * or return a Response to short-circuit and skip remaining middleware + handler.
 *
 * **Short-Circuit Patterns:**
 * - `return redirect('/login')` - Soft redirect (SPA navigation)
 * - `return Response.redirect('/login', 302)` - Hard redirect (full page reload)
 * - `return new Response('Unauthorized', { status: 401 })` - Error response
 *
 * @param TParams - Route params (defaults to GenericParams, can be narrowed with satisfies)
 * @param TEnv - Environment type
 *
 * @example
 * ```typescript
 * [middleware('checkout.*', 'auth')]: [
 *   (ctx, next) => {
 *     if (!ctx.get('user')) {
 *       return redirect('/login'); // Soft redirect - short-circuit
 *     }
 *     next(); // Continue pipeline
 *   }
 * ]
 * ```
 */
export type MiddlewareFn<TParams = GenericParams, TEnv = any> = (
  ctx: HandlerContext<TParams, TEnv>,
  next: () => void | Promise<void>
) => void | Promise<void> | Response | Promise<Response>;

/**
 * Extract all route keys from a route definition (includes flattened nested routes)
 */
export type RouteKeys<T extends RouteDefinition> = keyof ResolvedRouteMap<T> & string;

/**
 * Valid layout value - component or handler function
 * Note: Arrays are not supported. Use separate layout() declarations with unique names instead.
 */
type LayoutValue<TEnv = any> =
  | ReactNode
  | Handler<any, TEnv>;

/**
 * Helper to extract params from a route key using the resolved (flattened) route map
 */
export type ExtractRouteParams<T extends RouteDefinition, K extends string> =
  K extends keyof ResolvedRouteMap<T>
    ? ResolvedRouteMap<T>[K] extends string
      ? ExtractParams<ResolvedRouteMap<T>[K]>
      : GenericParams
    : GenericParams;

/**
 * Handlers object that maps route names to handler functions with type-safe string patterns
 */
export type HandlersForRouteMap<T extends RouteDefinition, TEnv = any> = {
  // Route handlers - type-safe params extracted from route patterns
  [K in RouteKeys<T>]?: Handler<ExtractRouteParams<T, K & string>, TEnv>;
} & {
  // Layout patterns: $layout.{routeName}.{layoutName}
  [K in `$layout.${RouteKeys<T> | '*'}.${string}`]?: LayoutValue<TEnv>;
} & {
  // Parallel route patterns: $parallel.{routeName}.{parallelName}
  [K in `$parallel.${RouteKeys<T>}.${string}`]?: Record<
    `@${string}`,
    Handler<
      K extends `$parallel.${infer RouteKey}.${string}`
        ? RouteKey extends RouteKeys<T>
          ? ExtractRouteParams<T, RouteKey & string>
          : GenericParams
        : GenericParams,
      TEnv
    >
  >;
} & {
  // Global parallel routes (with '*') use GenericParams
  [K in `$parallel.${"*"}.${string}`]?: Record<`@${string}`, Handler<GenericParams, TEnv>>;
} & {
  // Middleware patterns: $middleware.{routeName}.{middlewareName}
  [K in `$middleware.${RouteKeys<T> | '*'}.${string}`]?: MiddlewareFn<GenericParams, TEnv>[];
} & {
  // Route revalidate patterns: $revalidate.route.{routeName}.{revalidateName}
  [K in `$revalidate.route.${RouteKeys<T> | '*'}.${string}`]?: ShouldRevalidateFn<GenericParams, TEnv>;
} & {
  // Layout revalidate patterns: $revalidate.layout.{routeName}.{layoutName}.{revalidateName}
  [K in `$revalidate.layout.${RouteKeys<T> | '*'}.${string}.${string}`]?: ShouldRevalidateFn<GenericParams, TEnv>;
} & {
  // Parallel revalidate patterns: $revalidate.parallel.{routeName}.{parallelName}.{slotName}.{revalidateName}
  [K in `$revalidate.parallel.${RouteKeys<T> | '*'}.${string}.${string}.${string}`]?: ShouldRevalidateFn<GenericParams, TEnv>;
};

/**
 * Resolved segment with component
 *
 * Segment types:
 * - layout: Wraps child content via <Outlet />
 * - route: The leaf content for a URL
 * - parallel: Named slots rendered via <ParallelOutlet name="@slot" />
 * - loader: Data segment (no visual rendering, carries loaderData)
 */
export interface ResolvedSegment {
  id: string;
  namespace: string; // Optional namespace for segment (used for parallel groups)
  type: "layout" | "route" | "parallel" | "loader";
  index: number;
  component: ReactNode;
  loading?: ReactNode; // Loading component for this segment (shown during navigation)
  params?: Record<string, string>;
  slot?: string; // For parallel segments: '@sidebar', '@modal', etc.
  belongsToRoute?: boolean; // True if segment belongs to the matched route (route itself + its children)
  layoutName?: string; // For layouts: the layout name identifier
  parallelName?: string; // For parallels: the parallel group name (used to match with revalidations)
  // Loader-specific fields
  loaderName?: string; // For loaders: the loader name identifier
  loaderData?: any; // For loaders: the resolved data from loader execution
}

/**
 * Segment metadata (without component)
 */
export interface SegmentMetadata {
  id: string;
  type: "layout" | "route" | "parallel" | "loader";
  index: number;
  params?: Record<string, string>;
  slot?: string;
  loaderName?: string;
}

// Note: route symbols are now defined in route-definition.ts
// as properties on the route() function

/**
 * Router match result
 */
export interface MatchResult {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  /**
   * Server-Timing header value (only present when debugPerformance is enabled)
   * Can be added to response headers for DevTools integration
   */
  serverTiming?: string;
}

/**
 * Internal route entry stored in router
 */
export interface RouteEntry<TEnv = any> {
  prefix: string;
  routes: ResolvedRouteMap<any>;
  handler: () =>
      | Array<AllUseItems>
      | Promise<{ default: () => Array<AllUseItems> }>
      | Promise<() => Array<AllUseItems>>;
  mountIndex: number;
}

/**
 * Type-safe route handler helper for specific routes
 *
 * Automatically extracts the correct param types from your route definition.
 *
 * @template TRoutes - Your route definition object (e.g., typeof shopRoutes)
 * @template K - The route key (e.g., "cart", "products.detail")
 * @template TEnv - Environment type (defaults to global RSCRouter.Env)
 *
 * @example
 * ```typescript
 * import { RouteHandler } from "rsc-router";
 * import { shopRoutes } from "./routes.js";
 *
 * export const cartRoute: RouteHandler<typeof shopRoutes, "cart"> = (ctx) => {
 *   // ctx.params is typed correctly for the cart route
 *   // ctx.get('user') is type-safe via global augmentation
 *   return <CartPage />;
 * }
 *
 * export const productRoute: RouteHandler<typeof shopRoutes, "products.detail"> = (ctx) => {
 *   // ctx.params.slug is automatically typed as string
 *   return <ProductDetail slug={ctx.params.slug} />;
 * }
 * ```
 */
export type RouteHandler<
  TRoutes extends RouteDefinition,
  K extends keyof TRoutes,
  TEnv = DefaultEnv
> = Handler<ExtractRouteParams<TRoutes, K & string>, TEnv>;

/**
 * Type-safe revalidation function helper for specific routes
 *
 * Automatically extracts the correct param types from your route definition.
 *
 * @template TRoutes - Your route definition object (e.g., typeof shopRoutes)
 * @template K - The route key (e.g., "cart", "products.detail")
 * @template TEnv - Environment type (defaults to global RSCRouter.Env)
 *
 * @example
 * ```typescript
 * import { RouteRevalidateFn } from "rsc-router";
 * import { shopRoutes } from "./routes.js";
 *
 * export const cartRevalidation: RouteRevalidateFn<typeof shopRoutes, "cart"> = ({
 *   currentParams,
 *   nextParams
 * }) => {
 *   // params are typed correctly for the cart route
 *   return true; // Always revalidate cart
 * }
 *
 * export const productRevalidation: RouteRevalidateFn<typeof shopRoutes, "products.detail"> = ({
 *   currentParams,
 *   nextParams
 * }) => {
 *   // currentParams.slug and nextParams.slug are automatically typed
 *   return currentParams.slug !== nextParams.slug;
 * }
 * ```
 */
export type RouteRevalidateFn<
  TRoutes extends RouteDefinition,
  K extends keyof TRoutes,
  TEnv = DefaultEnv
> = ShouldRevalidateFn<ExtractRouteParams<TRoutes, K & string>, TEnv>;

/**
 * Type-safe middleware function helper for specific routes
 *
 * Automatically extracts the correct param types from your route definition.
 *
 * @template TRoutes - Your route definition object (e.g., typeof shopRoutes)
 * @template K - The route key (e.g., "checkout.index", "account.orders")
 * @template TEnv - Environment type (defaults to global RSCRouter.Env)
 *
 * @example
 * ```typescript
 * import { RouteMiddlewareFn } from "rsc-router";
 * import { shopRoutes } from "./routes.js";
 *
 * export const checkoutMiddleware: RouteMiddlewareFn<typeof shopRoutes, "checkout.index"> = (ctx, next) => {
 *   // ctx.params is typed correctly for checkout.index route
 *   // ctx.get('user') is type-safe via global augmentation
 *   if (!ctx.get('user')) {
 *     return redirect('/login');
 *   }
 *   next();
 * }
 *
 * export const productMiddleware: RouteMiddlewareFn<typeof shopRoutes, "products.detail"> = (ctx, next) => {
 *   // ctx.params.slug is automatically typed as string
 *   console.log('Viewing product:', ctx.params.slug);
 *   next();
 * }
 * ```
 */
export type RouteMiddlewareFn<
  TRoutes extends RouteDefinition,
  K extends keyof TRoutes,
  TEnv = DefaultEnv
> = MiddlewareFn<ExtractRouteParams<TRoutes, K & string>, TEnv>;

// ============================================================================
// Loader Types
// ============================================================================

/**
 * Context passed to loader functions during execution
 *
 * Loaders run after middleware but before handlers, so they have access
 * to middleware-set variables via get().
 *
 * @template TParams - Route params type (e.g., { slug: string })
 * @template TEnv - Environment type for bindings/variables
 *
 * @example
 * ```typescript
 * const CartLoader = createLoader("cart", async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");  // From auth middleware
 *   return await db.cart.get(user.id);
 * });
 *
 * // With typed params:
 * const ProductLoader = createLoader<Product, { slug: string }>("product", async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // slug is typed as string
 *   return await db.products.findBySlug(slug);
 * });
 * ```
 */
export type LoaderContext<TParams = Record<string, string | undefined>, TEnv = any> = {
  params: TParams;
  request: Request;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  env: TEnv extends RouterEnv<infer B, any> ? B : {};
  var: TEnv extends RouterEnv<any, infer V> ? V : {};
  get: TEnv extends RouterEnv<any, infer V>
    ? <K extends keyof V>(key: K) => V[K]
    : (key: string) => any;
  /**
   * Access another loader's data (returns promise since loaders run in parallel)
   */
  use: <T, TLoaderParams = any>(loader: LoaderDefinition<T, TLoaderParams>) => Promise<T>;
};

/**
 * Loader function signature
 *
 * @template T - The return type of the loader
 * @template TParams - Route params type (defaults to generic Record)
 * @template TEnv - Environment type for bindings/variables
 *
 * @example
 * ```typescript
 * const myLoader: LoaderFn<{ items: Item[] }> = async (ctx) => {
 *   "use server";
 *   return { items: await db.items.list() };
 * };
 *
 * // With typed params:
 * const productLoader: LoaderFn<Product, { slug: string }> = async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // typed as string
 *   return await db.products.findBySlug(slug);
 * };
 * ```
 */
export type LoaderFn<T, TParams = Record<string, string | undefined>, TEnv = any> = (
  ctx: LoaderContext<TParams, TEnv>
) => Promise<T> | T;

/**
 * Loader definition object
 *
 * Created via createLoader(). Contains the loader name and function.
 * On client builds, the fn is stripped by the bundler (via "use server" directive).
 *
 * @template T - The return type of the loader
 * @template TParams - Route params type (for type-safe params access)
 *
 * @example
 * ```typescript
 * // Definition (same file works on server and client)
 * export const CartLoader = createLoader("cart", async (ctx) => {
 *   "use server";
 *   return await db.cart.get(ctx.get("user").id);
 * });
 *
 * // With typed params:
 * export const ProductLoader = createLoader<Product, { slug: string }>("product", async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // slug is typed as string
 *   return await db.products.findBySlug(slug);
 * });
 *
 * // Server usage
 * const cart = ctx.use(CartLoader);
 *
 * // Client usage (fn is stripped, only name remains)
 * const cart = useLoader(CartLoader);
 * ```
 */
export type LoaderDefinition<T = any, TParams = Record<string, string | undefined>> = {
  __brand: "loader";
  name: string;
  fn?: LoaderFn<T, TParams, any>;  // Optional - stripped on client via "use server"
};
