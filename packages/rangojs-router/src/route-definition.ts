import type { ReactNode } from "react";
import type {
  PartialCacheOptions,
  DefaultEnv,
  ErrorBoundaryHandler,
  ExtractRouteParams,
  Handler,
  HandlersForRouteMap,
  LoaderDefinition,
  LoaderFn,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  ResolvedRouteMap,
  RouteConfig,
  RouteDefinition,
  RouteDefinitionOptions,
  ShouldRevalidateFn,
  TrailingSlashMode,
} from "./types.js";
import {
  getContext,
  getNamePrefix,
  getUrlPrefix,
  type EntryData,
  type InterceptEntry,
  type InterceptWhenFn,
  type InterceptSelectorContext,
} from "./server/context";
import { invariant } from "./errors";
import { isStaticHandler } from "./static-handler.js";
import RootLayout from "./server/root-layout";
import type {
  AllUseItems,
  LayoutItem,
  RouteItem,
  ParallelItem,
  InterceptItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  LoadingItem,
  ErrorBoundaryItem,
  NotFoundBoundaryItem,
  LayoutUseItem,
  RouteUseItem,
  ParallelUseItem,
  InterceptUseItem,
  LoaderUseItem,
  WhenItem,
  CacheItem,
} from "./route-types.js";
// const __DEV__ = import.meta.MODE === "development";

/**
 * Result of route() function with paths and trailing slash config
 */
export interface RouteDefinitionResult<T extends RouteDefinition> {
  routes: ResolvedRouteMap<T>;
  trailingSlash: Record<string, TrailingSlashMode>;
}

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
 * Define routes with optional trailing slash configuration
 *
 * @example
 * ```typescript
 * // Simple string paths
 * const routes = route({
 *   blog: "/blog",
 *   post: "/blog/:id",
 * });
 *
 * // With trailing slash config
 * const routes = route({
 *   blog: "/blog",
 *   api: { path: "/api", trailingSlash: "ignore" },
 * }, { trailingSlash: "never" }); // global default
 * ```
 */
export function route<const T extends RouteDefinition>(
  input: T,
  options?: RouteDefinitionOptions
): ResolvedRouteMap<T> & {
  __trailingSlash?: Record<string, TrailingSlashMode>;
} {
  const trailingSlash: Record<string, TrailingSlashMode> = {};
  const routes = flattenRoutes(
    input as RouteDefinition,
    "",
    trailingSlash,
    options?.trailingSlash
  );

  // Attach trailing slash config as a non-enumerable property
  // This keeps backwards compatibility while passing the config through
  const result = routes as ResolvedRouteMap<T> & {
    __trailingSlash?: Record<string, TrailingSlashMode>;
  };
  if (Object.keys(trailingSlash).length > 0) {
    Object.defineProperty(result, "__trailingSlash", {
      value: trailingSlash,
      enumerable: false,
      writable: false,
    });
  }

  return result;
}

/**
 * Flatten nested route definitions
 */
function flattenRoutes(
  routes: RouteDefinition,
  prefix: string,
  trailingSlashConfig: Record<string, TrailingSlashMode>,
  defaultTrailingSlash?: TrailingSlashMode
): Record<string, string> {
  const flattened: Record<string, string> = {};

  for (const [key, value] of Object.entries(routes)) {
    const fullKey = prefix + key;

    if (typeof value === "string") {
      // Direct route pattern - include prefix
      flattened[fullKey] = value;
      // Apply default trailing slash if set
      if (defaultTrailingSlash) {
        trailingSlashConfig[fullKey] = defaultTrailingSlash;
      }
    } else if (isRouteConfig(value)) {
      // Route config object with path and optional trailingSlash
      flattened[fullKey] = value.path;
      // Use route-specific config or fall back to default
      const mode = value.trailingSlash ?? defaultTrailingSlash;
      if (mode) {
        trailingSlashConfig[fullKey] = mode;
      }
    } else {
      // Nested routes - flatten recursively
      const nested = flattenRoutes(
        value,
        `${fullKey}.`,
        trailingSlashConfig,
        defaultTrailingSlash
      );
      Object.assign(flattened, nested);
    }
  }

  return flattened;
}

// Type definitions moved to route-types.ts to avoid bundling in client code
// Re-export for backward compatibility within this module
export type {
  AllUseItems,
  LayoutItem,
  RouteItem,
  ParallelItem,
  InterceptItem,
  MiddlewareItem,
  RevalidateItem,
  LoaderItem,
  ErrorBoundaryItem,
  NotFoundBoundaryItem,
  LayoutUseItem,
  RouteUseItem,
  ParallelUseItem,
  InterceptUseItem,
  WhenItem,
  CacheItem,
} from "./route-types.js";

// Re-export intercept selector types for use in handlers
export type {
  InterceptSelectorContext,
  InterceptSegmentsState,
  InterceptWhenFn,
} from "./server/context";

/**
 * Route helpers provided by map()
 * These are the only typed helpers users interact with
 */
