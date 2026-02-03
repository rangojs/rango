import type { ReactNode } from "react";
import type { AllUseItems } from "./route-types.js";
import type { Handle } from "./handle.js";
import type { MiddlewareFn } from "./router/middleware.js";
import type { Theme } from "./theme/types.js";
import type { ScopedHrefFunction } from "./href.js";

// Re-export MiddlewareFn for internal/advanced use
export type { MiddlewareFn } from "./router/middleware.js";

/**
 * Props for the Document component that wraps the entire application.
 */
export type DocumentProps = {
  children: ReactNode;
};

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
 * Parse constraint values into a union type
 * "a|b|c" → "a" | "b" | "c"
 */
type ParseConstraint<T extends string> =
  T extends `${infer First}|${infer Rest}`
    ? First | ParseConstraint<Rest>
    : T;

/**
 * Extract param info from a param segment
 *
 * Handles:
 * - :param → { name: "param", optional: false, type: string }
 * - :param? → { name: "param", optional: true, type: string }
 * - :param(a|b) → { name: "param", optional: false, type: "a" | "b" }
 * - :param(a|b)? → { name: "param", optional: true, type: "a" | "b" }
 */
type ExtractParamInfo<T extends string> =
  // Optional + constrained: :param(a|b)?
  T extends `${infer Name}(${infer Constraint})?`
    ? { name: Name; optional: true; type: ParseConstraint<Constraint> }
  // Constrained only: :param(a|b)
  : T extends `${infer Name}(${infer Constraint})`
    ? { name: Name; optional: false; type: ParseConstraint<Constraint> }
  // Optional only: :param?
  : T extends `${infer Name}?`
    ? { name: Name; optional: true; type: string }
  // Required: :param
  : { name: T; optional: false; type: string };

/**
 * Build param object from info
 */
type ParamFromInfo<Info> =
  Info extends { name: infer N extends string; optional: true; type: infer V }
    ? { [K in N]?: V }
    : Info extends { name: infer N extends string; optional: false; type: infer V }
      ? { [K in N]: V }
      : never;

/**
 * Merge two param objects preserving optionality
 * Uses Pick to preserve the modifiers from source types
 */
type MergeParams<A, B> = Pick<A, keyof A> & Pick<B, keyof B> extends infer O
  ? { [K in keyof O]: O[K] }
  : never;

/**
 * Extract route params from a pattern with depth limit to prevent infinite recursion
 *
 * Supports:
 * - Required params: /:slug → { slug: string }
 * - Optional params: /:locale? → { locale?: string }
 * - Constrained params: /:locale(en|gb) → { locale: "en" | "gb" }
 * - Optional + constrained: /:locale(en|gb)? → { locale?: "en" | "gb" }
 *
 * @example
 * ExtractParams<"/products/:id"> // { id: string }
 * ExtractParams<"/:locale?/blog/:slug"> // { locale?: string; slug: string }
 * ExtractParams<"/:locale(en|gb)/blog"> // { locale: "en" | "gb" }
 * ExtractParams<"/:locale(en|gb)?/blog/:slug"> // { locale?: "en" | "gb"; slug: string }
 */
export type ExtractParams<
  T extends string,
  Depth extends readonly unknown[] = []
> = Depth['length'] extends 10
  ? { [key: string]: string | undefined } // Fallback to generic params if too deep
  // Match param with remaining path: :param.../rest
  : T extends `${infer _Start}:${infer Param}/${infer Rest}`
    ? MergeParams<
        ParamFromInfo<ExtractParamInfo<Param>>,
        ExtractParams<`/${Rest}`, readonly [...Depth, unknown]>
      >
  // Match param at end: :param...
  : T extends `${infer _Start}:${infer Param}`
    ? ParamFromInfo<ExtractParamInfo<Param>>
  : {};

/**
 * Route definition - maps route names to patterns
 */
/**
 * Trailing slash handling mode
 * - "never": Redirect URLs with trailing slash to without
 * - "always": Redirect URLs without trailing slash to with
 * - "ignore": Match both with and without trailing slash
 */
export type TrailingSlashMode = "never" | "always" | "ignore";

/**
 * Route configuration object (alternative to string path)
 */
export type RouteConfig = {
  path: string;
  trailingSlash?: TrailingSlashMode;
};

/**
 * Route definition options (global defaults)
 */
