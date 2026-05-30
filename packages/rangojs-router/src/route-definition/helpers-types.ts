import type { ReactNode } from "react";
import type {
  ExtractRouteParams,
  Handler,
  PartialCacheOptions,
  ErrorBoundaryHandler,
  LoaderDefinition,
  MiddlewareFn,
  NotFoundBoundaryHandler,
  ResolvedRouteMap,
  RouteDefinition,
  ShouldRevalidateFn,
  TransitionConfig,
} from "../types.js";
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
  TransitionItem,
  UseItems,
} from "../route-types.js";
import type { InterceptWhenFn } from "../server/context";

// Re-export route item types for backward compatibility
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
} from "../route-types.js";

// Re-export intercept selector types for use in handlers
export type {
  InterceptSelectorContext,
  InterceptSegmentsState,
  InterceptWhenFn,
} from "../server/context";

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
    use?: () => UseItems<RouteUseItem>,
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
    use?: () => UseItems<LayoutUseItem>,
  ) => LayoutItem;
  /**
   * Define parallel routes that render simultaneously in named slots
   * ```typescript
   * parallel({
   *   "@sidebar": <Sidebar />,
   *   "@main": async (ctx) => <MainContent data={ctx.use(DataLoader)} />,
   * })
   *
   * // With loaders and loading states (broadcast to every slot)
   * parallel({
   *   "@analytics": AnalyticsPanel,
   *   "@metrics": MetricsPanel,
   * }, () => [
   *   loader(DashboardLoader),
   *   loading(<DashboardSkeleton />),
   * ])
   *
   * // Per-slot scoped use via slot descriptor — for single-assignment items
   * // like loading() that should not broadcast to siblings.
   * parallel({
   *   "@meta": MetaSlot,
   *   "@sidebar": {
   *     handler: SidebarSlot,
   *     use: () => [loading(<SidebarSkeleton />)],
   *   },
   * })
   * ```
   * @param slots - Object with slot names (prefixed with @) mapped to handlers
   *                or `{ handler, use? }` slot descriptors.
   * @param use - Optional callback for loaders, loading, revalidate, etc.
   *              Items here apply to every slot in the call (broadcast).
   *              For per-slot single-assignment items, use the slot descriptor's
   *              own `use` callback — slot-local items run after the broadcast,
   *              so they take precedence on `loading()` and other last-write-wins
   *              fields.
   */
  parallel: <
    TSlots extends Record<
      `@${string}`,
      | Handler<any, any, TEnv>
      | ReactNode
      | {
          handler: Handler<any, any, TEnv> | ReactNode;
          use?: () => UseItems<ParallelUseItem>;
        }
    >,
  >(
    slots: TSlots,
    use?: () => UseItems<ParallelUseItem>,
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
      use?: () => UseItems<InterceptUseItem>,
    ): InterceptItem;
    // Global: unprefixed, params inferred from global route map
    <K extends keyof Rango.GeneratedRouteMap & string>(
      slotName: `@${string}`,
      routeName: K,
      handler: ReactNode | Handler<K, Rango.GeneratedRouteMap, TEnv>,
      use?: () => UseItems<InterceptUseItem>,
    ): InterceptItem;
  };
  /**
   * Attach middleware to the current route/layout, or wrap child segments
   *
   * **Sibling mode** — attaches middleware to the parent entry:
   * ```typescript
   * layout(<DashboardShell />, () => [
   *   middleware(authMiddleware),
   *   middleware([authMiddleware, loggingMiddleware]),
   *   path("/", DashboardPage),
   * ])
   * ```
   *
   * **Wrapping mode** — scopes middleware to the children only:
   * ```typescript
   * middleware(authMiddleware, () => [
   *   path("/dashboard", DashboardPage),
   *   path("/settings", SettingsPage),
   * ])
   *
   * middleware([authMiddleware, loggingMiddleware], () => [
   *   path("/admin", AdminPage),
   * ])
   * ```
   */
  middleware: {
    (fn: MiddlewareFn<TEnv>): MiddlewareItem;
    (
      fn: MiddlewareFn<TEnv>,
      children: () => UseItems<LayoutUseItem>,
    ): MiddlewareItem;
    (fns: MiddlewareFn<TEnv>[]): MiddlewareItem;
    (
      fns: MiddlewareFn<TEnv>[],
      children: () => UseItems<LayoutUseItem>,
    ): MiddlewareItem;
  };
  /**
   * Control when a segment should revalidate during navigation
   * ```typescript
   * // Revalidate when params change
   * revalidate(({ currentParams, nextParams }) =>
   *   currentParams.slug !== nextParams.slug
   * )
   *
   * // Revalidate after specific actions (actionId format: "path/to/file.ts#exportName")
   * // Use `|| undefined` (defer), not `?? false` (hard short-circuit), so the
   * // chain and the segment default still apply when there is no match.
   * revalidate(({ actionId }) =>
   *   actionId?.includes("Cart") || undefined
   * )
   *
   * // Soft decision (suggest but allow override)
   * revalidate(({ defaultShouldRevalidate }) =>
   *   ({ defaultShouldRevalidate: true })
   * )
   * ```
   * @param fn - Function returning either:
   *   - `boolean` (hard decision — short-circuits the chain),
   *   - `{ defaultShouldRevalidate: boolean }` (soft — updates the suggestion
   *     for downstream revalidators),
   *   - or nothing / `null` / `undefined` (defer — leaves the suggestion
   *     unchanged and continues to the next revalidator).
   */
  revalidate: (fn: ShouldRevalidateFn<any, TEnv>) => RevalidateItem;
  /**
   * Attach a data loader to the current route/layout
   * ```typescript
   * loader(ProductLoader)
   *
   * // With loader-specific revalidation (match by file or export name)
   * loader(CartLoader, () => [
   *   revalidate(({ actionId }) => actionId?.includes("Cart") || undefined),
   * ])
   *
   * // Consume in client components with useLoader()
   * // (preferred — cache-safe, always fresh)
   * function ProductDetails() {
   *   const { data } = useLoader(ProductLoader);
   *   return <div>{data.name}</div>;
   * }
   * ```
   * @param loaderDef - Loader created with createLoader()
   * @param use - Optional callback for loader-specific revalidation rules
   */
  loader: <TData>(
    loaderDef: LoaderDefinition<TData>,
    use?: () => UseItems<LoaderUseItem>,
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
  loading: (
    component: ReactNode | (() => ReactNode),
    options?: { ssr?: boolean },
  ) => LoadingItem;
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
    fallback: ReactNode | ErrorBoundaryHandler,
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
    fallback: ReactNode | NotFoundBoundaryHandler,
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
    (children: () => UseItems<AllUseItems>): CacheItem;
    (profileName: string): CacheItem;
    (profileName: string, use: () => UseItems<AllUseItems>): CacheItem;
    (
      options: PartialCacheOptions | false,
      use?: () => UseItems<AllUseItems>,
    ): CacheItem;
  };
  /**
   * Attach a ViewTransition boundary to the current segment or a group of routes,
   * and opt the route into same-route stale-while-revalidate navigation.
   *
   * Two effects, both opt-in via this helper:
   * - Same-route navigation (same route, different params, e.g. /product/1 ->
   *   /product/2) reconciles the route subtree instead of remounting it, so the
   *   previous content is held while the new loader resolves rather than flashing
   *   the route's loading() skeleton. This works on ALL React versions (it is
   *   plain startTransition + Suspense; see segment-system.tsx inTransitionScope).
   * - On React experimental, the segment content is additionally wrapped in
   *   `<ViewTransition>`, so the held same-route swap animates (update/share
   *   morph) and cross-route swaps animate exit/enter. The animation layer is a
   *   no-op on stable React; the content-hold is not.
   *
   * ```typescript
   * // Attach to a single route
   * path("/about", AboutPage, { name: "about" }, () => [
   *   transition({ enter: "fade-in", exit: "fade-out" }),
   * ])
   *
   * // Wrap a group of routes
   * transition({ enter: "fade-in", exit: "fade-out" }, () => [
   *   path("/", HomePage),
   *   path("/about", AboutPage),
   * ])
   *
   * // Direction-aware transitions
   * transition({
   *   enter: { "navigation": "slide-right", "navigation-back": "slide-left" },
   *   exit: { "navigation": "slide-left", "navigation-back": "slide-right" },
   * })
   * ```
   * @param config - ViewTransition configuration (enter, exit, update, share, default, name)
   * @param children - Optional callback returning child routes to wrap
   */
  transition: {
    (config: TransitionConfig): TransitionItem;
    (
      config: TransitionConfig,
      children: () => UseItems<AllUseItems>,
    ): TransitionItem;
  };
};