export type RouteHelpers<T extends RouteDefinition, TEnv> = {
  /**
   * Define a route handler for a specific route pattern
   * ```typescript
   * route("products.detail", async (ctx) => {
   *   const product = await getProduct(ctx.params.slug);
   *   return <ProductPage product={product} />;
   * })
   *
   * // With nested use() for middleware, loaders, etc.
   * route("products.detail", ProductHandler, () => [
   *   loader(ProductLoader),
   *   loading(<ProductSkeleton />),
   * ])
   * ```
   * @param name - Route name matching a key from route definitions
   * @param handler - Async function that returns JSX for the route
   * @param use - Optional callback returning middleware, loaders, loading, etc.
   */
  route: <K extends keyof ResolvedRouteMap<T> & string>(
    name: K,
    handler: Handler<ExtractRouteParams<T, K & string>, {}, TEnv>,
    use?: () => RouteUseItem[]
  ) => RouteItem;
  /**
   * Define a layout that wraps child routes
   * ```typescript
   * layout(<RootLayout />, () => [
   *   route("home", HomePage),
   *   route("about", AboutPage),
   * ])
   *
   * // With dynamic layout handler
   * layout(async (ctx) => {
   *   const user = ctx.get("user");
   *   return <DashboardShell user={user} />;
   * }, () => [
   *   middleware(authMiddleware),
   *   route("dashboard", DashboardPage),
   * ])
   * ```
   * @param component - Static JSX or async handler for the layout
   * @param use - Callback returning child routes, middleware, loaders, etc.
   */
  layout: (
    component: ReactNode | Handler<any, any, TEnv>,
    use?: () => LayoutUseItem[]
  ) => LayoutItem;
  /**
   * Define parallel routes that render simultaneously in named slots
   * ```typescript
   * parallel({
   *   "@sidebar": <Sidebar />,
   *   "@main": async (ctx) => <MainContent data={ctx.use(DataLoader)} />,
   * })
   *
   * // With loaders and loading states
   * parallel({
   *   "@analytics": AnalyticsPanel,
   *   "@metrics": MetricsPanel,
   * }, () => [
   *   loader(DashboardLoader),
   *   loading(<DashboardSkeleton />),
   * ])
   * ```
   * @param slots - Object with slot names (prefixed with @) mapped to handlers
   * @param use - Optional callback for loaders, loading, revalidate, etc.
   */
  parallel: <
    TSlots extends Record<`@${string}`, Handler<any, any, TEnv> | ReactNode>,
  >(
    slots: TSlots,
    use?: () => ParallelUseItem[]
  ) => ParallelItem;
  /**
   * Define an intercepting route for soft navigation
   *
   * When soft-navigating to the target route from within the current layout,
   * the intercept handler renders in the named slot instead of the route's
   * default handler. Direct navigation uses the route's handler.
   *
   * ```typescript
   * // In a layout - intercept "card" route as modal
   * layout(<KanbanLayout />, () => [
   *   intercept("@modal", "card", () => <CardModal />),
   * ])
   *
   * // With loaders and revalidation
   * intercept("@modal", "card", () => <CardModal />, () => [
   *   loader(CardModalLoader),
   *   revalidate(() => false),
   * ])
   * ```
   * @param slotName - Named slot (prefixed with @) where intercept renders
   * @param routeName - Route name to intercept
   * @param handler - Component or handler for intercepted render
   * @param use - Optional callback for loaders, middleware, revalidate, etc.
   */
  intercept: {
    // Local: dot-prefixed, params inferred from local route definition
    <K extends keyof ResolvedRouteMap<T> & string>(
      slotName: `@${string}`,
      routeName: `.${K}`,
      handler: ReactNode | Handler<ExtractRouteParams<T, K>, {}, TEnv>,
      use?: () => InterceptUseItem[]
    ): InterceptItem;
    // Global: unprefixed, params inferred from global route map
    <K extends keyof RSCRouter.GeneratedRouteMap & string>(
      slotName: `@${string}`,
      routeName: K,
      handler: ReactNode | Handler<K, RSCRouter.GeneratedRouteMap, TEnv>,
      use?: () => InterceptUseItem[]
    ): InterceptItem;
  };
  /**
   * Attach middleware to the current route/layout
   * ```typescript
   * middleware(async (ctx, next) => {
   *   const session = await getSession(ctx.request);
   *   if (!session) return redirect("/login");
   *   ctx.set("user", session.user);
   *   next();
   * })
   *
   * // Chain multiple middleware
   * middleware(authMiddleware, loggingMiddleware, rateLimitMiddleware)
   * ```
   * @param fns - One or more middleware functions to execute in order
   */
  middleware: (...fns: MiddlewareFn<TEnv>[]) => MiddlewareItem;
  /**
   * Control when a segment should revalidate during navigation
   * ```typescript
   * // Revalidate when params change
   * revalidate(({ currentParams, nextParams }) =>
   *   currentParams.slug !== nextParams.slug
   * )
   *
   * // Revalidate after specific actions (actionId format: "path/to/file.ts#exportName")
   * revalidate(({ actionId }) =>
   *   actionId?.includes("Cart") ?? false
   * )
   *
   * // Soft decision (suggest but allow override)
   * revalidate(({ defaultShouldRevalidate }) =>
   *   ({ defaultShouldRevalidate: true })
   * )
   * ```
   * @param fn - Function that returns boolean (hard) or { defaultShouldRevalidate } (soft)
   */
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => RevalidateItem;
  /**
   * Attach a data loader to the current route/layout
   * ```typescript
   * loader(ProductLoader)
   *
   * // With loader-specific revalidation (match by file or export name)
   * loader(CartLoader, () => [
   *   revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
   * ])
   *
   * // Access loader data in handlers via ctx.use()
   * route("products.detail", async (ctx) => {
   *   const product = await ctx.use(ProductLoader);
   *   return <ProductPage product={product} />;
   * })
   * ```
   * @param loaderDef - Loader created with createLoader()
   * @param use - Optional callback for loader-specific revalidation rules
   */
  loader: <TData>(
    loaderDef: LoaderDefinition<TData>,
    use?: () => LoaderUseItem[]
  ) => LoaderItem;
  /**
   * Attach a loading component to the current route/layout
   * ```typescript
   * // Show loading on all requests (including SSR)
   * loading(<Skeleton />)
   *
   * // Skip loading on SSR, only show on client navigation
   * loading(<Skeleton />, { ssr: false })
   * ```
   * @param component - The loading UI to show during navigation
   * @param options - Configuration options
   * @param options.ssr - If false, skip showing loading on document requests (SSR)
   */
  loading: (component: ReactNode, options?: { ssr?: boolean }) => LoadingItem;
  /**
   * Attach an error boundary to catch errors in this segment and children
   * ```typescript
   * errorBoundary(<ErrorFallback />)
   *
   * // With dynamic error handler
   * errorBoundary(({ error, reset }) => (
   *   <div>
   *     <h2>Something went wrong</h2>
   *     <p>{error.message}</p>
   *     <button onClick={reset}>Try again</button>
   *   </div>
   * ))
   * ```
   * @param fallback - Static JSX or handler receiving error info and reset function
   */
  errorBoundary: (
    fallback: ReactNode | ErrorBoundaryHandler
  ) => ErrorBoundaryItem;
  /**
   * Attach a not-found boundary to handle notFound() calls in this segment
   * ```typescript
   * notFoundBoundary(<ProductNotFound />)
   *
   * // With dynamic handler
   * notFoundBoundary(({ notFound }) => (
   *   <div>
   *     <h2>{notFound.message}</h2>
   *     <a href="/products">Browse all products</a>
   *   </div>
   * ))
   * ```
   * @param fallback - Static JSX or handler receiving not-found info
   */
  notFoundBoundary: (
    fallback: ReactNode | NotFoundBoundaryHandler
  ) => NotFoundBoundaryItem;
  /**
   * Define a condition for when an intercept should activate
   *
   * Only valid inside intercept() use() callback. When multiple when() calls
   * are present, ALL must return true for the intercept to activate.
   * If no when() is defined, the intercept always activates on soft navigation.
   *
   * Context properties:
   * - `from` - Source URL (where user is navigating from)
   * - `to` - Destination URL (where user is navigating to)
   * - `params` - Matched route params
   * - `segments` - Client's current segments with `path` and `ids`
   *
   * ```typescript
   * // Only intercept when coming from the board page
   * intercept("@modal", "card", <CardModal />, () => [
   *   when(({ from }) => from.pathname.startsWith("/board")),
   *   loader(CardDetailLoader),
   * ])
   *
   * // Use segments to check current route context
   * intercept("@modal", "card", <CardModal />, () => [
   *   when(({ segments }) => segments.path[0] === "kanban"),
   * ])
   *
   * // Multiple conditions (AND logic)
   * intercept("@modal", "card", <CardModal />, () => [
   *   when(({ from }) => from.pathname.startsWith("/board")),
   *   when(({ segments }) => segments.ids.includes("kanban-layout")),
   * ])
   * ```
   * @param fn - Selector function receiving navigation context, returns boolean
   */
  when: (fn: InterceptWhenFn) => WhenItem;
  /**
   * Define cache configuration for segments
   *
   * Creates a cache boundary that applies to all children unless overridden.
   * Cache config inherits down the route tree like middleware wrapping.
   *
   * When ttl is not specified, uses store defaults (explicit store first,
   * then app-level store). When store is not specified, uses app-level store.
   *
   * Note: Loaders are NOT cached by default. Use cache() inside loader()
   * to explicitly opt-in to loader caching.
   *
   * ```typescript
   * // Using app-level defaults (ttl inherited from store.defaults)
   * cache(() => [
   *   layout(<BlogLayout />),      // cached with default TTL
   *   route("post/:slug"),         // cached with default TTL
   * ])
   *
   * // Cache all segments with explicit 60s TTL
   * cache({ ttl: 60 }, () => [
   *   layout(<BlogLayout />),      // cached
   *   route("post/:slug"),         // cached
   * ])
   *
   * // With stale-while-revalidate
   * cache({ ttl: 60, swr: 300 }, () => [
   *   route("product/:id"),
   * ])
   *
   * // Override for specific section
   * cache({ ttl: 60 }, () => [
   *   layout(<RootLayout />),
   *   cache({ ttl: 300 }, () => [
   *     route("static-page"),     // longer TTL
   *   ]),
   *   cache(false, () => [
   *     route("admin"),           // not cached
   *   ]),
   * ])
   *
   * // Use different store for specific routes
   * cache({ store: kvStore, ttl: 3600 }, () => [
   *   route("archive/:year"),     // uses KV store
   * ])
   *
   * // Opt-in loader caching
   * route("product/:id", ProductHandler, () => [
   *   loader(ProductLoader),               // NOT cached (default)
   *   loader(StaticMetadata, () => [
   *     cache({ ttl: 3600 }),              // cached for 1 hour
   *   ]),
   * ])
   * ```
   * @param optionsOrChildren - Cache options, false to disable, or children callback
   * @param children - Optional callback returning child segments (when first arg is options)
   */
  cache: {
    (): CacheItem;
    (children: () => AllUseItems[]): CacheItem;
    (
      options: PartialCacheOptions | false,
      use?: () => AllUseItems[]
    ): CacheItem;
  };
};