export type RouteDefinitionOptions = {
  trailingSlash?: TrailingSlashMode;
};

export type RouteDefinition = {
  [key: string]: string | RouteConfig | RouteDefinition;
};

/**
 * Recursively flatten nested routes with depth limit to prevent infinite recursion
 * Transforms: { products: { detail: "/product/:slug" } } => { "products.detail": "/product/:slug" }
 * Also handles RouteConfig objects: { api: { path: "/api" } } => { "api": "/api" }
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
        : T[K] extends RouteConfig
          ? Record<`${Prefix}${K & string}`, T[K]['path']>
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
 * Handler function that receives context and returns React content or a Response
 *
 * @template T - Params object OR path pattern string
 * @template TEnv - Environment type
 *
 * @example
 * ```typescript
 * // With explicit params object
 * const handler: Handler<{ id: string }> = (ctx) => {
 *   ctx.params.id // string
 * }
 *
 * // With path pattern - params extracted automatically
 * const handler: Handler<"/product/:id"> = (ctx) => {
 *   ctx.params.id // string
 * }
 * ```
 */
export type Handler<T = {}, TEnv = DefaultEnv> = (
  ctx: HandlerContext<T extends string ? ExtractParams<T> : T, TEnv>
) => ReactNode | Promise<ReactNode> | Response | Promise<Response>;

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
   * Stub response for setting headers/cookies.
   * Headers set here are merged into the final response.
   *
   * @example
   * ```typescript
   * route("product", (ctx) => {
   *   ctx.res.headers.set("Cache-Control", "s-maxage=60");
   *   return <ProductPage />;
   * });
   * ```
   */
  res: Response;
  /**
   * Shorthand for ctx.res.headers - response headers.
   * Headers set here are merged into the final response.
   *
   * @example
   * ```typescript
   * route("product", (ctx) => {
   *   ctx.headers.set("Cache-Control", "s-maxage=60");
   *   return <ProductPage />;
   * });
   * ```
   */
  headers: Headers;
  /**
   * Access loader data or push handle data.
   *
   * For loaders: Returns a promise that resolves to the loader data.
   * Loaders are executed in parallel and memoized per request.
   *
   * For handles: Returns a push function to add data for this segment.
   * Handle data accumulates across all matched route segments.
   * Push accepts: direct value, Promise, or async callback (executed immediately).
   *
   * @example
   * ```typescript
   * // Loader usage
   * route("cart", async (ctx) => {
   *   const cart = await ctx.use(CartLoader);
   *   return <CartPage cart={cart} />;
   * });
   *
   * // Handle usage - direct value
   * route("shop", (ctx) => {
   *   const push = ctx.use(Breadcrumbs);
   *   push({ label: "Shop", href: "/shop" });
   *   return <ShopPage />;
   * });
   *
   * // Handle usage - Promise
   * route("product", (ctx) => {
   *   const push = ctx.use(Breadcrumbs);
   *   push(fetchProductBreadcrumb(ctx.params.id));
   *   return <ProductPage />;
   * });
   *
   * // Handle usage - async callback (executed immediately)
   * route("product", (ctx) => {
   *   const push = ctx.use(Breadcrumbs);
   *   push(async () => {
   *     const product = await db.getProduct(ctx.params.id);
   *     return { label: product.name, href: `/product/${product.id}` };
   *   });
   *   return <ProductPage />;
   * });
   * ```
   */
  use: {
    <T, TLoaderParams = any>(loader: LoaderDefinition<T, TLoaderParams>): Promise<T>;
    <TData, TAccumulated = TData[]>(handle: Handle<TData, TAccumulated>): (
      data: TData | Promise<TData> | (() => Promise<TData>)
    ) => void;
  };
  /**
   * Internal: Current segment ID for handle data attribution.
   * Set by the router before calling each handler.
   * @internal
   */
  _currentSegmentId?: string;
  /**
   * Current theme (from cookie or default).
   * Only available when theme is enabled in router config.
   *
   * @example
   * ```typescript
   * route("settings", (ctx) => {
   *   const currentTheme = ctx.theme; // "light" | "dark" | "system" | undefined
   *   return <SettingsPage theme={currentTheme} />;
   * });
   * ```
   */
  theme?: Theme;
  /**
   * Set the theme (only available when theme is enabled in router config).
   * Sets a cookie with the new theme value.
   *
   * @example
   * ```typescript
   * route("settings", async (ctx) => {
   *   if (ctx.request.method === "POST") {
   *     const formData = await ctx.request.formData();
   *     const newTheme = formData.get("theme") as Theme;
   *     ctx.setTheme?.(newTheme);
   *   }
   *   return <SettingsPage />;
   * });
   * ```
   */
  setTheme?: (theme: Theme) => void;
  /**
   * Generate URLs from route names with scoped resolution.
   *
   * Type-safe when RSCRouter.RegisteredRoutes is augmented (recommended).
   * Falls back to accepting any string when not augmented.
   *
   * Resolution priority:
   * 1. Path-based (`/about`) → Use directly
   * 2. Absolute name (`shop.cart`) → Global lookup (contains dot)
   * 3. Local name (`index`) → Prepend current name prefix, then lookup
   *
   * @example
   * ```typescript
   * // In a handler within blogPatterns (mounted at /blog with name "blog"):
   * route("post", (ctx) => {
   *   const homeUrl = ctx.href("index");           // → "/blog/"
   *   const postUrl = ctx.href("post", { slug: "hello" }); // → "/blog/hello"
   *   const cartUrl = ctx.href("shop.cart");       // → "/shop/cart"
   *   const aboutUrl = ctx.href("/about");         // → "/about"
   *   return <PostPage />;
   * });
   * ```
   */
  href: ScopedHrefFunction<GetRegisteredRoutes>;
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
  actionId?: string;        // Action identifier (e.g., "src/actions.ts#addToCart")
  actionUrl?: URL;          // URL where action was executed
  actionResult?: any;       // Return value from action execution
  formData?: FormData;      // FormData from action request
  method?: string;          // Request method: 'GET' for navigation, 'POST' for actions
  routeName?: string;       // Route name where action was executed (e.g., "products.detail")
  // Stale cache revalidation (SWR pattern):
  stale?: boolean;          // True if this is a stale cache revalidation request
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
// MiddlewareFn is imported from "./router/middleware.js" and re-exported

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
  [K in `$middleware.${RouteKeys<T> | '*'}.${string}`]?: MiddlewareFn<TEnv, GenericParams>[];
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
 * Error information passed to error boundary fallback components
 */
