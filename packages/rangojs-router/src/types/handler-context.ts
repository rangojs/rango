import type { ReactNode } from "react";
import type { Handle } from "../handle.js";
import type { ContextVar } from "../context-var.js";
import type { MiddlewareFn } from "../router/middleware.js";
import type { Theme } from "../theme/types.js";
import type { ScopedReverseFunction } from "../reverse.js";
import type { SearchSchema, ResolveSearchSchema } from "../search-params.js";
import type { LocationStateEntry } from "../browser/react/location-state-shared.js";
import type {
  DefaultEnv,
  DefaultHandlerRouteMap,
  DefaultReverseRouteMap,
  DefaultVars,
} from "./global-namespace.js";
import type {
  ExtractParams,
  RouteDefinition,
  ResolvedRouteMap,
} from "./route-config.js";
import type { LoaderDefinition } from "./loader-types.js";

// Re-export MiddlewareFn for internal/advanced use
export type { MiddlewareFn } from "../router/middleware.js";

/**
 * Create a scoped view of a route map by stripping a name prefix.
 * Useful for handlers in modules mounted via include() -- use the local
 * route name instead of the fully qualified global name.
 *
 * @example
 * ```typescript
 * // Given GeneratedRouteMap: { "blog.index": "/blog"; "blog.post": "/blog/:postId"; ... }
 * type BlogRoutes = ScopedRouteMap<"blog">;
 * // Resolves to: { "index": "/blog"; "post": "/blog/:postId" }
 *
 * const handler: Handler<"post", BlogRoutes> = (ctx) => {
 *   ctx.params.postId // string
 * };
 * ```
 */
export type ScopedRouteMap<
  TPrefix extends string,
  TMap = RSCRouter.GeneratedRouteMap,
> = {
  [K in keyof TMap as K extends `${TPrefix}.${infer Rest}`
    ? Rest
    : never]: TMap[K];
};

/**
 * Extract the search schema from a route map entry.
 * - string value (old format): no search schema -> {}
 * - { path, search } value: extract search
 * - { path, response } value (no search): -> {}
 */
/** Extract params from a route map entry (string pattern or { path } object). */
type ExtractParamsFromEntry<TEntry, TFallback> = TEntry extends string
  ? ExtractParams<TEntry>
  : TEntry extends { readonly path: infer P extends string }
    ? ExtractParams<P>
    : TFallback;

/** Extract search schema from a route map entry. */
type ExtractSearchFromEntry<TMap, TKey> = TKey extends keyof TMap
  ? TMap[TKey] extends { readonly search: infer S extends SearchSchema }
    ? S
    : {}
  : {};

type IsEmptyObject<T> = keyof T extends never ? true : false;

type AutofillParamsFromEntry<TEntry> = TEntry extends string
  ? string extends TEntry
    ? Record<string, string>
    : Partial<ExtractParams<TEntry>>
  : TEntry extends { readonly path: infer P extends string }
    ? string extends P
      ? Record<string, string>
      : Partial<ExtractParams<P>>
    : Record<string, string>;

type AutofillSearchFromEntry<TMap, TKey> = TKey extends keyof TMap
  ? TMap[TKey] extends { readonly search: infer S extends SearchSchema }
    ? ResolveSearchSchema<S>
    : Record<string, unknown>
  : Record<string, unknown>;

type AutofillAwareReverseFunction<TLocalRoutes, TGlobalRoutes> =
  ScopedReverseFunction<TLocalRoutes, TGlobalRoutes> & {
    <TName extends keyof TGlobalRoutes & string>(
      name: TName,
      params?: AutofillParamsFromEntry<TGlobalRoutes[TName]>,
      search?: AutofillSearchFromEntry<TGlobalRoutes, TName>,
    ): string;
    <TName extends keyof TLocalRoutes & string>(
      name: `.${TName}`,
      params?: AutofillParamsFromEntry<TLocalRoutes[TName]>,
      search?: AutofillSearchFromEntry<TLocalRoutes, TName>,
    ): string;
  };

type StrictLocalParamsWithExtras<TEntry> =
  IsEmptyObject<ExtractParamsFromEntry<TEntry, {}>> extends true
    ? Record<string, string>
    : ExtractParamsFromEntry<TEntry, {}> & Record<string, string>;