/**
 * Check if an item contains routes (directly or inside nested structures like cache).
 * Used to determine if a layout or cache should be treated as an orphan.
 */
const hasRoutesInItem = (item: AllUseItems): boolean => {
  if (item.type === "route") return true;
  // Lazy includes contain deferred routes — treat them as having routes
  // to prevent the parent layout from being misclassified as orphan,
  // which would clear its parent pointer and break the middleware chain.
  if (item.type === "include") return true;
  if (item.type === "cache" && item.uses) {
    return item.uses.some((child) => hasRoutesInItem(child));
  }
  if (item.type === "layout" && item.uses) {
    return item.uses.some((child) => hasRoutesInItem(child));
  }
  return false;
};

const revalidate: RouteHelpers<any, any>["revalidate"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("revalidate() must be called inside map()");

  // Attach to last entry in stack
  const parent = ctx.parent;
  if (!parent || !("revalidate" in parent)) {
    invariant(false, "No parent entry available for revalidate()");
  }
  const name = `$${getContext().getNextIndex("revalidate")}`;
  parent.revalidate.push(fn);
  return { name, type: "revalidate" } as RevalidateItem;
};

/**
 * Error boundary helper - attaches an error fallback to the current entry
 *
 * When an error occurs during rendering of this segment or its children,
 * the fallback will be rendered instead. The fallback can be:
 * - A static ReactNode (e.g., <ErrorPage />)
 * - A handler function that receives error info and reset function
 *
 * Error boundaries catch errors from:
 * - Middleware execution
 * - Loader execution
 * - Handler/component rendering
 *
 * @example
 * ```typescript
 * layout(<ShopLayout />, () => [
 *   errorBoundary(<ShopErrorFallback />),
 *   route("products.detail", ProductDetail),
 * ])
 *
 * // Or with handler for dynamic error UI:
 * route("products.detail", ProductDetail, () => [
 *   errorBoundary(({ error, reset }) => (
 *     <div>
 *       <h2>Product failed to load</h2>
 *       <p>{error.message}</p>
 *       <button onClick={reset}>Retry</button>
 *     </div>
 *   )),
 * ])
 * ```
 */