export interface ErrorInfo {
  /** Error message (always available) */
  message: string;
  /** Error name/type (e.g., "RouteNotFoundError", "MiddlewareError") */
  name: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Stack trace (only in development) */
  stack?: string;
  /** Original error cause if available */
  cause?: unknown;
  /** Segment ID where the error occurred */
  segmentId: string;
  /** Segment type where the error occurred */
  segmentType: "layout" | "route" | "parallel" | "loader" | "middleware" | "cache";
}

/**
 * Props passed to server-side error boundary fallback components
 *
 * Server error boundaries don't have a reset function since the error
 * occurred during server rendering. Users can navigate away or refresh.
 *
 * @example
 * ```typescript
 * function ProductErrorFallback({ error }: ErrorBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Something went wrong loading the product</h2>
 *       <p>{error.message}</p>
 *       <a href="/">Go home</a>
 *     </div>
 *   );
 * }
 * ```
 */
export interface ErrorBoundaryFallbackProps {
  /** Error information */
  error: ErrorInfo;
}

/**
 * Error boundary handler - receives error info and returns fallback UI
 */
export type ErrorBoundaryHandler = (props: ErrorBoundaryFallbackProps) => ReactNode;

/**
 * Props passed to client-side error boundary fallback components
 *
 * Client error boundaries have a reset function that clears the error state
 * and re-renders the children.
 *
 * @example
 * ```typescript
 * function ClientErrorFallback({ error, reset }: ClientErrorBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Something went wrong</h2>
 *       <p>{error.message}</p>
 *       <button onClick={reset}>Try again</button>
 *     </div>
 *   );
 * }
 * ```
 */
export interface ClientErrorBoundaryFallbackProps {
  /** Error information */
  error: ErrorInfo;
  /** Function to reset error state and retry rendering */
  reset: () => void;
}

/**
 * Wrapped loader data result for deferred resolution with error handling.
 * When loaders are deferred to client-side resolution, errors need to be
 * wrapped so the client can handle them appropriately.
 */
export type LoaderDataResult<T = unknown> =
  | { __loaderResult: true; ok: true; data: T }
  | { __loaderResult: true; ok: false; error: ErrorInfo; fallback: ReactNode | null };