// HandlerContext.reverse is the only reverse surface with runtime param autofill
// from the current matched request. Middleware/loaders/request context do not
// have the same local-route guarantees, so they keep plain ScopedReverseFunction.
//
// When a handler has an explicit local route map, enforce that local route
// params declared by that map are present while still allowing extra mount
// params to be passed through. Global names remain autofill-friendly because
// parent include() params are often unknown at the module definition site.
type StrictLocalAutofillGlobalReverseFunction<TLocalRoutes, TGlobalRoutes> =
  ScopedReverseFunction<TLocalRoutes, TGlobalRoutes> & {
    <TName extends keyof TGlobalRoutes & string>(
      name: TName,
      params?: AutofillParamsFromEntry<TGlobalRoutes[TName]>,
      search?: AutofillSearchFromEntry<TGlobalRoutes, TName>,
    ): string;
    <TName extends keyof TLocalRoutes & string>(
      name: `.${TName}`,
      params: StrictLocalParamsWithExtras<TLocalRoutes[TName]>,
      search?: AutofillSearchFromEntry<TLocalRoutes, TName>,
    ): string;
  };

export type Handler<
  T extends
    | keyof DefaultHandlerRouteMap
    | `.${keyof TRouteMap & string}`
    | `/${string}`
    | Record<string, any> = {},
  TRouteMap extends {} = DefaultHandlerRouteMap,
  TEnv = DefaultEnv,
> = (
  ctx: HandlerContext<
    T extends `.${infer Local}`
      ? Local extends keyof TRouteMap
        ? ExtractParamsFromEntry<
            TRouteMap[Local],
            T extends string ? ExtractParams<T> : T
          >
        : T extends string
          ? ExtractParams<T>
          : T
      : T extends keyof DefaultHandlerRouteMap
        ? ExtractParamsFromEntry<
            DefaultHandlerRouteMap[T],
            T extends string ? ExtractParams<T> : T
          >
        : T extends string
          ? ExtractParams<T>
          : T,
    TEnv,
    T extends `.${infer Local}`
      ? ExtractSearchFromEntry<TRouteMap, Local>
      : ExtractSearchFromEntry<DefaultHandlerRouteMap, T>,
    TRouteMap extends DefaultHandlerRouteMap ? never : TRouteMap
  >,
) => ReactNode | Promise<ReactNode> | Response | Promise<Response>;

/**
 * Context passed to handlers (Hono-inspired type-safe context)
 *
 * Provides type-safe access to:
 * - Route params (from URL pattern)
 * - Cleaned route URL (`url`, `searchParams`, `pathname` — no `_rsc*` params)
 * - Original request (`request` — raw transport URL, headers, method, body)
 * - Platform bindings (env.DB, env.KV, env.SECRETS)
 * - Middleware variables (var.user, var.permissions)
 * - Getter/setter for variables (get('user'), set('user', ...))
 *
 * @example
 * ```typescript
 * const handler = (ctx: HandlerContext<{ slug: string }, AppEnv>) => {
 *   ctx.params.slug        // Route param (string)
 *   ctx.env.DB             // Binding (D1Database)
 *   ctx.var.user           // Variable (User | undefined)
 *   ctx.get('user')        // Alternative getter
 *   ctx.set('user', {...}) // Setter
 *   ctx.url                // Clean URL (no _rsc* params)
 *   ctx.searchParams       // Clean params (no _rsc* params)
 *   ctx.request            // Raw transport request (original URL intact)
 * }
 * ```
 */
export type HandlerContext<
  TParams = {},
  TEnv = DefaultEnv,
  TSearch extends SearchSchema = {},
  TRouteMap = never,