const errorBoundary: RouteHelpers<any, any>["errorBoundary"] = (fallback) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("errorBoundary() must be called inside map()");

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("errorBoundary" in parent)) {
    invariant(false, "No parent entry available for errorBoundary()");
  }
  const name = `$${getContext().getNextIndex("errorBoundary")}`;
  parent.errorBoundary.push(fallback);
  return { name, type: "errorBoundary" } as ErrorBoundaryItem;
};

/**
 * NotFound boundary helper - attaches a not-found fallback to the current entry
 *
 * When a DataNotFoundError is thrown (via notFound()) during rendering of this
 * segment or its children, the fallback will be rendered instead. The fallback can be:
 * - A static ReactNode (e.g., <ProductNotFound />)
 * - A handler function that receives not found info
 *
 * NotFound boundaries catch DataNotFoundError from:
 * - Loader execution
 * - Handler/component rendering
 *
 * @example
 * ```typescript
 * layout(<ShopLayout />, () => [
 *   notFoundBoundary(<ProductNotFound />),
 *   route("products.detail", ProductDetail),
 * ])
 *
 * // Or with handler for dynamic not found UI:
 * route("products.detail", ProductDetail, () => [
 *   notFoundBoundary(({ notFound }) => (
 *     <div>
 *       <h2>Product not found</h2>
 *       <p>{notFound.message}</p>
 *       <a href="/products">Browse all products</a>
 *     </div>
 *   )),
 * ])
 * ```
 */
const notFoundBoundary: RouteHelpers<any, any>["notFoundBoundary"] = (
  fallback
) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("notFoundBoundary() must be called inside map()");

  // Attach to parent entry in stack
  const parent = ctx.parent;
  if (!parent || !("notFoundBoundary" in parent)) {
    invariant(false, "No parent entry available for notFoundBoundary()");
  }
  const name = `$${getContext().getNextIndex("notFoundBoundary")}`;
  parent.notFoundBoundary.push(fallback);
  return { name, type: "notFoundBoundary" } as NotFoundBoundaryItem;
};

/**
 * When helper - defines a condition for intercept activation
 *
 * Only valid inside intercept() use() callback. The when() function
 * is captured by the intercept and stored in its `when` array.
 * During soft navigation, all when() conditions must return true
 * for the intercept to activate.
 */
const when: RouteHelpers<any, any>["when"] = (fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("when() must be called inside intercept()");

  // The when() function needs to be captured by the intercept's tempParent
  // which should have a `when` array. If not present, we're not inside intercept()
  const parent = ctx.parent as any;
  if (!parent || !("when" in parent)) {
    invariant(
      false,
      "when() can only be used inside intercept() use() callback"
    );
  }

  const name = `$${getContext().getNextIndex("when")}`;
  parent.when.push(fn);
  return { name, type: "when" } as WhenItem;
};

/**
 * Cache helper - defines caching configuration for segments
 *
 * Creates a cache boundary that applies to all children unless overridden.
 * When used without children, attaches cache config to the parent entry
 * (e.g., for loader-specific caching).
 *
 * Supports three call signatures:
 * - cache() - no args, uses app-level defaults (for loader caching)
 * - cache(() => [...]) - wraps children with app-level defaults
 * - cache({ ttl: 60 }, () => [...]) - with explicit options
 */