/**
 * Type guard to check if a value is a wrapped loader result
 */
export function isLoaderDataResult(value: unknown): value is LoaderDataResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "__loaderResult" in value &&
    (value as any).__loaderResult === true
  );
}

/**
 * Not found information passed to notFound boundary fallback components
 */
export interface NotFoundInfo {
  /** Not found message */
  message: string;
  /** Segment ID where notFound was thrown */
  segmentId: string;
  /** Segment type where notFound was thrown */
  segmentType: "layout" | "route" | "parallel" | "loader" | "middleware" | "cache";
  /** The pathname that triggered the not found */
  pathname?: string;
}

/**
 * Props passed to notFound boundary fallback components
 *
 * @example
 * ```typescript
 * function ProductNotFound({ notFound }: NotFoundBoundaryFallbackProps) {
 *   return (
 *     <div>
 *       <h2>Product Not Found</h2>
 *       <p>{notFound.message}</p>
 *       <a href="/products">Browse all products</a>
 *     </div>
 *   );
 * }
 * ```
 */
export interface NotFoundBoundaryFallbackProps {
  /** Not found information */
  notFound: NotFoundInfo;
}

/**
 * NotFound boundary handler - receives not found info and returns fallback UI
 */
export type NotFoundBoundaryHandler = (props: NotFoundBoundaryFallbackProps) => ReactNode;

/**
 * Resolved segment with component
 *
 * Segment types:
 * - layout: Wraps child content via <Outlet />
 * - route: The leaf content for a URL
 * - parallel: Named slots rendered via <ParallelOutlet name="@slot" />
 * - loader: Data segment (no visual rendering, carries loaderData)
 * - error: Error fallback segment (replaces failed segment with error UI)
 * - notFound: Not found fallback segment (replaces segment when data not found)
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface ResolvedSegment {
  id: string;
  namespace: string; // Optional namespace for segment (used for parallel groups)
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  component: ReactNode | Promise<ReactNode>; // Component or handler promise
  loading?: ReactNode; // Loading component for this segment (shown during navigation)
  layout?: ReactNode; // Layout element to wrap content (used by intercept segments)
  params?: Record<string, string>;
  slot?: string; // For parallel segments: '@sidebar', '@modal', etc.
  belongsToRoute?: boolean; // True if segment belongs to the matched route (route itself + its children)
  layoutName?: string; // For layouts: the layout name identifier
  parallelName?: string; // For parallels: the parallel group name (used to match with revalidations)
  // Loader-specific fields
  loaderId?: string; // For loaders: the loader $$id identifier
  loaderData?: any; // For loaders: the resolved data from loader execution
  // Intercept loader fields (for streaming loader data in parallel segments)
  loaderDataPromise?: Promise<any[]> | any[]; // Loader data promise or resolved array
  loaderIds?: string[]; // IDs ($$id) of loaders for this segment
  // Error-specific fields
  error?: ErrorInfo; // For error segments: the error information
  // NotFound-specific fields
  notFoundInfo?: NotFoundInfo; // For notFound segments: the not found information
}

/**
 * Segment metadata (without component)
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SegmentMetadata {
  id: string;
  type: "layout" | "route" | "parallel" | "loader" | "error" | "notFound";
  index: number;
  params?: Record<string, string>;
  slot?: string;
  loaderId?: string;
  error?: ErrorInfo;
  notFoundInfo?: NotFoundInfo;
}

// Note: route symbols are now defined in route-definition.ts
// as properties on the route() function

/**
 * State of a named slot (e.g., @modal, @sidebar)
 * Used for intercepting routes where slots render alternative content
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SlotState {
  /**
   * Whether the slot is currently active (has content to render)
   */
  active: boolean;
  /**
   * Segments for this slot when active
   */
  segments?: ResolvedSegment[];
}

/**
 * Props passed to the root layout component
 */
export interface RootLayoutProps {
  children: ReactNode;
}

