import type { ReactNode } from "react";
import type { Handle } from "../handle.js";
import type { HandlePush } from "../defer.js";
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
  DefaultRouteName,
  DefaultVars,
} from "./global-namespace.js";
import type {
  ExtractParams,
  RouteDefinition,
  ResolvedRouteMap,
} from "./route-config.js";
import type { LoaderDefinition } from "./loader-types.js";
import type { UseItems, HandlerUseItem } from "../route-types.js";
import type { RequestScope } from "./request-scope.js";

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
  TMap = Rango.GeneratedRouteMap,
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
> = ((
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
) => ReactNode | Promise<ReactNode> | Response | Promise<Response>) & {
  /** Composable default DSL items merged when the handler is mounted. */
  use?: () => UseItems<HandlerUseItem>;
};

/**
 * Context passed to handlers (Hono-inspired type-safe context)
 *
 * Provides type-safe access to:
 * - Route params (from URL pattern)
 * - Cleaned route URL (`url`, `searchParams`, `pathname` — no `_rsc*` params)
 * - Original request (`request` — raw transport URL, headers, method, body)
 * - Platform bindings (env.DB, env.KV, env.SECRETS)
 * - Middleware variables (`get("user")`, `get("permissions")`)
 * - Getter/setter for variables (get('user'), set('user', ...))
 *
 * @example
 * ```typescript
 * const handler = (ctx: HandlerContext<{ slug: string }, AppEnv>) => {
 *   ctx.params.slug        // Route param (string)
 *   ctx.env.DB             // Binding (D1Database)
 *   ctx.get('user')        // Variable (User | undefined)
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
> = RequestScope<TEnv> & {
  /**
   * Route parameters extracted from the URL pattern.
   * Type-safe when using Handler<"/path/:param"> or Handler<{ param: string }>.
   */
  params: TParams;
  /** @internal Phantom property for params type invariance. Prevents mounting handlers on wrong routes. */
  readonly _paramCheck?: (params: TParams) => TParams;
  /**
   * True during build-time pre-rendering, false at runtime.
   * Build-time collection and dev on-demand prerender use `true`.
   * Live request rendering, including passthrough fallback, uses `false`.
   */
  build: boolean;
  /**
   * True when running in Vite dev mode, false during production build or
   * live request rendering. Use this to branch on runtime mode without
   * changing build semantics (e.g., skip expensive operations in dev).
   */
  dev: boolean;
  /**
   * Typed search parameters parsed from URL query string via the route's
   * search schema. Empty object when no schema is defined.
   */
  search: {} extends TSearch ? {} : ResolveSearchSchema<TSearch>;
  /**
   * Type-safe getter for middleware variables.
   * Preferred way to read middleware-injected variables.
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
    <T>(
      contextVar: ContextVar<T>,
      value: T,
      options?: { cache?: boolean },
    ): void;
  } & (<K extends keyof DefaultVars>(
    key: K,
    value: DefaultVars[K],
    options?: { cache?: boolean },
  ) => void);
  /**
   * Response headers. Headers set here are merged into the final response.
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
   * Available in route handlers, layout handlers, middleware, server actions,
   * and server components rendered within the request context.
   *
   * For loaders: Returns a promise that resolves to the loader data.
   * Loaders are executed in parallel and memoized per request.
   * Prefer DSL `loader()` + client `useLoader()` over `ctx.use(Loader)` —
   * DSL loaders are always fresh and cache-safe. Use `ctx.use(Loader)` only
   * when you need loader data in the handler itself (e.g., to set context
   * variables or make routing decisions).
   *
   * For handles: Returns a push function to add data for this segment.
   * Handle data accumulates across all matched route segments.
   * Push accepts: direct value, Promise, or async callback (executed immediately).
   *
   * @example
   * ```typescript
   * // Loader escape hatch — use when handler needs the data directly
   * route("product", async (ctx) => {
   *   const { product } = await ctx.use(ProductLoader);
   *   ctx.set(Product, product); // make available to children
   *   return <ProductPage />;
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
    ): HandlePush<TData>;
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
   * The matched route name, if the route has an explicit name.
   * Undefined for unnamed routes (those without a `name` option in path()).
   * Includes the namespace prefix from include() (e.g., "blog.post").
   *
   * @example
   * ```typescript
   * route("product", (ctx) => {
   *   ctx.routeName // "product"
   *   return <ProductPage />;
   * });
   * ```
   */
  routeName?: DefaultRouteName;
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
  /** @internal Stub response for collecting headers/cookies. */
  res: Response;
  /** @internal Shared variable backing store for ctx.get()/ctx.set(). */
  _variables: Record<string, any>;
  /** Prerender-only control flow helper, attached when the runtime context supports it. */
  passthrough?: () => unknown;
  /** Current segment ID for handle data attribution. */
  _currentSegmentId?: string;
  /** Response type tag (json, text, html, etc.) for cache key differentiation. */
  _responseType?: string;
  /** Route name for cache key scoping (prevents cross-route collisions). */
  _routeName?: string;
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
 * - `void` / `null` / `undefined` - Defer to the current suggestion (no opinion); the
 *   loop continues to the next revalidator without changing the running default
 *
 * **Execution Flow:**
 * 1. Start with built-in `defaultShouldRevalidate` (true if params changed)
 * 2. Execute global revalidators first, then route-specific
 * 3. Hard decision (boolean): stop immediately and use that value
 * 4. Soft decision (object): update suggestion and continue to next revalidator
 * 5. Defer (`void` / `null` / `undefined`): leave suggestion unchanged and continue
 * 6. If no hard decision was returned: use the final running suggestion
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
 * @returns Hard decision (boolean), soft suggestion (object), or defer
 *   (`void` / `null` / `undefined`) to keep the running suggestion as-is.
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
/**
 * A reference to a server action, used by `isAction()` in a revalidate predicate.
 *
 * Either a directly imported action (`import { addToCart }`) or a namespace
 * import of an action module (`import * as CartActions`). Matching resolves the
 * action's build-injected id (`path#export`) — the same identity the router uses
 * for `actionId` — so a renamed or moved action breaks at compile time instead
 * of silently failing to match.
 */