const cache: RouteHelpers<any, any>["cache"] = (
  optionsOrChildren?: PartialCacheOptions | false | (() => AllUseItems[]),
  maybeChildren?: () => AllUseItems[]
) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("cache() must be called inside map()");

  // Handle overloaded signature: cache(), cache(children), or cache(options, children)
  let options: PartialCacheOptions | false;
  let children: (() => AllUseItems[]) | undefined;

  if (optionsOrChildren === undefined) {
    // cache() - no args, use defaults
    options = {};
    children = undefined;
  } else if (typeof optionsOrChildren === "function") {
    // cache(() => [...]) - use empty options (will use defaults)
    options = {};
    children = optionsOrChildren;
  } else {
    // cache(options, children) - explicit options
    options = optionsOrChildren;
    children = maybeChildren;
  }

  const name = `$${store.getNextIndex("cache")}`;
  const cacheConfig = { options };

  // If no children, create an orphan cache entry (like orphan layouts)
  // This allows cache() to wrap subsequent siblings
  if (!children) {
    const parent = ctx.parent as any;

    // Check if we're inside a loader() use() callback - special case for loader caching
    if (parent && parent.type === "loader") {
      // Direct assignment to loader entry's cache field
      parent.cache = cacheConfig;
      return { name, type: "cache" } as CacheItem;
    }

    // Create orphan cache entry (like orphan layout)
    // Subsequent siblings in the same array will attach to this entry
    const namespace = `${ctx.namespace}.${store.getNextIndex("cache")}`;
    const cacheUrlPrefix = getUrlPrefix();

    const entry = {
      id: namespace,
      shortCode: store.getShortCode("cache"),
      type: "cache",
      parent: parent, // link to current parent for hierarchy
      cache: cacheConfig,
      handler: RootLayout,
      middleware: [],
      revalidate: [],
      errorBoundary: [],
      notFoundBoundary: [],
      layout: [],
      parallel: [],
      intercept: [],
      loader: [],
      ...(cacheUrlPrefix ? { mountPath: cacheUrlPrefix } : {}),
    } as EntryData;

    // Attach to parent's layout array (cache entries are structural like layouts)
    if (parent && "layout" in parent) {
      parent.layout.push(entry);
    }

    // Update context parent so subsequent siblings attach to this cache entry
    // This makes cache() act as sugar for cache(() => [...])
    ctx.parent = entry;

    return { name: namespace, type: "cache" } as CacheItem;
  }

  // With children: create a cache entry (like layout with caching semantics)
  const cacheNextIndex = store.getNextIndex("cache");
  const namespace = `${ctx.namespace}.${cacheNextIndex}`;
  const cacheShortCode = store.getShortCode("cache");

  const cacheUrlPrefix2 = getUrlPrefix();

  const entry = {
    id: namespace,
    shortCode: cacheShortCode,
    type: "cache",
    parent: ctx.parent,
    cache: cacheConfig,
    // Cache entries render like layouts (with Outlet as default handler)
    handler: RootLayout, // RootLayout just renders <Outlet />
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: [],
    intercept: [],
    loader: [],
    ...(cacheUrlPrefix2 ? { mountPath: cacheUrlPrefix2 } : {}),
  } as EntryData;

  // Run children with cache entry as parent
  const result = store.run(namespace, entry, children);

  invariant(
    Array.isArray(result) && result.every((item) => isValidUseItem(item)),
    `cache() children callback must return an array of use items [${namespace}]`
  );

  // Check if this cache has routes (including nested caches/layouts)
  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => hasRoutesInItem(item));

  if (!hasRoutes) {
    const parent = ctx.parent;
    if (parent && "layout" in parent) {
      // Attach to parent's layout array (cache entries are structural like layouts)
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  return { name: namespace, type: "cache", uses: result } as CacheItem;
};

const middleware: RouteHelpers<any, any>["middleware"] = (...fn) => {
  const ctx = getContext().getStore();
  if (!ctx) throw new Error("middleware() must be called inside map()");

  // Attach to last entry in stack
  const parent = ctx.parent;
  if (!parent || !("middleware" in parent)) {
    invariant(false, "No parent entry available for middleware()");
  }
  const name = `$${getContext().getNextIndex("middleware")}`;
  parent.middleware.push(...fn);
  return { name, type: "middleware" } as MiddlewareItem;
};

const parallel: RouteHelpers<any, any>["parallel"] = (slots, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("parallel() must be called inside map()");

  if (!ctx.parent || !ctx.parent?.parallel) {
    invariant(false, "No parent entry available for parallel()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "parallel() cannot be nested inside another parallel()"
  );

  const namespace = `${ctx.namespace}.$${store.getNextIndex("parallel")}`;

  // Unwrap any static handler definitions in parallel slots
  const unwrappedSlots: Record<string, any> = {};
  let hasStaticSlot = false;
  for (const [slotName, slotHandler] of Object.entries(slots as Record<string, any>)) {
    if (isStaticHandler(slotHandler)) {
      hasStaticSlot = true;
      unwrappedSlots[slotName] = slotHandler.handler;
    } else {
      unwrappedSlots[slotName] = slotHandler;
    }
  }

  // Create full EntryData for parallel with its own loaders/revalidate/loading
  const parallelUrlPrefix = getUrlPrefix();
  const entry = {
    id: namespace,
    shortCode: store.getShortCode("parallel"),
    type: "parallel",
    parent: null, // Parallels don't participate in parent chain traversal
    handler: unwrappedSlots,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: [],
    intercept: [],
    loader: [],
    ...(parallelUrlPrefix ? { mountPath: parallelUrlPrefix } : {}),
    ...(hasStaticSlot ? { isStaticPrerender: true as const } : {}),
  } satisfies EntryData;

  // Run use callback if provided to collect loaders, revalidate, loading
  if (use && typeof use === "function") {
    const result = store.run(namespace, entry, use);
    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `parallel() use() callback must return an array of use items [${namespace}]`
    );
  }

  ctx.parent.parallel.push(entry);
  return { name: namespace, type: "parallel" } as ParallelItem;
};

/**
 * Intercept helper - defines an intercepting route for soft navigation
 */
const intercept = (
  slotName: `@${string}`,
  routeName: string,
  handler: any,
  use?: () => any[]
) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("intercept() must be called inside map()");

  if (!ctx.parent || !ctx.parent?.intercept) {
    invariant(false, "No parent entry available for intercept()");
  }

  invariant(
    ctx.parent.type !== "parallel",
    "intercept() cannot be used inside parallel()"
  );

  const namespace = `${ctx.namespace}.$${store.getNextIndex("intercept")}.${slotName}`;

  // Dot-prefixed = local (add include prefix), unprefixed = global (use as-is)
  const isLocal = typeof routeName === "string" && routeName.startsWith(".");
  const bareRouteName = isLocal ? routeName.slice(1) : routeName;
  const namePrefix = getNamePrefix();
  const prefixedRouteName = isLocal && namePrefix ? `${namePrefix}.${bareRouteName}` : bareRouteName;

  // Create intercept entry with its own loaders/revalidate/middleware/when
  const entry: InterceptEntry = {
    slotName: slotName as `@${string}`,
    routeName: prefixedRouteName,
    handler,
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    loader: [],
    when: [], // Selector conditions for conditional interception
  };

  // Run use callback if provided to collect loaders, revalidate, middleware, etc.
  if (use && typeof use === "function") {
    // Create a temporary parent context for the use() callback
    // so that middleware, loader, revalidate attach to the intercept entry
    const originalParent = ctx.parent;

    // Capture layouts in a temporary array
    const capturedLayouts: EntryData[] = [];

    const tempParent = {
      ...originalParent,
      middleware: entry.middleware,
      revalidate: entry.revalidate,
      errorBoundary: entry.errorBoundary,
      notFoundBoundary: entry.notFoundBoundary,
      loader: entry.loader,
      layout: capturedLayouts, // Capture layout() calls
      when: entry.when, // Capture when() conditions
      // Use getter/setter to capture loading on the entry
      get loading() {
        return entry.loading;
      },
      set loading(value: ReactNode | false | undefined) {
        entry.loading = value;
      },
    };
    ctx.parent = tempParent as EntryData;

    const result = use();

    // Restore original parent
    ctx.parent = originalParent;

    // Extract layout from captured layouts (use first one if multiple)
    // Layout inside intercept should always be ReactNode or Handler, not Record slots
    if (capturedLayouts.length > 0 && capturedLayouts[0].type === "layout") {
      entry.layout = capturedLayouts[0].handler as
        | ReactNode
        | Handler<any, any, any>;
    }

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `intercept() use() callback must return an array of use items [${namespace}]`
    );
  }

  ctx.parent.intercept.push(entry);
  return { name: namespace, type: "intercept" } as InterceptItem;
};