/**
 * Router match result
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface MatchResult {
  segments: ResolvedSegment[];
  matched: string[];
  diff: string[];
  /**
   * Merged route params from all matched segments
   * Available for use by the handler after route matching
   */
  params: Record<string, string>;
  /**
   * The matched route name (includes name prefix from include()).
   * Used by useHref() for local name resolution.
   */
  routeName?: string;
  /**
   * Map of route names to URL patterns.
   * Used by useHref() to resolve route names to URLs.
   */
  routeMap?: Record<string, string>;
  /**
   * Server-Timing header value (only present when debugPerformance is enabled)
   * Can be added to response headers for DevTools integration
   */
  serverTiming?: string;
  /**
   * State of named slots for this route match
   * Key is slot name (e.g., "@modal"), value is slot state
   * Slots are used for intercepting routes during soft navigation
   */
  slots?: Record<string, SlotState>;
  /**
   * Redirect URL for trailing slash normalization.
   * When set, the RSC handler should return a 308 redirect to this URL
   * instead of rendering the page.
   */
  redirect?: string;
  /**
   * Route-level middleware collected from the matched entry tree.
   * These run with the same onion-style execution as app-level middleware,
   * wrapping the entire RSC response creation.
   */
  routeMiddleware?: Array<{
    handler: import("./router/middleware.js").MiddlewareFn;
    params: Record<string, string>;
  }>;
}

/**
 * Internal route entry stored in router
 */
export interface RouteEntry<TEnv = any> {
  prefix: string;
  routes: ResolvedRouteMap<any>;
  /**
   * Trailing slash config per route key
   * If not specified for a route, defaults to pattern-based detection
   */
  trailingSlash?: Record<string, TrailingSlashMode>;
  handler: () =>
      | Array<AllUseItems>
      | Promise<{ default: () => Array<AllUseItems> }>
      | Promise<() => Array<AllUseItems>>;
  mountIndex: number;
}


/**
 * Revalidation function with typed params
 *
 * @template T - Params object
 * @template TEnv - Environment type
 *
 * @example
 * ```typescript
 * const revalidate: Revalidate<{ slug: string }> = ({ currentParams, nextParams }) => {
 *   return currentParams.slug !== nextParams.slug;
 * }
 * ```
 */
export type Revalidate<T = GenericParams, TEnv = DefaultEnv> = ShouldRevalidateFn<T, TEnv>;

/**
 * Middleware function with typed params and environment
 *
 * @template TParams - Params object (defaults to generic)
 * @template TEnv - Environment type (defaults to global RSCRouter.Env)
 *
 * Note: Middleware cannot directly use route names for params typing because
 * middleware is defined during router setup, before RegisteredRoutes is populated.
 * Use ExtractParams<"/path/:id"> for typed params from a path pattern.
 *
 * @example
 * ```typescript
 * // Basic middleware (uses global RSCRouter.Env via module augmentation)
 * const middleware: Middleware = async (ctx, next) => {
 *   ctx.set("user", { id: "123" }); // Type-safe!
 *   await next();
 * }
 *
 * // With explicit params (most common)
 * const middleware: Middleware<{ id: string }> = async (ctx, next) => {
 *   console.log(ctx.params.id);
 *   await next();
 * }
 *
 * // With params from path pattern
 * const middleware: Middleware<ExtractParams<"/products/:id">> = async (ctx, next) => {
 *   console.log(ctx.params.id);
 *   await next();
 * }
 *
 * // With both params and explicit env
 * const middleware: Middleware<{ id: string }, AppEnv> = async (ctx, next) => {
 *   ctx.set("user", { id: ctx.params.id });
 *   await next();
 * }
 * ```
 */
export type Middleware<TParams = GenericParams, TEnv = DefaultEnv> = MiddlewareFn<TEnv, TParams>;


// ============================================================================
// Cache Types
// ============================================================================

/**
 * Context passed to cache condition/key/tags functions.
 *
 * This is a subset of RequestContext that's guaranteed to be available
 * during cache key generation (before middleware runs).
 *
 * Note: While the full RequestContext is passed, middleware-set variables
 * (ctx.var, ctx.get()) may not be populated yet since cache lookup
 * happens before middleware execution.
 */
export type { RequestContext as CacheContext } from "./server/request-context.js";