> = {
  /**
   * Route parameters extracted from the URL pattern.
   * Type-safe when using Handler<"/path/:param"> or Handler<{ param: string }>.
   */
  params: TParams;
  /** @internal Phantom property for params type invariance. Prevents mounting handlers on wrong routes. */
  readonly _paramCheck?: (params: TParams) => TParams;
  /**
   * True during build-time pre-rendering, false at runtime.
   * In dev mode, Prerender handlers run live so build is false.
   * In production passthrough (live fallback), build is also false.
   */
  build: boolean;
  /**
   * The original incoming Request object (transport URL intact).
   * Use `ctx.url` / `ctx.searchParams` for application logic — those have
   * internal `_rsc*` params stripped. `ctx.request` preserves the raw URL
   * for cases where you need original headers, method, or body.
   */
  request: Request;
  /**
   * Query parameters from the URL (system params like `_rsc*` are filtered).
   * Always a standard URLSearchParams instance.
   */
  searchParams: URLSearchParams;
  /**
   * Typed search parameters parsed from URL query string via the route's
   * search schema. Empty object when no schema is defined.
   */
  search: {} extends TSearch ? {} : ResolveSearchSchema<TSearch>;
  /**
   * The pathname portion of the request URL.
   */
  pathname: string;
  /**
   * The full URL object (with system params filtered).
   */
  url: URL;
  /**
   * Platform bindings (DB, KV, secrets, etc.).
   * Access resources like `ctx.env.DB`, `ctx.env.KV`.
   */
  env: TEnv;
  /**
   * Middleware-injected variables.
   * Access values like `ctx.var.user`, `ctx.var.permissions`.
   */
  var: DefaultVars;
  /**
   * Type-safe getter for middleware variables.
   * Alternative to `ctx.var.key` with better autocomplete.
   *
   * @example
   * ```typescript
   * const user = ctx.get("user"); // Type-safe!
   * ```
   */
  get: {
    <T>(contextVar: ContextVar<T>): T | undefined;
  } & (<K extends keyof DefaultVars>(key: K) => DefaultVars[K]);
  /**
   * Type-safe setter for middleware variables.
   * Use in middleware to pass data to handlers.
   *
   * @example
   * ```typescript
   * ctx.set("user", { id: "123", name: "John" }); // Type-safe!
   * ctx.set(MyVar, { ... }); // Type-safe via ContextVar token!
   * ```
   */
  set: {
    <T>(contextVar: ContextVar<T>, value: T): void;
  } & (<K extends keyof DefaultVars>(key: K, value: DefaultVars[K]) => void);
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
    <T, TLoaderParams = any>(
      loader: LoaderDefinition<T, TLoaderParams>,
    ): Promise<T>;
    <TData, TAccumulated = TData[]>(
      handle: Handle<TData, TAccumulated>,
    ): (data: TData | Promise<TData> | (() => Promise<TData>)) => void;
  };
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
   * Attach location state entries to this response.
   * State is delivered to the client via history.pushState and accessible
   * through the useLocationState() hook.
   *
   * @example
   * ```typescript
   * route("product", (ctx) => {
   *   ctx.setLocationState(ServerInfo({ data: "value" }));
   *   return <ProductPage />;
   * });
   * ```
   */
  setLocationState(entries: LocationStateEntry | LocationStateEntry[]): void;
  /**
   * Generate URLs from route names.
   *
   * - `.name` -- local route, resolved within current include() scope
   * - `name` -- global route, from the named-routes definition
   *
   * @example
   * ```typescript
   * ctx.reverse(".article", { slug: "hello" })       // Local: magazine.article
   * ctx.reverse(".index")                             // Local: magazine.index
   * ctx.reverse("magazine.index")                     // Global: magazine.index
   * ctx.reverse("blog.post", { slug: "hello" })       // Global: blog.post
   * ```
   */
  reverse: [TRouteMap] extends [never]
    ? AutofillAwareReverseFunction<
        Record<string, string>,
        DefaultReverseRouteMap
      >
    : StrictLocalAutofillGlobalReverseFunction<
        TRouteMap,
        DefaultReverseRouteMap
      >;
};

/**
 * Internal handler context with additional props for router internals.
 * Use `HandlerContext` for user-facing code.
 * @internal
 */
export type InternalHandlerContext<
  TParams = {},
  TEnv = DefaultEnv,
  TSearch extends SearchSchema = {},