/**
 * Loader helper - attaches a loader to the current entry
 */
const loaderFn: RouteHelpers<any, any>["loader"] = (loaderDef, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("loader() must be called inside map()");

  // Attach to last entry in stack
  if (!ctx.parent || !ctx.parent?.loader) {
    invariant(false, "No parent entry available for loader()");
  }

  const name = `${ctx.namespace}.$${store.getNextIndex("loader")}`;

  // Create loader entry with empty revalidate array
  const loaderEntry = {
    loader: loaderDef,
    revalidate: [] as ShouldRevalidateFn<any, any>[],
  };

  // If use() callback provided, run it to collect revalidation rules
  if (use && typeof use === "function") {
    // Temporarily set context for revalidate() calls to target this loader
    const originalParent = ctx.parent;
    // Create a temporary "parent" that has the revalidate array we want to populate
    const tempParent = {
      ...originalParent,
      revalidate: loaderEntry.revalidate,
    };
    ctx.parent = tempParent as EntryData;

    const result = use();

    // Restore original parent
    ctx.parent = originalParent;

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `loader() use() callback must return an array of use items [${name}]`
    );
  }

  ctx.parent.loader.push(loaderEntry);
  return { name, type: "loader" } as LoaderItem;
};

/**
 * Loading helper - attaches a loading component to the current entry
 * Loading components are static (no context) and shown during navigation
 */
const loadingFn: RouteHelpers<any, any>["loading"] = (component, options) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("loading() must be called inside map()");

  const parent = ctx.parent;
  if (!parent || !("loading" in parent)) {
    invariant(false, "No parent entry available for loading()");
  }

  // If ssr: false and we're in SSR, set loading to false
  if (options?.ssr === false && ctx.isSSR) {
    parent.loading = false;
  } else {
    parent.loading = component;
  }

  const name = `$${store.getNextIndex("loading")}`;
  return { name, type: "loading" } as LoadingItem;
};

const routeFn: RouteHelpers<any, any>["route"] = (name, handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("route() must be called inside map()");

  const namespace = `${ctx.namespace}.${store.getNextIndex("route")}.${name}`;

  const entry = {
    id: namespace,
    shortCode: store.getShortCode("route"),
    type: "route",
    parent: ctx.parent,
    handler,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    layout: [],
    parallel: [],
    intercept: [],
    loader: [],
  } satisfies EntryData;

  /* We will throw if user is registring same route name twice */
  invariant(
    ctx.manifest.get(name) === undefined,
    `Duplicate route name: ${name} at ${namespace}`
  );
  /* Register route entry */
  ctx.manifest.set(name, entry);
  /* Run use and attach handlers */
  if (use && typeof use === "function") {
    const result = store.run(namespace, entry, use);
    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `route() use() callback must return an array of use items [${namespace}]`
    );
    return { name: namespace, type: "route", uses: result } as RouteItem;
  }

  /* typesafe item */
  return { name: namespace, type: "route" } as RouteItem;
};