/**
 * Cache configuration options for cache() DSL
 *
 * Controls how segments, layouts, and loaders are cached.
 * Cache configuration inherits down the route tree unless overridden.
 *
 * @example
 * ```typescript
 * // Basic caching with TTL
 * cache({ ttl: 60 }, () => [
 *   layout(<BlogLayout />),
 *   route("post/:slug"),
 * ])
 *
 * // With stale-while-revalidate
 * cache({ ttl: 60, swr: 300 }, () => [
 *   route("product/:id"),
 * ])
 *
 * // Conditional caching
 * cache({
 *   ttl: 300,
 *   condition: (ctx) => !ctx.request.headers.get('x-preview'),
 * }, () => [...])
 *
 * // Custom cache key
 * cache({
 *   ttl: 300,
 *   key: (ctx) => `product-${ctx.params.id}-${ctx.searchParams.get('variant')}`,
 * }, () => [...])
 *
 * // With tags for invalidation
 * cache({
 *   ttl: 300,
 *   tags: (ctx) => [`product:${ctx.params.id}`, 'products'],
 * }, () => [...])
 * ```
 */
export interface CacheOptions<TEnv = unknown> {
  /**
   * Time-to-live in seconds.
   * After this period, cached content is considered stale.
   */
  ttl: number;

  /**
   * Stale-while-revalidate window in seconds (after TTL).
   * During this window, stale content is served immediately while
   * fresh content is fetched in the background via waitUntil.
   *
   * @example
   * // TTL: 60s, SWR: 300s
   * // 0-60s: FRESH (serve from cache)
   * // 60-360s: STALE (serve from cache, revalidate in background)
   * // 360s+: EXPIRED (cache miss, fetch fresh)
   */
  swr?: number;

  /**
   * Override the cache store for this boundary.
   * When specified, this boundary and its children use this store
   * instead of the app-level store from handler config.
   *
   * Useful for:
   * - Different backends per route section (memory vs KV vs Redis)
   * - Loader-specific caching strategies
   * - Hot data in fast cache, cold data in larger/slower cache
   *
   * @example
   * ```typescript
   * const kvStore = new CloudflareKVStore(env.CACHE_KV);
   * const memoryStore = new MemorySegmentCacheStore({ defaults: { ttl: 10 } });
   *
   * // Fast memory cache for hot data
   * cache({ store: memoryStore }, () => [
   *   route("dashboard"),
   * ])
   *
   * // KV for larger, less frequently accessed data
   * cache({ store: kvStore, ttl: 3600 }, () => [
   *   route("archive/:year"),
   * ])
   * ```
   */
  store?: import("./cache/types.js").SegmentCacheStore;

  /**
   * Conditional cache read function.
   * Return false to skip cache for this request (always fetch fresh).
   *
   * Has access to full RequestContext including env, request, params, cookies, etc.
   * Note: Middleware-set variables (ctx.var) may not be populated yet.
   *
   * @example
   * ```typescript
   * condition: (ctx) => {
   *   // Skip cache for preview mode
   *   if (ctx.request.headers.get('x-preview')) return false;
   *   // Skip cache for authenticated users
   *   if (ctx.request.headers.has('authorization')) return false;
   *   return true;
   * }
   * ```
   */
  condition?: (ctx: import("./server/request-context.js").RequestContext<TEnv>) => boolean;

  /**
   * Custom cache key function - FULL OVERRIDE.
   * Bypasses default key generation AND store's keyGenerator.
   *
   * Has access to full RequestContext including env, request, params, cookies, etc.
   * Note: Middleware-set variables (ctx.var) may not be populated yet.
   *
   * @example
   * ```typescript
   * // Include query params in cache key
   * key: (ctx) => `product-${ctx.params.id}-${ctx.searchParams.get('variant')}`
   *
   * // Include env bindings
   * key: (ctx) => `${ctx.env.REGION}:product:${ctx.params.id}`
   *
   * // Include cookies
   * key: (ctx) => `${ctx.cookie('locale')}:${ctx.pathname}`
   * ```
   */
  key?: (ctx: import("./server/request-context.js").RequestContext<TEnv>) => string | Promise<string>;

  /**
   * Tags for cache invalidation.
   * Can be a static array or a function that returns tags.
   *
   * @example
   * ```typescript
   * // Static tags
   * tags: ['products', 'catalog']
   *
   * // Dynamic tags
   * tags: (ctx) => [`product:${ctx.params.id}`, 'products']
   * ```
   */
  tags?: string[] | ((ctx: import("./server/request-context.js").RequestContext<TEnv>) => string[]);
}

/**
 * Partial cache options for cache() DSL.
 *
 * When `ttl` is not specified, it will use the default from cache config.
 * This allows cache() calls to inherit app-level defaults:
 *
 * @example
 * ```typescript
 * // App-level default (in handler config)
 * cache: { store: myStore, defaults: { ttl: 60 } }
 *
 * // Route-level (inherits ttl from defaults)
 * cache(() => [
 *   route("products"),
 * ])
 *
 * // Override with explicit ttl
 * cache({ ttl: 300 }, () => [...])
 * ```
 */