export type ActionRef =
  | ((...args: never[]) => unknown)
  | Record<string, unknown>;

/**
 * Revalidation function called during client-side navigation to decide whether
 * a segment (layout, route, parallel slot, or loader) should be re-rendered.
 *
 * Return `true` to re-render, `false` to skip (keep client's current version),
 * `{ defaultShouldRevalidate: boolean }` to update the running suggestion for
 * downstream revalidators, or nothing (`void` / `null` / `undefined`) to defer
 * to the current suggestion without changing it.
 *
 * @example
 * ```ts
 * // Re-render when a cart action happened or the browser signals staleness;
 * // defer otherwise (|| undefined) so the segment default still applies
 * revalidate(({ actionId, stale }) =>
 *   actionId?.includes("cart") || stale || undefined
 * )
 *
 * // Always re-render when params change (default behavior made explicit)
 * revalidate(({ defaultShouldRevalidate }) => defaultShouldRevalidate)
 * ```
 */
export type ShouldRevalidateFn<TParams = GenericParams, TEnv = any> = (args: {
  /** Route params from the page being navigated away from. */
  currentParams: TParams;
  /** Full URL of the page being navigated away from. */
  currentUrl: URL;
  /** Route params for the navigation target. */
  nextParams: TParams;
  /** Full URL of the navigation target. */
  nextUrl: URL;
  /**
   * The router's default revalidation decision for this segment.
   * `true` when params changed or the segment is new to the client.
   * Return this when you want default behavior plus your own conditions.
   */
  defaultShouldRevalidate: boolean;
  /** Full handler context — access to `ctx.use()`, `ctx.env`, `ctx.params`, etc. */
  context: HandlerContext<TParams, TEnv>;

  // ── Segment metadata (which segment is being evaluated) ──────────────

  /**
   * The type of segment being revalidated. `"loader"` is passed to revalidate
   * functions attached to a `loader(Fn, () => [revalidate(...)])` registration.
   */
  segmentType: "layout" | "route" | "parallel" | "loader";
  /** Layout name (e.g., `"root"`, `"shop"`, `"auth"`). Only set for layout segments. */
  layoutName?: string;
  /** Slot name (e.g., `"@sidebar"`, `"@modal"`). Only set for parallel segments. */
  slotName?: string;

  // ── Action context (populated when revalidation is triggered by a server action) ──

  /**
   * Identifier of the server action that triggered revalidation.
   * `undefined` during normal navigation (no action involved).
   *
   * Format: `"src/<path>#<exportName>"` — the file path is the source path
   * relative to the project root, followed by `#` and the exported function name.
   *
   * This is stable and can be used for path-based matching to revalidate
   * when any action in a module or directory fires. Prefer `|| undefined`
   * (defer to the segment default / downstream revalidators) over `?? false`
   * (hard short-circuit that suppresses the default and ends the chain):
   *
   * @example
   * ```ts
   * // Match a specific action
   * revalidate(({ actionId }) => actionId === "src/actions/cart.ts#addToCart" || undefined)
   *
   * // Match any action in the cart module
   * revalidate(({ actionId }) => actionId?.includes("cart") || undefined)
   *
   * // Match any action under src/apps/store/actions/
   * revalidate(({ actionId }) => actionId?.startsWith("src/apps/store/actions/") || undefined)
   * ```
   */
  actionId?: string;
  /**
   * Typed, rename-safe action matching. Returns `true` when the action that
   * triggered this revalidation is one of the given references — or, for a
   * namespace import (`import * as CartActions`), any export of that module —
   * and `false` otherwise (including plain navigation with no action).
   *
   * Prefer this over hand-written `actionId` substring matches: it resolves the
   * action's stable `path#export` id from the imported reference, so a rename is
   * a type error in one place instead of silent drift across consumers. It
   * resolves the reference the same way the action boundary derives `actionId`
   * (`$id ?? $$id`), so it matches in both dev and production.
   *
   * Returns a raw boolean, so for the common "revalidate on match, else defer"
   * intent combine with `|| undefined`:
   *
   * @example
   * ```ts
   * import { addToCart, removeFromCart } from "./actions/cart";
   * import * as CartActions from "./actions/cart";
   *
   * revalidate((ctx) => ctx.isAction(addToCart) || undefined); // one action
   * revalidate((ctx) => ctx.isAction(addToCart, removeFromCart) || undefined); // several
   * revalidate((ctx) => ctx.isAction(CartActions) || undefined); // any in the module
   * ```
   */
  isAction: (...actions: ActionRef[]) => boolean;
  /** URL where the action was executed (the page the user was on when they triggered the action). */
  actionUrl?: URL;
  /** Return value from the action execution. Can be used to conditionally revalidate based on the action's outcome. */
  actionResult?: any;
  /** FormData from the action request body. Only set for form-based actions (not inline `"use server"` actions). */
  formData?: FormData;
  /** HTTP method: `"GET"` for navigation, `"POST"` for server actions. */
  method?: string;

  // ── Route identity ───────────────────────────────────────────────────

  /** Route name of the navigation target. Alias for `toRouteName`. */
  routeName?: DefaultRouteName;
  /**
   * Route name being navigated away from.
   * `undefined` for unnamed internal routes (those without a `name` option).
   */
  fromRouteName?: DefaultRouteName;
  /**
   * Route name being navigated to.
   * `undefined` for unnamed internal routes (those without a `name` option).
   */
  toRouteName?: DefaultRouteName;

  // ── Staleness signal ─────────────────────────────────────────────────

  /**
   * `true` when the browser signals that data may be stale — typically because
   * a server action was executed in this or another tab (`_rsc_stale` header).
   *
   * This is NOT segment cache staleness (loaders are never segment-cached).
   * Use this to decide whether loader data should be re-fetched after an
   * action that may have mutated backend state.
   */
  stale?: boolean;
}) => boolean | { defaultShouldRevalidate: boolean } | null | void;

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
 * @template TEnv - Environment type (defaults to global Rango.Env)
 *
 * Note: Middleware cannot directly use route names for params typing because
 * middleware is defined during router setup, before RegisteredRoutes is populated.
 * Use ExtractParams<"/path/:id"> for typed params from a path pattern.
 *
 * @example
 * ```typescript
 * // Basic middleware (uses global Rango.Env via module augmentation)
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