const layout: RouteHelpers<any, any>["layout"] = (handler, use) => {
  const store = getContext();
  const ctx = store.getStore();
  if (!ctx) throw new Error("layout() must be called inside map()");

  invariant(
    !ctx.parent || ctx.parent.type !== "parallel",
    "layout() cannot be used inside parallel()"
  );

  const isRoot = !ctx.parent || ctx.parent === null;
  const nextIndex = isRoot ? "$root" : store.getNextIndex("layout");
  const namespace = `${ctx.namespace}.${nextIndex}`;
  const shortCode = store.getShortCode("layout");

  // Unwrap static handler definition, extract the actual handler function
  const isStatic = isStaticHandler(handler);
  const unwrappedHandler = isStatic ? handler.handler : handler;

  const urlPrefix = getUrlPrefix();
  const entry = {
    id: namespace,
    shortCode,
    type: "layout",
    parent: ctx.parent,
    handler: unwrappedHandler,
    loading: undefined, // Allow loading() to attach loading state
    middleware: [],
    revalidate: [],
    errorBoundary: [],
    notFoundBoundary: [],
    parallel: [],
    intercept: [],
    layout: [],
    loader: [],
    ...(urlPrefix ? { mountPath: urlPrefix } : {}),
    ...(isStatic ? { isStaticPrerender: true as const } : {}),
  } satisfies EntryData;

  // Run use callback if provided
  let result: AllUseItems[] | undefined;
  if (use && typeof use === "function") {
    result = store.run(namespace, entry, use);

    invariant(
      Array.isArray(result) && result.every((item) => isValidUseItem(item)),
      `layout() use() callback must return an array of use items [${namespace}]`
    );
  }

  // Check if this is an orphan layout (no routes in children, including nested caches)
  const hasRoutes =
    result &&
    Array.isArray(result) &&
    result.some((item) => hasRoutesInItem(item));

  if (!hasRoutes) {
    // Orphan layouts must not contain other layouts as children.
    // If we're here, all child layouts are also orphan (if any had routes,
    // hasRoutesInItem would have returned true). Nested orphan chains are
    // confusing — use sibling orphan layouts instead.
    if (result) {
      invariant(
        !result.some((item) => item?.type === "layout"),
        `orphan layout cannot contain other layouts as children [${namespace}]`
      );
    }

    const parent = ctx.parent;

    // Allow orphan layouts at root level if they're part of map() builder result
    if (!parent || parent === null) {
      if (!isRoot) {
        invariant(
          false,
          `Orphan layout cannot be used at non-root level without parent [${namespace}]`
        );
      }
      // Root-level orphan is allowed (e.g., sibling layouts in map() builder)
    } else {
      // Has parent - register as orphan layout
      invariant(
        parent.type === "route" ||
          parent.type === "layout" ||
          parent.type === "cache",
        `Orphan layouts can only be defined inside route or layout > check [${namespace}]`
      );

      // Clear parent pointer for orphan layouts to prevent duplicate processing
      entry.parent = null;
      parent.layout.push(entry);
    }
  }

  if (result) {
    return { name: namespace, type: "layout", uses: result } as LayoutItem;
  }
  return {
    name: namespace,
    type: "layout",
  } as LayoutItem;
};

const isValidUseItem = (item: any): item is AllUseItems | undefined | null => {
  return (
    typeof item === "undefined" ||
    item === null ||
    (item &&
      typeof item === "object" &&
      "type" in item &&
      [
        "layout",
        "route",
        "middleware",
        "revalidate",
        "parallel",
        "intercept",
        "loader",
        "loading",
        "errorBoundary",
        "notFoundBoundary",
        "when",
        "cache",
        "include", // For urls() include() helper
      ].includes(item.type))
  );
};

const isOrphanLayout = (item: AllUseItems): boolean => {
  return (
    item.type === "layout" &&
    !item.uses?.some((child) => hasRoutesInItem(child))
  );
};

/*
 * Create revalidate helper
 */
const createRevalidateHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["revalidate"] => {
  return revalidate as RouteHelpers<any, TEnv>["revalidate"];
};

/**
 * Create errorBoundary helper
 */
const createErrorBoundaryHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["errorBoundary"] => {
  return errorBoundary as RouteHelpers<any, TEnv>["errorBoundary"];
};

/**
 * Create notFoundBoundary helper
 */
const createNotFoundBoundaryHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["notFoundBoundary"] => {
  return notFoundBoundary as RouteHelpers<any, TEnv>["notFoundBoundary"];
};

/**
 * Create middleware helper
 */
const createMiddlewareHelper = <TEnv>(): RouteHelpers<
  any,
  TEnv
>["middleware"] => {
  return middleware as RouteHelpers<any, TEnv>["middleware"];
};

/**
 * Create parallel helper
 */
const createParallelHelper = <TEnv>(): RouteHelpers<any, TEnv>["parallel"] => {
  return parallel as RouteHelpers<any, TEnv>["parallel"];
};

/**
 * Create intercept helper
 */
const createInterceptHelper = <
  const T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv>["intercept"] => {
  return intercept as RouteHelpers<T, TEnv>["intercept"];
};

/**
 * Create loader helper
 */
const createLoaderHelper = <TEnv>(): RouteHelpers<any, TEnv>["loader"] => {
  return loaderFn as RouteHelpers<any, TEnv>["loader"];
};

/**
 * Create loading helper
 */
const createLoadingHelper = (): RouteHelpers<any, any>["loading"] => {
  return loadingFn;
};

/**
 * Create route helper
 */