> = HandlerContext<TParams, TEnv, TSearch> & {
  /** Current segment ID for handle data attribution. */
  _currentSegmentId?: string;
  /** Response type tag (json, text, html, etc.) for cache key differentiation. */
  _responseType?: string;
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
export type RevalidateParams<TParams = GenericParams, TEnv = any> = Parameters<
  ShouldRevalidateFn<TParams, TEnv>
>[0];

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
  segmentType: "layout" | "route" | "parallel";
  layoutName?: string; // Layout name (e.g., "root", "shop", "auth") - only for layouts
  slotName?: string; // Slot name (e.g., "@sidebar", "@modal") - only for parallels
  // Action context (populated when revalidation triggered by server action):
  actionId?: string; // Action identifier (e.g., "src/actions.ts#addToCart")
  actionUrl?: URL; // URL where action was executed
  actionResult?: any; // Return value from action execution
  formData?: FormData; // FormData from action request
  method?: string; // Request method: 'GET' for navigation, 'POST' for actions
  routeName?: string; // Route name where action was executed (e.g., "products.detail")
  // Stale cache revalidation (SWR pattern):
  stale?: boolean; // True if this is a stale cache revalidation request
}) => boolean | { defaultShouldRevalidate: boolean };

// MiddlewareFn is imported from "../router/middleware.js" and re-exported

/**
 * Extract all route keys from a route definition (includes flattened nested routes)
 */
export type RouteKeys<T extends RouteDefinition> = keyof ResolvedRouteMap<T> &
  string;

/**
 * Valid layout value - component or handler function
 * Note: Arrays are not supported. Use separate layout() declarations with unique names instead.
 */
type LayoutValue<TEnv = any> = ReactNode | Handler<any, any, TEnv>;

/**
 * Helper to extract params from a route key using the resolved (flattened) route map
 */
export type ExtractRouteParams<
  T extends RouteDefinition,
  K extends string,
> = K extends keyof ResolvedRouteMap<T>
  ? ResolvedRouteMap<T>[K] extends string
    ? ExtractParams<ResolvedRouteMap<T>[K]>
    : GenericParams
  : GenericParams;

/**
 * Handlers object that maps route names to handler functions with type-safe string patterns
 */
export type HandlersForRouteMap<T extends RouteDefinition, TEnv = any> = {
  // Route handlers - type-safe params extracted from route patterns
  [K in RouteKeys<T>]?: Handler<ExtractRouteParams<T, K & string>, any, TEnv>;
} & {
  // Layout patterns: $layout.{routeName}.{layoutName}
  [K in `$layout.${RouteKeys<T> | "*"}.${string}`]?: LayoutValue<TEnv>;
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
      any,
      TEnv
    >
  >;
} & {
  // Global parallel routes (with '*') use GenericParams
  [K in `$parallel.${"*"}.${string}`]?: Record<
    `@${string}`,
    Handler<GenericParams, any, TEnv>
  >;
} & {
  // Middleware patterns: $middleware.{routeName}.{middlewareName}
  [K in `$middleware.${RouteKeys<T> | "*"}.${string}`]?: MiddlewareFn<
    TEnv,
    GenericParams
  >[];
} & {
  // Route revalidate patterns: $revalidate.route.{routeName}.{revalidateName}
  [K in `$revalidate.route.${RouteKeys<T> | "*"}.${string}`]?: ShouldRevalidateFn<
    GenericParams,
    TEnv
  >;
} & {
  // Layout revalidate patterns: $revalidate.layout.{routeName}.{layoutName}.{revalidateName}
  [K in `$revalidate.layout.${RouteKeys<T> | "*"}.${string}.${string}`]?: ShouldRevalidateFn<
    GenericParams,
    TEnv
  >;
} & {
  // Parallel revalidate patterns: $revalidate.parallel.{routeName}.{parallelName}.{slotName}.{revalidateName}
  [K in `$revalidate.parallel.${RouteKeys<T> | "*"}.${string}.${string}.${string}`]?: ShouldRevalidateFn<
    GenericParams,
    TEnv
  >;
};

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
export type Revalidate<
  T = GenericParams,
  TEnv = DefaultEnv,
> = ShouldRevalidateFn<T, TEnv>;

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
export type Middleware<
  TParams = GenericParams,
  TEnv = DefaultEnv,
> = MiddlewareFn<TEnv, TParams>;