export type PartialCacheOptions<TEnv = unknown> = Partial<CacheOptions<TEnv>>;

/**
 * Cache entry configuration stored in EntryData.
 * Represents the resolved cache config for a segment.
 */
export interface EntryCacheConfig {
  /** Cache options (false means caching disabled for this entry) - ttl is optional, uses defaults */
  options: PartialCacheOptions | false;
}

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
 * const CartLoader = createLoader(async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");  // From auth middleware
 *   return await db.cart.get(user.id);
 * });
 *
 * // With typed params:
 * const ProductLoader = createLoader<Product, { slug: string }>(async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;  // slug is typed as string
 *   return await db.products.findBySlug(slug);
 * });
 * ```
 */
export type LoaderContext<TParams = Record<string, string | undefined>, TEnv = any, TBody = unknown> = {
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
  /**
   * HTTP method (GET, POST, PUT, PATCH, DELETE)
   * Available when loader is called via load({ method: "POST", ... })
   */
  method: string;
  /**
   * Request body for POST/PUT/PATCH/DELETE requests
   * Available when loader is called via load({ method: "POST", body: {...} })
   */
  body: TBody | undefined;
  /**
   * Form data when loader is invoked via action (fetchable loaders)
   * Available when loader is called via form submission
   */
  formData?: FormData;
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
 * export const CartLoader = createLoader(async (ctx) => {
 *   "use server";
 *   return await db.cart.get(ctx.get("user").id);
 * });
 *
 * // With typed params:
 * export const ProductLoader = createLoader<Product, { slug: string }>(async (ctx) => {
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
/**
 * Options for fetchable loaders
 *
 * Middleware uses the same MiddlewareFn signature as route/app middleware,
 * enabling reuse of the same middleware functions everywhere.
 */
export type FetchableLoaderOptions = {
  fetchable?: true;
  middleware?: MiddlewareFn[];
};

/**
 * Options for load() calls - type-safe union based on method
 */
export type LoadOptions =
  | {
      method?: "GET";
      params?: Record<string, string>;
    }
  | {
      method: "POST" | "PUT" | "PATCH" | "DELETE";
      params?: Record<string, string>;
      body?: FormData | Record<string, any>;
    };

/**
 * Context passed to loader action on server
 */
export type LoaderActionContext = {
  method: string;
  params: Record<string, string>;
  body?: FormData | Record<string, any>;
  formData?: FormData;
};

/**
 * @deprecated Use MiddlewareFn instead for fetchable loader middleware.
 * This type is kept for backwards compatibility but will be removed in a future version.
 *
 * Fetchable loaders now use the same middleware signature as routes,
 * enabling middleware reuse across routes and loaders.
 */
export type LoaderMiddlewareFn = (
  ctx: LoaderActionContext,
  next: () => Promise<void>
) => Response | Promise<Response> | void | Promise<void>;

/**
 * Loader action function type - server action for form-based fetching
 * This is a server action that can be passed to useActionState or form action prop.
 *
 * The signature (prevState, formData) is required for useActionState compatibility.
 * When used with useActionState, React passes the previous state as the first argument.
 */
export type LoaderAction<T> = (prevState: T | null, formData: FormData) => Promise<T>;

export type LoaderDefinition<T = any, TParams = Record<string, string | undefined>> = {
  __brand: "loader";
  $$id: string;  // Injected by Vite plugin (exposeLoaderId) - unique identifier
  fn?: LoaderFn<T, TParams, any>;  // Optional - stripped on client via "use server"
  action?: LoaderAction<T>;  // Optional - for fetchable loaders
};

// ============================================================================
// Error Handling Types
// ============================================================================

/**
 * Phase where the error occurred during request handling.
 *
 * Coverage notes:
 * - "routing": Invoked when route matching fails (router.ts, rsc/handler.ts)
 * - "manifest": Reserved for manifest loading errors (not currently invoked)
 * - "middleware": Reserved for middleware execution errors (errors propagate to handler phase)
 * - "loader": Invoked when loader execution fails (router.ts via wrapLoaderWithErrorHandling, rsc/handler.ts)
 * - "handler": Invoked when route/layout handler execution fails (router.ts)
 * - "rendering": Invoked during SSR rendering errors (ssr/index.tsx, separate callback)
 * - "action": Invoked when server action execution fails (rsc/handler.ts, router.ts)
 * - "revalidation": Invoked when revalidation fails (router.ts, conditional with action)
 * - "unknown": Fallback for unclassified errors (not currently invoked)
 */
export type ErrorPhase =
  | "routing"      // During route matching
  | "manifest"     // During manifest loading (reserved, not currently invoked)
  | "middleware"   // During middleware execution (errors propagate to handler phase)
  | "loader"       // During loader execution
  | "handler"      // During route/layout handler execution
  | "rendering"    // During RSC/SSR rendering (SSR handler uses separate callback)
  | "action"       // During server action execution
  | "revalidation" // During revalidation evaluation
  | "unknown";     // Fallback for unclassified errors

/**
 * Comprehensive context passed to onError callback
 *
 * Provides all available information about where and when an error occurred
 * during request handling. The callback can use this for logging, monitoring,
 * error tracking services, or custom error responses.
 *
 * @example
 * ```typescript
 * const router = createRSCRouter<AppEnv>({
 *   onError: (context) => {
 *     // Log to error tracking service
 *     errorTracker.capture({
 *       error: context.error,
 *       phase: context.phase,
 *       url: context.request.url,
 *       route: context.routeKey,
 *       userId: context.env?.user?.id,
 *     });
 *
 *     // Log to console with context
 *     console.error(`[${context.phase}] Error in ${context.routeKey}:`, {
 *       message: context.error.message,
 *       segment: context.segmentId,
 *       duration: context.duration,
 *     });
 *   },
 * });
 * ```
 */
export interface OnErrorContext<TEnv = any> {
  /**
   * The error that occurred
   */
  error: Error;

  /**
   * Phase where the error occurred
   */
  phase: ErrorPhase;

  /**
   * The original request
   */
  request: Request;

  /**
   * Parsed URL from the request
   */
  url: URL;

  /**
   * Request pathname
   */
  pathname: string;

  /**
   * HTTP method
   */
  method: string;

  /**
   * Matched route key (if available)
   * e.g., "shop.products.detail"
   */
  routeKey?: string;

  /**
   * Route params (if available)
   * e.g., { slug: "headphones" }
   */
  params?: Record<string, string>;

  /**
   * Segment ID where error occurred (if available)
   * e.g., "M1L0" for a layout, "M1R0" for a route
   */
  segmentId?: string;

  /**
   * Segment type where error occurred (if available)
   */
  segmentType?: "layout" | "route" | "parallel" | "loader" | "middleware";

  /**
   * Loader name (if error occurred in a loader)
   */
  loaderName?: string;

  /**
   * Middleware name/id (if error occurred in middleware)
   */
  middlewareId?: string;

  /**
   * Action ID (if error occurred during server action)
   * e.g., "src/actions.ts#addToCart"
   */
  actionId?: string;

  /**
   * Environment/bindings (platform context)
   */
  env?: TEnv;

  /**
   * Duration from request start to error (milliseconds)
   */
  duration?: number;

  /**
   * Whether this is a partial/navigation request
   */
  isPartial?: boolean;

  /**
   * Whether an error boundary caught the error
   * If true, the error was handled and a fallback UI was rendered
   */
  handledByBoundary?: boolean;

  /**
   * Stack trace (if available)
   */
  stack?: string;

  /**
   * Additional metadata specific to the error phase
   */
  metadata?: Record<string, unknown>;
}

/**
 * Callback function for error handling
 *
 * Called whenever an error occurs during request handling.
 * The callback is for notification/logging purposes - it cannot
 * modify the error handling flow (use errorBoundary for that).
 *
 * @param context - Comprehensive error context
 *
 * @example
 * ```typescript
 * const onError: OnErrorCallback = (context) => {
 *   // Send to error tracking service
 *   Sentry.captureException(context.error, {
 *     tags: {
 *       phase: context.phase,
 *       route: context.routeKey,
 *     },
 *     extra: {
 *       url: context.url.toString(),
 *       params: context.params,
 *       duration: context.duration,
 *     },
 *   });
 * };
 * ```
 */
export type OnErrorCallback<TEnv = any> = (context: OnErrorContext<TEnv>) => void | Promise<void>;