const createRouteHelper = <
  const T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv>["route"] => {
  return routeFn as unknown as RouteHelpers<T, TEnv>["route"];
};

/**
 * Create layout helper
 */
const createLayoutHelper = <TEnv>(): RouteHelpers<any, TEnv>["layout"] => {
  return layout as RouteHelpers<any, TEnv>["layout"];
};

/**
 * Create when helper for intercept conditions
 */
const createWhenHelper = (): RouteHelpers<any, any>["when"] => {
  return when;
};

/**
 * Create cache helper for cache configuration
 */
const createCacheHelper = (): RouteHelpers<any, any>["cache"] => {
  return cache;
};

/**
 * Branded type for route handlers that carries the route type info.
 * This enables type-safe verification that imported handlers match route definitions.
 */
export interface RouteHandlers<T extends RouteDefinition> {
  (): Array<AllUseItems>;
  /** Brand to carry route type info for type checking */
  readonly __routes: T;
}

/**
 * Type-safe handler definition helper
 *
 */
export function map<const T extends RouteDefinition, TEnv = DefaultEnv>(
  builder: (helpers: RouteHelpers<T, TEnv>) => Array<AllUseItems>
): RouteHandlers<T> {
  const handler = () => {
    // Check if it's a builder function (array-based API)
    invariant(
      typeof builder === "function",
      "map() expects a builder function as its argument"
    );
    // Create helpers
    const helpers: RouteHelpers<T, TEnv> = {
      route: createRouteHelper<T, TEnv>(),
      layout: createLayoutHelper<TEnv>(),
      parallel: createParallelHelper<TEnv>(),
      intercept: createInterceptHelper<T, TEnv>(),
      middleware: createMiddlewareHelper<TEnv>(),
      revalidate: createRevalidateHelper<TEnv>(),
      loader: createLoaderHelper<TEnv>(),
      loading: createLoadingHelper(),
      errorBoundary: createErrorBoundaryHelper<TEnv>(),
      notFoundBoundary: createNotFoundBoundaryHelper<TEnv>(),
      when: createWhenHelper(),
      cache: createCacheHelper(),
    };

    return [layout(RootLayout, () => builder(helpers))].flat(3);
  };
  // Cast to RouteHandlers to carry the route type brand
  return handler as RouteHandlers<T>;
}

/**
 * Create RouteHelpers for inline route definitions
 * Used internally by router.map() for inline handler syntax
 */
export function createRouteHelpers<
  T extends RouteDefinition,
  TEnv,
>(): RouteHelpers<T, TEnv> {
  return {
    route: createRouteHelper<T, TEnv>(),
    layout: createLayoutHelper<TEnv>(),
    parallel: createParallelHelper<TEnv>(),
    intercept: createInterceptHelper<T, TEnv>(),
    middleware: createMiddlewareHelper<TEnv>(),
    revalidate: createRevalidateHelper<TEnv>(),
    loader: createLoaderHelper<TEnv>(),
    loading: createLoadingHelper(),
    errorBoundary: createErrorBoundaryHelper<TEnv>(),
    notFoundBoundary: createNotFoundBoundaryHelper<TEnv>(),
    when: createWhenHelper(),
    cache: createCacheHelper(),
  };
}

/**
 * Create a loader definition
 *
 * Loaders are RSC-compatible data fetchers that:
 * - Run after middleware, before handlers
 * - Are scoped to where attached (layout/route subtree)
 * - Revalidate independently from UI segments
 * - Are memoized per request (multiple ctx.use() calls return same value)
 *
 * Use the `"use server"` directive inside the loader function to ensure
 * the function is stripped from client bundles.
 *
 * Return type is automatically inferred from the callback.
 *
 * @param fn - Async function that fetches data (should contain "use server" directive)
 * @param fetchable - Optional flag to make the loader fetchable via useFetchLoader
 *
 * @example
 * ```typescript
 * // loaders/cart.ts - return type inferred from callback
 * export const CartLoader = createLoader(async (ctx) => {
 *   "use server";
 *   const user = ctx.get("user");
 *   return await db.cart.get(user.id); // Return type inferred!
 * });
 *
 * // loaders/product.ts - return type inferred
 * export const ProductLoader = createLoader(async (ctx) => {
 *   "use server";
 *   const { slug } = ctx.params;
 *   return await db.products.findBySlug(slug); // Return type inferred!
 * });
 *
 * // Usage in handlers
 * layout(<ShopLayout />, () => [
 *   loader(CartLoader),
 *   loader(CartLoader, () => [
 *     revalidate(({ actionId }) => actionId?.includes("Cart") ?? false),
 *   ]),
 * ])
 *
 * // Server-side access
 * route("cart", (ctx) => {
 *   const cart = ctx.use(CartLoader);
 *   return <CartPage cart={cart} />;
 * });
 *
 * // Client-side access
 * const cart = useLoader(CartLoader);
 * ```
 */
// Re-export createLoader from loader.rsc.ts for RSC/server context
export { createLoader } from "./loader.rsc.js";

/**
 * Create a soft redirect Response for middleware short-circuit
 *
 * Returns a Response that signals a client-side navigation to the target URL.
 * Unlike Response.redirect() which causes a full page reload, this redirect
 * is handled by the router for SPA-style navigation.
 *
 * @param url - The URL to redirect to
 * @param status - HTTP status code (default: 302)
 *
 * @example
 * ```typescript
 * middleware((ctx, next) => {
 *   if (!ctx.get('user')) {
 *     return redirect('/login');
 *   }
 *   next();
 * })
 * ```
 */
export function redirect(url: string, status: number = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: url,
      "X-RSC-Redirect": "soft",
    },
  });
}
