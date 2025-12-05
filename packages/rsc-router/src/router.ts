import {
  Suspense,
  createElement,
  isValidElement,
  cloneElement,
  type ReactNode,
  type ReactElement,
} from "react";
import {
  invariant,
  RouteNotFoundError,
  DataNotFoundError,
  sanitizeError,
} from "./errors";
import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
  HandlerContext,
  ResolvedSegment,
  MatchResult,
  RouteEntry,
  Handler,
  LoaderDefinition,
  LoaderContext,
  ErrorInfo,
  ErrorBoundaryHandler,
  ErrorBoundaryFallbackProps,
  NotFoundInfo,
  NotFoundBoundaryHandler,
  NotFoundBoundaryFallbackProps,
  LoaderDataResult,
} from "./types";
import type { AllUseItems } from "./route-types.js";
import {
  EntryData,
  LoaderEntry,
  InterceptEntry,
  getContext,
  track,
  MetricsStore,
  PerformanceMetric,
} from "./server/context";
import { error } from "console";
import {
  createHref,
  type HrefFunction,
  type PrefixedRoutes,
  type SanitizePrefix,
} from "./href.js";
import { registerRouteMap } from "./route-map-builder.js";
import { DefaultErrorFallback } from "./default-error-boundary.js";

// Extracted router utilities
import {
  createMetricsStore,
  logMetrics,
  generateServerTiming,
} from "./router/metrics.js";
import {
  findNearestErrorBoundary as findErrorBoundary,
  findNearestNotFoundBoundary as findNotFoundBoundary,
  createErrorInfo,
  createErrorSegment,
  createNotFoundInfo,
  createNotFoundSegment,
} from "./router/error-handling.js";
import { createHandlerContext } from "./router/handler-context.js";
import {
  compilePattern,
  findMatch as findRouteMatch,
  traverseBack,
} from "./router/pattern-matching.js";
import { executeMiddleware } from "./router/middleware.js";
import {
  wrapLoaderWithErrorHandling,
  setupLoaderAccess,
  revalidate,
} from "./router/loader-resolution.js";
import { evaluateRevalidation } from "./router/revalidation.js";
import { loadManifest } from "./router/manifest.js";
import type {
  LoaderRevalidationResult,
  SegmentRevalidationResult,
  ActionContext,
} from "./router/types.js";

/**
 * Router configuration options
 */
export interface RSCRouterOptions {
  /**
   * Enable performance metrics collection
   * When enabled, metrics are output to console and available via Server-Timing header
   */
  debugPerformance?: boolean;

  /**
   * Default error boundary fallback used when no error boundary is defined in the route tree
   * If not provided, errors will propagate and crash the request
   */
  defaultErrorBoundary?: ReactNode | ErrorBoundaryHandler;

  /**
   * Default not-found boundary fallback used when no notFoundBoundary is defined in the route tree
   * If not provided, DataNotFoundError will be treated as a regular error
   */
  defaultNotFoundBoundary?: ReactNode | NotFoundBoundaryHandler;
}

/**
 * Router builder for chaining .use() and .map()
 * TRoutes accumulates all registered route types through the chain
 */
interface RouteBuilder<
  T extends RouteDefinition,
  TEnv,
  TRoutes extends Record<string, string>,
> {
  map(
    handler: () =>
      | Array<AllUseItems>
      | Promise<{ default: () => Array<AllUseItems> }>
      | Promise<() => Array<AllUseItems>>
  ): RSCRouter<TEnv, TRoutes>;

  /**
   * Accumulated route map for typeof extraction
   * Used for module augmentation: `type AppRoutes = typeof _router.routeMap`
   */
  readonly routeMap: TRoutes;
}

/**
 * RSC Router interface
 * TRoutes accumulates all registered route types through the builder chain
 */
export interface RSCRouter<
  TEnv = any,
  TRoutes extends Record<string, string> = Record<string, string>,
> {
  /**
   * Register routes with a prefix
   * Route types are accumulated through the chain
   */
  routes<TPrefix extends string, T extends ResolvedRouteMap<any>>(
    prefix: TPrefix,
    routes: T
  ): RouteBuilder<
    RouteDefinition,
    TEnv,
    TRoutes & PrefixedRoutes<T, SanitizePrefix<TPrefix>>
  >;

  /**
   * Register routes without a prefix
   * Route types are accumulated through the chain
   */
  routes<T extends ResolvedRouteMap<any>>(
    routes: T
  ): RouteBuilder<RouteDefinition, TEnv, TRoutes & T>;

  /**
   * Type-safe URL builder for registered routes
   * Types are inferred from the accumulated route registrations
   *
   * @example
   * ```typescript
   * router.href("shop.cart"); // "/shop/cart"
   * router.href("shop.products.detail", { slug: "widget" }); // "/shop/product/widget"
   * ```
   */
  href: HrefFunction<TRoutes>;

  /**
   * Accumulated route map for typeof extraction
   * Used for module augmentation: `type AppRoutes = typeof _router.routeMap`
   *
   * @example
   * ```typescript
   * const _router = createRSCRouter<AppEnv>()
   *   .routes(homeRoutes).map(() => import('./home'))
   *   .routes('/shop', shopRoutes).map(() => import('./shop'));
   *
   * type AppRoutes = typeof _router.routeMap;
   *
   * declare global {
   *   namespace RSCRouter {
   *     interface RegisteredRoutes extends AppRoutes {}
   *   }
   * }
   * ```
   */
  readonly routeMap: TRoutes;

  match(request: Request, context: TEnv): Promise<MatchResult>;

  matchPartial(
    request: Request,
    context: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    }
  ): Promise<MatchResult | null>;

  /**
   * Match an error to the nearest error boundary and return error segments
   *
   * Used when an action or other operation fails and we need to render
   * the error boundary UI. Finds the nearest errorBoundary in the route tree
   * for the current URL and renders it with the error info.
   *
   * @param request - The current request (used to match the route)
   * @param context - Environment context
   * @param error - The error that occurred
   * @param segmentType - Type of segment where error occurred (default: "route")
   * @returns MatchResult with error segment, or null if no error boundary found
   */
  matchError(
    request: Request,
    context: TEnv,
    error: unknown,
    segmentType?: ErrorInfo["segmentType"]
  ): Promise<MatchResult | null>;
}

/**
 * Create an RSC router with generic context type
 * Route types are accumulated automatically through the builder chain
 *
 * @example
 * ```typescript
 * interface AppContext {
 *   db: Database;
 *   user?: User;
 * }
 *
 * const router = createRSCRouter<AppContext>({
 *   debugPerformance: true  // Enable metrics
 * });
 *
 * // Route types accumulate through the chain - no module augmentation needed!
 * router
 *   .routes(homeRoutes)          // accumulates homeRoutes
 *   .map(() => import('./home'))
 *   .routes('/shop', shopRoutes) // accumulates PrefixedRoutes<shopRoutes, "shop">
 *   .map(() => import('./shop'));
 *
 * // router.href now has type-safe autocomplete for all registered routes
 * router.href("shop.cart");
 * ```
 */
export function createRSCRouter<TEnv = any>(
  options: RSCRouterOptions = {}
): RSCRouter<TEnv, {}> {
  const {
    debugPerformance = false,
    defaultErrorBoundary,
    defaultNotFoundBoundary,
  } = options;
  const routesEntries: RouteEntry<TEnv>[] = [];
  let mountIndex = 0;

  // Track all registered routes with their prefixes for href()
  const mergedRouteMap: Record<string, string> = {};

  // Wrapper to pass debugPerformance to external createMetricsStore
  const getMetricsStore = () => createMetricsStore(debugPerformance);

  // Wrapper to pass defaults to error/notFound boundary finders
  const findNearestErrorBoundary = (entry: EntryData | null) =>
    findErrorBoundary(entry, defaultErrorBoundary);

  const findNearestNotFoundBoundary = (entry: EntryData | null) =>
    findNotFoundBoundary(entry, defaultNotFoundBoundary);

  // Wrapper for wrapLoaderWithErrorHandling that uses router's error boundary finder
  function wrapLoaderPromise<T>(
    promise: Promise<T>,
    entry: EntryData,
    segmentId: string,
    pathname: string
  ): Promise<LoaderDataResult<T>> {
    return wrapLoaderWithErrorHandling(
      promise,
      entry,
      segmentId,
      pathname,
      findNearestErrorBoundary,
      createErrorInfo
    );
  }

  // Wrapper for findMatch that uses routesEntries
  function findMatch(pathname: string) {
    return findRouteMatch(pathname, routesEntries);
  }

  /**
   * Resolve loaders for an entry and emit segments
   * Loaders are run lazily via ctx.use() and memoized for parallel execution
   *
   * @param shortCodeOverride - Optional override for the shortCode used in segment IDs.
   *   For parallel entries, pass the parent layout/route's shortCode so loaders
   *   are correctly associated in the segment tree.
   */
  function resolveLoaders(
    entry: EntryData,
    ctx: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    shortCodeOverride?: string
  ): ResolvedSegment[] {
    const loaderEntries = entry.loader ?? [];
    if (loaderEntries.length === 0) return [];

    const shortCode = shortCodeOverride ?? entry.shortCode;

    // Trigger all loaders in parallel via ctx.use() (memoized, so safe to call multiple times)
    // Don't await - wrap promises with error handling for deferred client-side resolution
    return loaderEntries.map(({ loader }, i) => {
      const segmentId = `${shortCode}D${i}.${loader.name}`;
      return {
        id: segmentId,
        namespace: entry.id,
        type: "loader" as const,
        index: i,
        component: null, // Loaders don't render directly
        params: ctx.params,
        loaderName: loader.name,
        loaderData: wrapLoaderPromise(
          ctx.use(loader),
          entry,
          segmentId,
          ctx.pathname
        ),
        belongsToRoute,
      };
    });
  }

  /**
   * Result of resolving loaders with revalidation
   * Contains both segments to render and all matched segment IDs
   */
  interface LoaderRevalidationResult {
    segments: ResolvedSegment[];
    matchedIds: string[];
  }

  /**
   * Resolve loaders with revalidation awareness (for partial rendering)
   * Checks each loader's revalidation functions before deciding to emit segment
   * Loaders are run lazily via ctx.use() - this function only handles segment emission
   * Returns both segments to render AND all matched segment IDs (including skipped ones)
   *
   * @param shortCodeOverride - Optional override for the shortCode used in segment IDs.
   *   For parallel entries, pass the parent layout/route's shortCode so loaders
   *   are correctly associated in the segment tree.
   */
  async function resolveLoadersWithRevalidation(
    entry: EntryData,
    ctx: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    },
    shortCodeOverride?: string
  ): Promise<LoaderRevalidationResult> {
    const loaderEntries = entry.loader ?? [];
    if (loaderEntries.length === 0) return { segments: [], matchedIds: [] };

    const shortCode = shortCodeOverride ?? entry.shortCode;

    // Build segment IDs and matchedIds upfront
    const loaderMeta = loaderEntries.map(
      ({ loader, revalidate: loaderRevalidateFns }, i) => ({
        loader,
        loaderRevalidateFns,
        segmentId: `${shortCode}D${i}.${loader.name}`,
        index: i,
      })
    );

    const matchedIds = loaderMeta.map((m) => m.segmentId);

    // Phase 1: Check all revalidation in parallel
    const revalidationChecks = await Promise.all(
      loaderMeta.map(
        async ({ loader, loaderRevalidateFns, segmentId, index }) => {
          const shouldRun = await revalidate(
            async () => {
              // New segment - always run
              if (!clientSegmentIds.has(segmentId)) return true;

              // Create dummy segment for evaluation
              const dummySegment: ResolvedSegment = {
                id: segmentId,
                namespace: entry.id,
                type: "loader",
                index,
                component: null,
                params: ctx.params,
                loaderName: loader.name,
                belongsToRoute,
              };

              // Evaluate loader's revalidation functions
              return await evaluateRevalidation(
                dummySegment,
                prevParams,
                null,
                request,
                prevUrl,
                nextUrl,
                loaderRevalidateFns.map((fn, j) => ({
                  name: `loader-revalidate${j}`,
                  fn,
                })),
                routeKey,
                ctx,
                actionContext
              );
            },
            async () => true,
            () => false
          );
          return { shouldRun, loader, segmentId, index };
        }
      )
    );

    // Phase 2: Build segments for loaders that need revalidation
    // Don't await - wrap promises with error handling for deferred client-side resolution
    const loadersToRun = revalidationChecks.filter((c) => c.shouldRun);
    const segments: ResolvedSegment[] = loadersToRun.map(
      ({ loader, segmentId, index }) => ({
        id: segmentId,
        namespace: entry.id,
        type: "loader" as const,
        index,
        component: null,
        params: ctx.params,
        loaderName: loader.name,
        loaderData: wrapLoaderPromise(
          ctx.use(loader),
          entry,
          segmentId,
          ctx.pathname
        ),
        belongsToRoute,
      })
    );

    return { segments, matchedIds };
  }
  /**
   * Resolve segments from EntryData
   * Executes middlewares, loaders, parallels, and handlers in correct order
   * Returns array: [main segment, ...orphan layout segments]
   */
  async function resolveSegment(
    entry: EntryData,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    isRouteEntry: boolean = false
  ): Promise<ResolvedSegment[]> {
    const segments: ResolvedSegment[] = [];

    if (entry.type === "layout") {
      // Layout execution order:
      // 1. Layout MW → 2. Layout Loader → 3. Layout Parallels (emit segments) → 4. Layout Handler (emit segment) → 5. Orphan Layouts

      // Step 1: Run layout middleware
      if (entry.middleware.length > 0) {
        const middlewareResponse = await executeMiddleware(
          entry.middleware,
          context,
          entry.id
        );
        if (middlewareResponse) throw middlewareResponse;
      }

      // Step 2: Run layout loaders
      const loaderSegments = await resolveLoaders(
        entry,
        context,
        false // Parent chain layouts don't belong to specific route
      );
      segments.push(...loaderSegments);

      // Step 3: Process and emit layout parallel segments
      for (const parallelEntry of entry.parallel) {
        const parallelSegments = await resolveParallelEntry(
          parallelEntry,
          params,
          context,
          false, // Parent chain parallels don't belong to specific route
          entry.shortCode // Pass parent layout's shortCode for segment ID association
        );
        segments.push(...parallelSegments);
      }

      // Step 4: Execute layout handler and emit layout segment
      const component =
        typeof entry.handler === "function"
          ? await entry.handler(context)
          : entry.handler;

      segments.push({
        id: entry.shortCode,
        namespace: entry.id,
        type: "layout",
        index: 0,
        component,
        loading: entry.loading === false ? null : entry.loading,
        params,
        belongsToRoute: false, // Parent chain layouts don't belong to specific route
        layoutName: entry.id,
      });

      // Step 5: Process orphan layouts
      for (const orphan of entry.layout) {
        const orphanSegments = await resolveOrphanLayout(
          orphan,
          params,
          context,
          loaderPromises,
          false // Parent chain layouts don't belong to specific route
        );
        segments.push(...orphanSegments);
      }
    } else if (entry.type === "route") {
      // Route execution order:
      // 1. Route MW → 2. Route Loader → 3. Orphan Layouts → 4. Route Parallels (emit segments) → 5. Route Handler (emit segment)

      // Step 1: Run route middleware
      if (entry.middleware.length > 0) {
        const middlewareResponse = await executeMiddleware(
          entry.middleware,
          context,
          entry.id
        );
        if (middlewareResponse) throw middlewareResponse;
      }

      // Step 2: Run route loaders
      const loaderSegments = await resolveLoaders(
        entry,
        context,
        true // Route loaders belong to the route
      );
      segments.push(...loaderSegments);

      // Step 3: Process orphan layouts first
      for (const orphan of entry.layout) {
        const orphanSegments = await resolveOrphanLayout(
          orphan,
          params,
          context,
          loaderPromises,
          true // Route's orphan layouts belong to the route
        );
        segments.push(...orphanSegments);
      }

      // Step 4: Process and emit route parallel segments
      for (const parallelEntry of entry.parallel) {
        const parallelSegments = await resolveParallelEntry(
          parallelEntry,
          params,
          context,
          true, // Route's parallels belong to the route
          entry.shortCode // Pass parent route's shortCode for segment ID association
        );
        segments.push(...parallelSegments);
      }

      // Step 5: Execute route handler and emit route segment
      // If loading is defined, wrap in Suspense for RSC streaming
      // This allows the fallback to be sent immediately while content streams in
      let component = entry.loading
        ? entry.handler(context)
        : await entry.handler(context);

      segments.push({
        id: entry.shortCode,
        namespace: entry.id,
        type: "route",
        index: 0,
        component,
        loading: entry.loading === false ? null : entry.loading,
        params,
        belongsToRoute: true, // Route always belongs to itself
      });
    } else {
      throw new Error(`Unknown entry type: ${(entry as any).type}`);
    }

    return segments;
  }

  /**
   * Helper: Resolve orphan layout with its middlewares, loaders, and parallels
   */
  async function resolveOrphanLayout(
    orphan: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    belongsToRoute: boolean
  ): Promise<ResolvedSegment[]> {
    // Orphans must always be layouts
    invariant(
      orphan.type === "layout",
      `Expected orphan to be a layout, got: ${orphan.type}`
    );

    // Orphan MW → Orphan Loader → Orphan Parallels → Orphan Handler

    // Step 1: Run orphan middleware
    if (orphan.middleware.length > 0) {
      const middlewareResponse = await executeMiddleware(
        orphan.middleware,
        context,
        orphan.id
      );
      if (middlewareResponse) throw middlewareResponse;
    }

    // Step 2: Run orphan loaders
    const loaderSegments = await resolveLoaders(
      orphan,
      context,
      belongsToRoute
    );

    // Step 3: Process and emit orphan parallel segments
    const segments: ResolvedSegment[] = [...loaderSegments];
    for (const parallelEntry of orphan.parallel) {
      const parallelSegments = await resolveParallelEntry(
        parallelEntry,
        params,
        context,
        belongsToRoute,
        orphan.shortCode // Pass parent orphan layout's shortCode for segment ID association
      );
      segments.push(...parallelSegments);
    }

    // Step 4: Execute orphan handler and emit layout segment
    const component =
      typeof orphan.handler === "function"
        ? await orphan.handler(context)
        : orphan.handler;

    segments.push({
      id: orphan.shortCode,
      namespace: orphan.id,
      type: "layout",
      index: 0,
      component,
      params,
      belongsToRoute,
      layoutName: orphan.id,
      loading: orphan.loading === false ? null : orphan.loading,
    });

    return segments;
  }

  /**
   * Find an intercept for the target route by walking up the entry chain
   * Returns the first (innermost) matching intercept along with the entry that defines it
   *
   * Intercepts are "lazy parallels" that only activate during soft navigation.
   * They render alternative content in a named slot (like @modal) instead of the
   * route's normal handler.
   *
   * @param targetRouteKey - The route key to find an intercept for (e.g., "card")
   * @param fromEntry - Starting entry to walk up from (usually the route entry)
   * @returns The matching intercept and its defining entry, or null if none found
   */
  function findInterceptForRoute(
    targetRouteKey: string,
    fromEntry: EntryData | null
  ): { intercept: InterceptEntry; entry: EntryData } | null {
    let current: EntryData | null = fromEntry;

    while (current) {
      // Check if this entry has intercepts defined
      if (current.intercept && current.intercept.length > 0) {
        // Find intercept matching the target route name
        for (const intercept of current.intercept) {
          if (intercept.routeName === targetRouteKey) {
            return { intercept, entry: current };
          }
        }
      }

      // Also check sibling layouts for intercepts
      // Intercepts are defined as siblings in the route tree - e.g., an intercept
      // like (.)card/[cardId] is placed alongside the parent route's layouts
      if (current.layout && current.layout.length > 0) {
        for (const siblingLayout of current.layout) {
          if (siblingLayout.intercept && siblingLayout.intercept.length > 0) {
            for (const intercept of siblingLayout.intercept) {
              if (intercept.routeName === targetRouteKey) {
                return { intercept, entry: siblingLayout };
              }
            }
          }
        }
      }

      current = current.parent;
    }

    return null;
  }

  /**
   * Resolve an intercept entry and emit segment with the slot name
   * Similar to parallel entry resolution but for intercept handlers.
   *
   * Intercepts can have their own middleware, loaders, revalidate, and loading.
   * The handler is rendered in the named slot (e.g., @modal).
   *
   * @param interceptEntry - The intercept definition
   * @param parentEntry - The entry that defines the intercept (for shortCode)
   * @param params - URL parameters
   * @param context - Handler context
   * @param belongsToRoute - Whether this intercept belongs to the matched route
   */
  async function resolveInterceptEntry(
    interceptEntry: InterceptEntry,
    parentEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean = true
  ): Promise<ResolvedSegment[]> {
    const segments: ResolvedSegment[] = [];

    // Step 1: Execute intercept middleware
    if (interceptEntry.middleware.length > 0) {
      const middlewareResponse = await executeMiddleware(
        interceptEntry.middleware,
        context,
        `intercept:${interceptEntry.routeName}`
      );
      if (middlewareResponse) throw middlewareResponse;
    }

    // Step 2: Collect intercept loaders as promises
    // These will be attached directly to the intercept segment for streaming
    const loaderPromises: Promise<any>[] = [];
    const loaderNames: string[] = [];

    for (let i = 0; i < interceptEntry.loader.length; i++) {
      const { loader } = interceptEntry.loader[i];
      const segmentId = `${parentEntry.shortCode}.${interceptEntry.slotName}D${i}.${loader.name}`;

      loaderNames.push(loader.name);
      loaderPromises.push(
        wrapLoaderPromise(
          context.use(loader),
          parentEntry,
          segmentId,
          context.pathname
        )
      );
    }

    // Step 3: Execute intercept handler and prepare component
    // Get handler result - don't await if we have loading (enables streaming)
    const handlerResult =
      typeof interceptEntry.handler === "function"
        ? interceptEntry.handler(context)
        : interceptEntry.handler;

    // Step 4: Prepare layout element (if defined)
    // Layout will be applied in segment-system, not here
    let layoutElement: ReactNode | undefined;
    if (interceptEntry.layout) {
      layoutElement =
        typeof interceptEntry.layout === "function"
          ? await interceptEntry.layout(context)
          : interceptEntry.layout;
    }

    // Determine if we should await the handler result and loaders
    // If we have loading, DON'T await - let Suspense handle streaming
    let component: ReactNode | Promise<ReactNode>;
    let loaderDataPromise: Promise<any[]> | any[] | undefined;

    if (interceptEntry.loading && loaderPromises.length > 0) {
      // Has loading skeleton - keep everything as Promises for streaming
      // Wrap component in Promise if not already to ensure consistent streaming
      component =
        handlerResult instanceof Promise
          ? handlerResult
          : Promise.resolve(handlerResult);
      loaderDataPromise = Promise.all(loaderPromises);
    } else if (loaderPromises.length > 0) {
      // No loading skeleton - await loaders and component
      loaderDataPromise = await Promise.all(loaderPromises);
      component =
        handlerResult instanceof Promise ? await handlerResult : handlerResult;
    } else {
      // No loaders
      component =
        interceptEntry.loading && handlerResult instanceof Promise
          ? handlerResult
          : handlerResult instanceof Promise
            ? await handlerResult
            : handlerResult;
    }

    const interceptSegment = {
      id: `${parentEntry.shortCode}.${interceptEntry.slotName}`,
      namespace: `intercept:${interceptEntry.routeName}`,
      type: "parallel" as const,
      index: 0,
      component,
      loading: interceptEntry.loading === false ? null : interceptEntry.loading,
      layout: layoutElement,
      params,
      slot: interceptEntry.slotName,
      belongsToRoute,
      parallelName: `intercept:${interceptEntry.routeName}.${interceptEntry.slotName}`,
      // Attach loader info directly to segment for streaming
      loaderDataPromise,
      loaderNames: loaderNames.length > 0 ? loaderNames : undefined,
    };
    segments.push(interceptSegment);

    return segments;
  }

  /**
   * Helper: Resolve parallel EntryData with its loaders and slot handlers
   * Parallels now have their own loaders, revalidate functions, and loading components
   *
   * @param parentShortCode - The shortCode of the parent layout/route that owns this parallel.
   *   Used for segment IDs so the segment tree can correctly associate parallels with their parent.
   */
  async function resolveParallelEntry(
    parallelEntry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    parentShortCode: string
  ): Promise<ResolvedSegment[]> {
    invariant(
      parallelEntry.type === "parallel",
      `Expected parallel entry, got: ${parallelEntry.type}`
    );

    const segments: ResolvedSegment[] = [];

    // Step 1: Execute each slot handler first (they trigger loaders via ctx.use())
    // Handlers are NOT awaited if loading is defined - this keeps Promises pending for Suspense
    const slots = parallelEntry.handler as Record<
      `@${string}`,
      | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
      | ReactNode
    >;

    for (const [slot, handler] of Object.entries(slots)) {
      // If loading is defined, don't await the handler (stream with Suspense)
      let component: ReactNode | Promise<ReactNode>;
      if (parallelEntry.loading) {
        component = typeof handler === "function" ? handler(context) : handler;
      } else {
        component =
          typeof handler === "function" ? await handler(context) : handler;
      }

      // Use parent's shortCode so segment tree correctly associates this parallel with its parent
      segments.push({
        id: `${parentShortCode}.${slot}`,
        namespace: parallelEntry.id,
        type: "parallel",
        index: 0,
        component,
        loading: parallelEntry.loading === false ? null : parallelEntry.loading,
        params,
        slot,
        belongsToRoute,
        parallelName: `${parallelEntry.id}.${slot}`,
      });
    }

    // Step 2: Resolve loaders AFTER handlers have run
    // If loading is defined, do NOT await loaders - this keeps handler Promises pending for Suspense
    // Loader data flows through component props (via ctx.use() in handler)
    // If no loading, await loaders to create segments for useLoader() support
    if (!parallelEntry.loading) {
      const loaderSegments = resolveLoaders(
        parallelEntry,
        context,
        belongsToRoute,
        parentShortCode
      );
      segments.push(...loaderSegments);
    }

    return segments;
  }

  /**
   * Wrapper that adds error boundary handling to segment resolution
   * Catches errors during execution and returns error segments if an error boundary exists
   *
   * @param entry - The entry to resolve
   * @param routeKey - Route key for context
   * @param params - URL parameters
   * @param context - Handler context
   * @param loaderPromises - Shared loader promise map
   * @param resolveFn - The actual resolution function to call
   * @returns Segments from successful resolution, or an error segment if error boundary caught
   * @throws If error occurs and no error boundary is defined
   */
  async function resolveWithErrorHandling(
    entry: EntryData,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>,
    resolveFn: () => Promise<ResolvedSegment[]>
  ): Promise<ResolvedSegment[]> {
    try {
      return await resolveFn();
    } catch (error) {
      // Don't catch Response objects (middleware short-circuit)
      if (error instanceof Response) {
        throw error;
      }

      // Handle DataNotFoundError separately - look for notFoundBoundary first
      if (error instanceof DataNotFoundError) {
        const notFoundFallback = findNearestNotFoundBoundary(entry);

        if (notFoundFallback) {
          // Create notFound info
          const notFoundInfo = createNotFoundInfo(
            error,
            entry.shortCode,
            entry.type,
            context.pathname
          );

          console.log(
            `[Router] NotFound caught by notFoundBoundary in ${entry.shortCode}:`,
            notFoundInfo.message
          );

          // Create and return notFound segment
          const notFoundSegment = createNotFoundSegment(
            notFoundInfo,
            notFoundFallback,
            entry,
            params
          );
          return [notFoundSegment];
        }
        // If no notFoundBoundary, fall through to error boundary handling
      }

      // Find nearest error boundary
      const fallback = findNearestErrorBoundary(entry);

      // Determine segment type for error info
      const segmentType: ErrorInfo["segmentType"] = entry.type;

      // Create error info
      const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);

      // Use default fallback if no error boundary found
      const effectiveFallback = fallback ?? DefaultErrorFallback;

      console.log(
        `[Router] Error caught by ${fallback ? "error boundary" : "default fallback"} in ${entry.shortCode}:`,
        errorInfo.message
      );

      // Create and return error segment
      const errorSegment = createErrorSegment(
        errorInfo,
        effectiveFallback,
        entry,
        params
      );
      return [errorSegment];
    }
  }

  /**
   * Wrapper for segment resolution with revalidation that adds error boundary handling
   * Similar to resolveWithErrorHandling but returns SegmentRevalidationResult
   */
  async function resolveWithRevalidationErrorHandling(
    entry: EntryData,
    params: Record<string, string>,
    resolveFn: () => Promise<SegmentRevalidationResult>,
    pathname?: string
  ): Promise<SegmentRevalidationResult> {
    try {
      return await resolveFn();
    } catch (error) {
      // Don't catch Response objects (middleware short-circuit)
      if (error instanceof Response) {
        throw error;
      }

      // Handle DataNotFoundError separately - look for notFoundBoundary first
      if (error instanceof DataNotFoundError) {
        const notFoundFallback = findNearestNotFoundBoundary(entry);

        if (notFoundFallback) {
          // Create notFound info
          const notFoundInfo = createNotFoundInfo(
            error,
            entry.shortCode,
            entry.type,
            pathname
          );

          console.log(
            `[Router] NotFound caught by notFoundBoundary in ${entry.shortCode}:`,
            notFoundInfo.message
          );

          // Create notFound segment
          const notFoundSegment = createNotFoundSegment(
            notFoundInfo,
            notFoundFallback,
            entry,
            params
          );

          // Return with the notFound segment and its ID as matched
          return {
            segments: [notFoundSegment],
            matchedIds: [notFoundSegment.id],
          };
        }
        // If no notFoundBoundary, fall through to error boundary handling
      }

      // Find nearest error boundary
      const fallback = findNearestErrorBoundary(entry);

      // Determine segment type for error info
      const segmentType: ErrorInfo["segmentType"] = entry.type;

      // Create error info
      const errorInfo = createErrorInfo(error, entry.shortCode, segmentType);

      // Use default fallback if no error boundary found
      const effectiveFallback = fallback ?? DefaultErrorFallback;

      console.log(
        `[Router] Error caught by ${fallback ? "error boundary" : "default fallback"} in ${entry.shortCode}:`,
        errorInfo.message
      );

      // Create error segment
      const errorSegment = createErrorSegment(
        errorInfo,
        effectiveFallback,
        entry,
        params
      );

      // Return with the error segment and its ID as matched
      return {
        segments: [errorSegment],
        matchedIds: [errorSegment.id],
      };
    }
  }

  /**
   * Result of resolving segments with revalidation
   * Contains both segments to render and all matched segment IDs
   */
  interface SegmentRevalidationResult {
    segments: ResolvedSegment[];
    matchedIds: string[];
  }

  /**
   * Action context type for revalidation
   */
  type ActionContext = {
    actionId?: string;
    actionUrl?: URL;
    actionResult?: any;
    formData?: FormData;
  };

  /**
   * Helper: Resolve parallel segments with revalidation
   * Parallels now have their own loaders, revalidate functions, and loading components
   */
  async function resolveParallelSegmentsWithRevalidation(
    entry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: ActionContext
  ): Promise<SegmentRevalidationResult> {
    const segments: ResolvedSegment[] = [];
    const matchedIds: string[] = [];

    for (const parallelEntry of entry.parallel) {
      invariant(
        parallelEntry.type === "parallel",
        `Expected parallel entry, got: ${parallelEntry.type}`
      );

      // Step 1: Process each slot handler FIRST (they trigger loaders via ctx.use())
      const slots = parallelEntry.handler as Record<
        `@${string}`,
        | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
        | ReactNode
      >;

      for (const [slot, handler] of Object.entries(slots)) {
        // Use parent entry's shortCode so segment tree correctly associates parallel with parent
        const parallelId = `${entry.shortCode}.${slot}`;

        matchedIds.push(parallelId);

        const component = await revalidate(
          async () => {
            if (!clientSegmentIds.has(parallelId)) return true;

            const dummySegment: ResolvedSegment = {
              id: parallelId,
              namespace: parallelEntry.id,
              type: "parallel",
              index: 0,
              component: null as any,
              params,
              slot,
              belongsToRoute,
              parallelName: `${parallelEntry.id}.${slot}`,
            };

            // Use parallel's own revalidate functions
            return await evaluateRevalidation(
              dummySegment,
              prevParams,
              null,
              request,
              prevUrl,
              nextUrl,
              parallelEntry.revalidate.map((fn, i) => ({
                name: `revalidate${i}`,
                fn,
              })),
              routeKey,
              context,
              actionContext
            );
          },
          async () => {
            // If loading is defined, don't await (stream with Suspense)
            if (parallelEntry.loading) {
              return typeof handler === "function" ? handler(context) : handler;
            }
            return typeof handler === "function"
              ? await handler(context)
              : handler;
          },
          () => null
        );

        segments.push({
          id: parallelId,
          namespace: parallelEntry.id,
          type: "parallel",
          index: 0,
          component,
          loading:
            parallelEntry.loading === false ? null : parallelEntry.loading,
          params,
          slot,
          belongsToRoute,
          parallelName: `${parallelEntry.id}.${slot}`,
        });
      }

      // Step 2: Resolve loaders AFTER handlers have run
      // If loading is defined, do NOT await loaders - keeps handler Promises pending for Suspense
      // Loader data flows through component props (via ctx.use() in handler)
      if (!parallelEntry.loading) {
        const loaderResult = await resolveLoadersWithRevalidation(
          parallelEntry,
          context,
          belongsToRoute,
          clientSegmentIds,
          prevParams,
          request,
          prevUrl,
          nextUrl,
          routeKey,
          actionContext,
          entry.shortCode // Pass parent's shortCode for segment ID association
        );
        segments.push(...loaderResult.segments);
        matchedIds.push(...loaderResult.matchedIds);
      }
    }

    return { segments, matchedIds };
  }

  /**
   * Helper: Resolve entry handler (layout or route) with revalidation
   * Extracted to reduce duplication between layout and route branches
   */
  async function resolveEntryHandlerWithRevalidation(
    entry: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    belongsToRoute: boolean,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    actionContext?: ActionContext
  ): Promise<{ segment: ResolvedSegment; matchedId: string }> {
    const matchedId = entry.shortCode;

    const component = await revalidate(
      async () => {
        const hasSegment = clientSegmentIds.has(entry.shortCode);
        console.log(
          `[Router.resolveEntryHandler] ${entry.shortCode} (${entry.type}): client has=${hasSegment}, belongsToRoute=${belongsToRoute}`
        );
        if (!hasSegment) return true;

        const dummySegment: ResolvedSegment = {
          id: entry.shortCode,
          namespace: entry.id,
          type: entry.type as "layout" | "route",
          index: 0,
          component: null as any,
          params,
          belongsToRoute,
          ...(entry.type === "layout" ? { layoutName: entry.id } : {}),
        };

        const shouldRevalidate = await evaluateRevalidation(
          dummySegment,
          prevParams,
          null,
          request,
          prevUrl,
          nextUrl,
          entry.revalidate.map((fn, i) => ({ name: `revalidate${i}`, fn })),
          routeKey,
          context,
          actionContext
        );
        console.log(
          `[Router.resolveEntryHandler] ${entry.shortCode}: evaluateRevalidation returned ${shouldRevalidate}`
        );
        return shouldRevalidate;
      },
      async () => {
        if (entry.type === "layout") {
          return typeof entry.handler === "function"
            ? await entry.handler(context)
            : entry.handler;
        }
        // entry.type === "route" - handler is always callable
        const routeEntry = entry as Extract<EntryData, { type: "route" }>;
        // For routes with loading: keep promise pending for navigation (not actions)
        // This allows client's use() to suspend and show loading skeleton
        if (!routeEntry.loading) {
          return await routeEntry.handler(context);
        }
        if (!actionContext) {
          return { content: routeEntry.handler(context) }; // NOT awaited - keeps promise pending
        }
        console.log(
          `[Router] Resolving action route with resolved promise: ${entry.id}`
        );
        return {
          content: Promise.resolve(await routeEntry.handler(context)),
        };
      },
      () => null
    );

    // Extract component from wrapper object if needed (used to prevent promise auto-resolution)
    const resolvedComponent =
      component && typeof component === "object" && "content" in component
        ? (component as { content: ReactNode }).content
        : component;

    const segment: ResolvedSegment = {
      id: entry.shortCode,
      namespace: entry.id,
      type: entry.type as "layout" | "route",
      index: 0,
      component: resolvedComponent,
      loading: entry.loading === false ? null : entry.loading,
      params,
      belongsToRoute,
      ...(entry.type === "layout" ? { layoutName: entry.id } : {}),
    };

    return { segment, matchedId };
  }

  /**
   * Resolve segments with revalidation awareness (for partial rendering)
   * Same as resolveSegment but conditionally executes handlers based on revalidation
   * Returns both segments to render AND all matched segment IDs (including skipped ones)
   */
  async function resolveSegmentWithRevalidation(
    entry: EntryData,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    loaderPromises: Map<string, Promise<any>>,
    actionContext?: ActionContext
  ): Promise<SegmentRevalidationResult> {
    const segments: ResolvedSegment[] = [];
    const matchedIds: string[] = [];

    const belongsToRoute = entry.type === "route";

    // Step 1: Run middleware (same for both layout and route)
    if (entry.middleware.length > 0) {
      const response = await executeMiddleware(
        entry.middleware,
        context,
        entry.id
      );
      if (response) throw response;
    }

    // Step 2: Run loaders with revalidation
    const loaderResult = await resolveLoadersWithRevalidation(
      entry,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      actionContext
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);

    // Step 3: Process orphan layouts (for routes, these come before parallels)
    if (entry.type === "route") {
      for (const orphan of entry.layout) {
        const orphanResult = await resolveOrphanLayoutWithRevalidation(
          orphan,
          params,
          context,
          clientSegmentIds,
          prevParams,
          request,
          prevUrl,
          nextUrl,
          routeKey,
          loaderPromises,
          true, // Route's orphan layouts belong to the route
          actionContext
        );
        segments.push(...orphanResult.segments);
        matchedIds.push(...orphanResult.matchedIds);
      }
    }

    // Step 4: Process parallel segments
    const parallelResult = await resolveParallelSegmentsWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      actionContext
    );
    segments.push(...parallelResult.segments);
    matchedIds.push(...parallelResult.matchedIds);

    // Step 5: Process orphan layouts (for layouts, these come after parallels)
    if (entry.type === "layout") {
      for (const orphan of entry.layout) {
        const orphanResult = await resolveOrphanLayoutWithRevalidation(
          orphan,
          params,
          context,
          clientSegmentIds,
          prevParams,
          request,
          prevUrl,
          nextUrl,
          routeKey,
          loaderPromises,
          false, // Parent chain layouts don't belong to specific route
          actionContext
        );
        segments.push(...orphanResult.segments);
        matchedIds.push(...orphanResult.matchedIds);
      }
    }

    // Step 6: Execute main handler with revalidation
    const handlerResult = await resolveEntryHandlerWithRevalidation(
      entry,
      params,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      actionContext
    );
    segments.push(handlerResult.segment);
    matchedIds.push(handlerResult.matchedId);

    return { segments, matchedIds };
  }

  /**
   * Helper: Resolve orphan layout with revalidation
   * Returns both segments to render AND all matched segment IDs (including skipped ones)
   */
  async function resolveOrphanLayoutWithRevalidation(
    orphan: EntryData,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    clientSegmentIds: Set<string>,
    prevParams: Record<string, string>,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    routeKey: string,
    loaderPromises: Map<string, Promise<any>>,
    belongsToRoute: boolean,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    }
  ): Promise<SegmentRevalidationResult> {
    invariant(
      orphan.type === "layout",
      `Expected orphan to be a layout, got: ${orphan.type}`
    );

    const segments: ResolvedSegment[] = [];
    const matchedIds: string[] = [];

    // Step 1: Run orphan middleware
    if (orphan.middleware.length > 0) {
      const middlewareResponse = await executeMiddleware(
        orphan.middleware,
        context,
        orphan.id
      );
      if (middlewareResponse) throw middlewareResponse;
    }

    // Step 2: Run orphan loaders with revalidation
    const loaderResult = await resolveLoadersWithRevalidation(
      orphan,
      context,
      belongsToRoute,
      clientSegmentIds,
      prevParams,
      request,
      prevUrl,
      nextUrl,
      routeKey,
      actionContext
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);

    // Step 3: Process orphan parallel segments with revalidation
    // Parallels now have their own loaders, revalidate functions, and loading components
    for (const parallelEntry of orphan.parallel) {
      invariant(
        parallelEntry.type === "parallel",
        `Expected parallel entry, got: ${parallelEntry.type}`
      );

      // Step 3a: Resolve parallel's loaders with revalidation
      const loaderResult = await resolveLoadersWithRevalidation(
        parallelEntry,
        context,
        belongsToRoute,
        clientSegmentIds,
        prevParams,
        request,
        prevUrl,
        nextUrl,
        routeKey,
        actionContext
      );
      segments.push(...loaderResult.segments);
      matchedIds.push(...loaderResult.matchedIds);

      // Step 3b: Process each slot in the parallel handler
      const slots = parallelEntry.handler as Record<
        `@${string}`,
        | ((ctx: HandlerContext<any, TEnv>) => ReactNode | Promise<ReactNode>)
        | ReactNode
      >;

      for (const [slot, handler] of Object.entries(slots)) {
        const parallelId = `${parallelEntry.shortCode}.${slot}`;

        // Always add to matchedIds
        matchedIds.push(parallelId);

        const component = await revalidate(
          async () => {
            if (!clientSegmentIds.has(parallelId)) return true;

            const dummySegment: ResolvedSegment = {
              id: parallelId,
              namespace: parallelEntry.id,
              type: "parallel",
              index: 0,
              component: null as any,
              params,
              slot,
              belongsToRoute,
              parallelName: `${parallelEntry.id}.${slot}`,
            };

            // Use parallel's own revalidate functions
            return await evaluateRevalidation(
              dummySegment,
              prevParams,
              null,
              request,
              prevUrl,
              nextUrl,
              parallelEntry.revalidate.map((fn, i) => ({
                name: `revalidate${i}`,
                fn,
              })),
              routeKey,
              context,
              actionContext
            );
          },
          async () => {
            // If loading is defined, don't await (stream with Suspense)
            if (parallelEntry.loading) {
              return typeof handler === "function" ? handler(context) : handler;
            }
            return typeof handler === "function"
              ? await handler(context)
              : handler;
          },
          () => null
        );

        segments.push({
          id: parallelId,
          namespace: parallelEntry.id,
          type: "parallel",
          index: 0,
          component,
          loading:
            parallelEntry.loading === false ? null : parallelEntry.loading,
          params,
          slot,
          belongsToRoute,
          parallelName: `${parallelEntry.id}.${slot}`,
        });
      }
    }

    // Step 4: Execute orphan handler with revalidation
    // Always add orphan layout ID to matchedIds
    matchedIds.push(orphan.shortCode);

    const component = await revalidate(
      async () => {
        if (!clientSegmentIds.has(orphan.shortCode)) return true;

        const dummySegment: ResolvedSegment = {
          id: orphan.shortCode,
          namespace: orphan.id,
          type: "layout",
          index: 0,
          component: null as any,
          params,
          belongsToRoute,
          layoutName: orphan.id,
        };

        return await evaluateRevalidation(
          dummySegment,
          prevParams,
          null,
          request,
          prevUrl,
          nextUrl,
          orphan.revalidate.map((fn, i) => ({ name: `revalidate${i}`, fn })),
          routeKey,
          context,
          actionContext
        );
      },
      async () =>
        typeof orphan.handler === "function"
          ? await orphan.handler(context)
          : orphan.handler,
      () => null
    );

    segments.push({
      id: orphan.shortCode,
      namespace: orphan.id,
      type: "layout",
      index: 0,
      component,
      params,
      belongsToRoute,
      layoutName: orphan.id,
      loading: orphan.loading === false ? null : orphan.loading,
    });

    return { segments, matchedIds };
  }

  /**
   * Match request and return segments
   * Uses generator-based stream for efficient segment building
   */
  async function match(request: Request, context: TEnv): Promise<MatchResult> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Initialize metrics store for this request
    const metricsStore = getMetricsStore();

    // Track route matching (direct recording since ALS context not yet available)
    const routeMatchStart = metricsStore ? performance.now() : 0;
    const matched = findMatch(pathname);
    if (metricsStore) {
      const duration = performance.now() - routeMatchStart;
      metricsStore.metrics.push({
        label: "route-matching",
        duration,
        startTime: routeMatchStart - metricsStore.requestStart,
      });
    }

    if (!matched) {
      throw new RouteNotFoundError(`No route matched for ${pathname}`, {
        cause: {
          pathname,
          method: request.method,
        },
      });
    }

    // Load manifest with AsyncLocalStorage context and validation
    // Pass metrics store to be included in context
    // Track manifest loading (direct recording since ALS context not yet available)
    // isSSR=true for document requests so loading() with skipSSR can disable itself
    const manifestStart = metricsStore ? performance.now() : 0;
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      metricsStore,
      true // isSSR
    );
    if (metricsStore) {
      const duration = performance.now() - manifestStart;
      metricsStore.metrics.push({
        label: "manifest-loading",
        duration,
        startTime: manifestStart - metricsStore.requestStart,
      });
    }

    // Extract bindings from context (if using RouterEnv pattern)
    const bindings = (context as any)?.Bindings || {};

    const handlerContext = createHandlerContext(
      matched.params,
      request,
      url.searchParams,
      pathname,
      url,
      bindings
    );

    try {
      // Create request-scoped loader promises map for parallel execution
      const loaderPromises = new Map<string, Promise<any>>();

      // Set up ctx.use() to access loader data
      setupLoaderAccess(handlerContext, loaderPromises);

      // Get the store for running segment resolution within metrics context
      const Store = getContext().getOrCreateStore(matched.routeKey);
      if (metricsStore) {
        Store.metrics = metricsStore;
      }

      // Collect all segments from stream (run within store context for metrics tracking)
      const segments: ResolvedSegment[] = await getContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        async () => {
          const segs: ResolvedSegment[] = [];
          for (const entry of traverseBack(manifestEntry)) {
            // Resolve entry into segments with error boundary handling
            const resolvedSegments = await resolveWithErrorHandling(
              entry,
              matched.routeKey,
              matched.params,
              handlerContext,
              loaderPromises,
              () =>
                resolveSegment(
                  entry,
                  matched.routeKey,
                  matched.params,
                  handlerContext,
                  loaderPromises
                )
            );

            segs.push(...resolvedSegments);
          }
          return segs;
        }
      );

      const segmentIds = segments.map((s) => s.id);

      // Output metrics if enabled
      let serverTiming: string | undefined;
      if (metricsStore) {
        logMetrics(request.method, pathname, metricsStore);
        serverTiming = generateServerTiming(metricsStore);
      }

      return {
        segments,
        matched: segmentIds,
        diff: segmentIds,
        serverTiming,
      };
    } catch (error) {
      // Check if middleware/handler short-circuited with Response
      if (error instanceof Response) {
        console.log(
          `[Router.match] Response short-circuit - returning directly`
        );
        throw error; // Propagate to top-level handler (entry.rsc.tsx)
      }
      console.error((error as Error)?.stack || error);

      // Sanitize error for production security
      console.error(`[Router.match] Error during match:`, error);
      throw sanitizeError(error);
    }
  }

  /**
   * Match an error to the nearest error boundary and return error segments
   *
   * This method is used when an action or other operation fails and we need
   * to render the error boundary UI. It finds the nearest errorBoundary in
   * the route tree and renders it with the error info.
   *
   * The returned segments include all segments up to and including the error
   * boundary, with the error boundary's fallback rendered in place of its
   * normal outlet content.
   */
  async function matchError(
    request: Request,
    _context: TEnv,
    error: unknown,
    segmentType: ErrorInfo["segmentType"] = "route"
  ): Promise<MatchResult | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    console.log(`[Router.matchError] Matching error for ${pathname}`);

    // Find the route match for the current URL
    const matched = findMatch(pathname);
    if (!matched) {
      console.warn(`[Router.matchError] No route matched for ${pathname}`);
      return null;
    }

    // Load manifest to get the entry chain
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      undefined, // No metrics for error matching
      false // Not SSR
    );

    // Find the nearest error boundary in the entry chain
    // If none found, use a default "Internal Server Error" fallback
    const fallback = findNearestErrorBoundary(manifestEntry);
    const useDefaultFallback = !fallback;

    // Create error info
    const errorInfo = createErrorInfo(
      error,
      manifestEntry.shortCode || "unknown",
      segmentType
    );

    // Find which entry has the error boundary
    // Also checks orphan layouts (siblings) since they can have error boundaries too
    let entryWithBoundary: EntryData | null = null;
    let current: EntryData | null = manifestEntry;
    while (current) {
      // Check if this entry has an error boundary
      if (current.errorBoundary && current.errorBoundary.length > 0) {
        entryWithBoundary = current;
        break;
      }

      // Check orphan layouts for error boundaries
      if (current.layout && current.layout.length > 0) {
        for (const orphan of current.layout) {
          if (orphan.errorBoundary && orphan.errorBoundary.length > 0) {
            entryWithBoundary = orphan;
            break;
          }
        }
        if (entryWithBoundary) break;
      }

      current = current.parent;
    }

    // Determine which entry has the error boundary and which entry should be replaced
    // The error content renders in the boundary's <Outlet />, not replacing the boundary itself
    let boundaryEntry: EntryData;
    let outletEntry: EntryData; // The entry that renders in boundaryEntry's outlet (gets replaced)

    if (entryWithBoundary) {
      boundaryEntry = entryWithBoundary;

      // Find the entry that renders in boundaryEntry's <Outlet />
      // Walk from manifestEntry toward boundaryEntry to find the direct outlet child
      outletEntry = manifestEntry;
      current = manifestEntry;

      while (current) {
        // Case 1: current's direct parent is boundaryEntry
        if (current.parent === boundaryEntry) {
          outletEntry = current;
          break;
        }

        // Case 2: boundaryEntry is an orphan layout of current's parent
        // In this case, current renders in the orphan's outlet
        if (current.parent && current.parent.layout) {
          if (current.parent.layout.includes(boundaryEntry)) {
            outletEntry = current;
            break;
          }
        }

        current = current.parent;
      }
    } else {
      // No user-defined error boundary - use root layout for the default fallback
      // Walk up to find the root entry (no parent)
      let rootEntry = manifestEntry;
      while (rootEntry.parent) {
        rootEntry = rootEntry.parent;
      }
      boundaryEntry = rootEntry;
      outletEntry = rootEntry; // For default, replace at root level
    }

    // Build the matched IDs list: all entries from root to the error boundary (inclusive)
    // These segments will be fetched from client cache (parent layouts + their loaders)
    const matchedIds: string[] = [];

    // Walk from error boundary up to root and collect parent IDs
    current = boundaryEntry;
    const stack: {
      shortCode: string;
      loaderEntries: { loader: { name: string } }[];
    }[] = [];
    while (current) {
      if (current.shortCode) {
        stack.push({
          shortCode: current.shortCode,
          loaderEntries: current.loader || [],
        });
      }
      current = current.parent;
    }
    // Reverse to get root-first order and build matchedIds including loaders
    for (const item of stack.reverse()) {
      matchedIds.push(item.shortCode);
      // Add loader segment IDs for this entry
      for (let i = 0; i < item.loaderEntries.length; i++) {
        const loaderName = item.loaderEntries[i].loader?.name || "unknown";
        matchedIds.push(`${item.shortCode}D${i}.${loaderName}`);
      }
    }

    // Create the error segment using user's fallback or default
    // The error segment uses the outlet entry's ID so it replaces the outlet content
    // while keeping the boundary layout (and its UI) rendered
    const effectiveFallback = fallback || DefaultErrorFallback;
    const errorSegment = createErrorSegment(
      errorInfo,
      effectiveFallback,
      outletEntry, // Use outletEntry so error content renders in the boundary's outlet
      matched.params
    );

    if (useDefaultFallback) {
      console.log(
        `[Router.matchError] Using default error boundary (no user-defined boundary found)`
      );
    }

    console.log(
      `[Router.matchError] Boundary: ${boundaryEntry.shortCode}, outlet replaced: ${outletEntry.shortCode}`
    );

    // Error segment replaces the outlet content, not the boundary layout itself
    // matched contains all IDs from root to boundary (for caching parent layouts)
    // diff contains the outlet entry ID that is being replaced with error content
    return {
      segments: [errorSegment],
      matched: matchedIds,
      diff: [errorSegment.id],
    };
  }

  /**
   * Match partial request with revalidation
   * Optimized with lazy evaluation - only builds previous segments if needed
   */
  async function matchPartial(
    request: Request,
    context: TEnv,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    }
  ): Promise<MatchResult | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Initialize metrics store for this request
    const metricsStore = getMetricsStore();

    // Extract client state from query params and header
    // Filter out empty strings - "".split(",") returns [""] not []
    const clientSegmentIds =
      url.searchParams.get("_rsc_segments")?.split(",").filter(Boolean) || [];
    // Use custom header first, fallback to standard Referer for prefetch scenarios
    const previousUrl =
      request.headers.get("X-RSC-Router-Client-Path") ||
      request.headers.get("Referer");
    // Intercept source URL - tracks where an intercept was triggered from
    // Used during action revalidation to maintain intercept context
    const interceptSourceUrl = request.headers.get(
      "X-RSC-Router-Intercept-Source"
    );

    if (!previousUrl) {
      // No previous URL - fall back to full render
      return null;
    }

    const prevUrl = new URL(previousUrl, url.origin);
    // For intercept determination, use intercept source URL if available
    // This allows actions in intercepted modals to maintain intercept context
    const interceptContextUrl = interceptSourceUrl
      ? new URL(interceptSourceUrl, url.origin)
      : prevUrl;

    // Track route matching (direct recording since ALS context not yet available)
    const routeMatchStart = metricsStore ? performance.now() : 0;
    const prevMatch = findMatch(prevUrl.pathname);
    const prevParams = prevMatch?.params || {};
    // Match intercept context URL for determining intercept activation
    // This is different from prevMatch when action fires from intercepted modal
    const interceptContextMatch = interceptSourceUrl
      ? findMatch(interceptContextUrl.pathname)
      : prevMatch;

    // Match current route
    const matched = findMatch(pathname);
    if (metricsStore) {
      const duration = performance.now() - routeMatchStart;
      metricsStore.metrics.push({
        label: "route-matching",
        duration,
        startTime: routeMatchStart - metricsStore.requestStart,
      });
    }

    if (!matched) {
      throw new RouteNotFoundError(`No route matched for ${pathname}`, {
        cause: {
          pathname,
          method: request.method,
          previousUrl,
        },
      });
    }

    // Check if routes are from different route groups (different matchers)
    // When navigating between route groups (e.g., /about → /blog), segment IDs
    // have completely different prefixes (M2 vs M1). The client cannot merge
    // segments from different groups, so fall back to full render.
    // Compare the route entry (handler group), not the individual routeKey (which varies within a group)
    if (prevMatch && prevMatch.entry !== matched.entry) {
      console.log(
        `[Router.matchPartial] Route group changed: ${prevMatch.routeKey} → ${matched.routeKey}, falling back to full render`
      );
      return null;
    }

    // Load manifest with AsyncLocalStorage context and validation
    // Track manifest loading (direct recording since ALS context not yet available)
    // isSSR=false for partial requests (navigation/actions)
    const manifestStart = metricsStore ? performance.now() : 0;
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      metricsStore,
      false // isSSR
    );
    if (metricsStore) {
      const duration = performance.now() - manifestStart;
      metricsStore.metrics.push({
        label: "manifest-loading",
        duration,
        startTime: manifestStart - metricsStore.requestStart,
      });
    }

    // Extract bindings from context
    const bindings = (context as any)?.Bindings || {};

    const handlerContext = createHandlerContext(
      matched.params,
      request,
      url.searchParams,
      pathname,
      url,
      bindings
    );

    const clientSegmentSet = new Set(clientSegmentIds);
    console.log(
      `[Router.matchPartial] Client segments:`,
      Array.from(clientSegmentSet)
    );

    try {
      // Create request-scoped loader promises map for parallel execution
      const loaderPromises = new Map<string, Promise<any>>();

      // Set up ctx.use() to access loader data
      setupLoaderAccess(handlerContext, loaderPromises);

      // Get the store for running segment resolution within metrics context
      const Store = getContext().getOrCreateStore(matched.routeKey);
      if (metricsStore) {
        Store.metrics = metricsStore;
      }

      // Check for intercepting routes FIRST
      // Intercepts activate during soft navigation and REPLACE the route handler
      // They render in named slots (@modal, @sidebar, etc.) while layouts stay
      //
      // IMPORTANT: Don't intercept when navigating within the same route type
      // (e.g., product/a -> product/b). Intercepts only activate when navigating
      // TO the route FROM a different route.
      //
      // For action revalidation from intercepted modals, use interceptContextMatch
      // which reflects the source URL (e.g., /shop) rather than the current URL
      // (e.g., /shop/product/headphones). This maintains intercept context.
      const isSameRouteNavigation =
        interceptContextMatch &&
        interceptContextMatch.routeKey === matched.routeKey;

      // Debug logging for intercept context
      if (interceptSourceUrl) {
        console.log(`[Router.matchPartial] Intercept context detected:`);
        console.log(`  - Current URL: ${pathname}`);
        console.log(`  - Intercept source: ${interceptSourceUrl}`);
        console.log(`  - Context match: ${interceptContextMatch?.routeKey}`);
        console.log(`  - Current route: ${matched.routeKey}`);
        console.log(`  - Same route navigation: ${isSameRouteNavigation}`);
      }

      const localRouteName = matched.routeKey.includes(".")
        ? matched.routeKey.split(".").pop()!
        : matched.routeKey;

      // Walk up from route's parent to find intercept (parent layouts can intercept child routes)
      // Try both full route key and local name for flexible matching
      // Skip intercept lookup entirely if navigating within the same route
      const interceptResult = isSameRouteNavigation
        ? null
        : findInterceptForRoute(matched.routeKey, manifestEntry.parent) ||
          (localRouteName !== matched.routeKey
            ? findInterceptForRoute(localRouteName, manifestEntry.parent)
            : null);

      // Build slots state - intercepts render in named slots
      const slots: Record<string, import("./types.js").SlotState> = {};
      let interceptSegments: ResolvedSegment[] = [];

      // Collect segments with revalidation-aware rendering
      // When intercepting: skip route handler, only render layouts + intercept
      // When not intercepting: render everything normally
      const result = await getContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        async () => {
          const segs: ResolvedSegment[] = [];
          const matchedIds: string[] = [];
          for (const entry of traverseBack(manifestEntry)) {
            console.log(
              `[Router.matchPartial] Processing entry: ${entry.shortCode} (${entry.type})`
            );
            // When intercepting, skip the route handler - intercept replaces it
            const isRouteEntry = entry.type === "route";
            if (isRouteEntry && interceptResult) {
              console.log(
                `[Router.matchPartial] Intercepting "${localRouteName}" - skipping route handler`
              );
              // Still include route ID in matched for client-side cache tracking
              matchedIds.push(entry.shortCode);
              continue;
            }

            // Normal resolution for layouts and non-intercepted routes
            const resolved = await resolveWithRevalidationErrorHandling(
              entry,
              matched.params,
              () =>
                resolveSegmentWithRevalidation(
                  entry,
                  matched.routeKey,
                  matched.params,
                  handlerContext,
                  clientSegmentSet,
                  prevParams,
                  request,
                  prevUrl,
                  url,
                  loaderPromises,
                  actionContext
                ),
              pathname
            );

            segs.push(...resolved.segments);
            matchedIds.push(...resolved.matchedIds);
          }
          return { segments: segs, matchedIds };
        }
      );

      const { segments, matchedIds: allMatchedIds } = result;

      if (interceptResult) {
        const slotName = interceptResult.intercept.slotName;
        console.log(
          `[Router.matchPartial] Found intercept for "${localRouteName}" -> slot "${slotName}"`
        );

        // Resolve intercept entry (middleware, loaders, handler)
        interceptSegments = await getContext().runWithStore(
          Store,
          Store.namespace || "#router",
          Store.parent,
          () =>
            resolveInterceptEntry(
              interceptResult.intercept,
              interceptResult.entry,
              matched.params,
              handlerContext,
              true // belongsToRoute
            )
        );

        // Add to slots metadata - browser uses this to know which slots are active
        slots[slotName] = {
          active: true,
          segments: interceptSegments,
        };
      }

      // Combine main segments with intercept segments
      const allSegments = [...segments, ...interceptSegments];

      // When intercepting, tell browser to keep its current segments + add modal
      // This prevents the browser from discarding the current page content
      const allIds = interceptResult
        ? [...clientSegmentIds, ...interceptSegments.map((s) => s.id)]
        : [...allMatchedIds, ...interceptSegments.map((s) => s.id)];

      // Filter out segments with null components (client already has them)
      // BUT always include loader segments - they carry data even with null component
      const segmentsToRender = allSegments.filter(
        (s) => s.component !== null || s.type === "loader"
      );
      console.log(
        `[Router.matchPartial] All segments:`,
        allSegments.map((s) => `${s.id}(${s.type}, component=${s.component !== null})`).join(", ")
      );
      console.log(
        `[Router.matchPartial] Segments to render:`,
        segmentsToRender.map((s) => s.id).join(", ")
      );

      // Output metrics if enabled
      let serverTiming: string | undefined;
      if (metricsStore) {
        logMetrics(request.method, pathname, metricsStore);
        serverTiming = generateServerTiming(metricsStore);
      }

      return {
        segments: segmentsToRender,
        matched: allIds, // All segment IDs including intercepts
        diff: segmentsToRender.map((s) => s.id),
        serverTiming,
        // Include slots state - browser uses this to know which slots are active
        slots: Object.keys(slots).length > 0 ? slots : undefined,
      };
    } catch (error) {
      // Check if middleware/handler short-circuited with Response
      if (error instanceof Response) {
        console.log(
          `[Router.matchPartial] Response short-circuit - returning directly`
        );
        throw error;
      }

      // Sanitize error for production security
      console.error(`[Router.matchPartial] Error during matchPartial:`, error);
      throw sanitizeError(error);
    }
  }

  /**
   * Create route builder with accumulated route types
   * The TNewRoutes type parameter captures the new routes being added
   */
  function createRouteBuilder<TNewRoutes extends Record<string, string>>(
    prefix: string,
    routes: TNewRoutes
  ): RouteBuilder<RouteDefinition, TEnv, TNewRoutes> {
    const currentMountIndex = mountIndex++;

    // Merge routes into the href map with prefixes
    // This enables type-safe router.href() calls
    const routeEntries = routes as Record<string, string>;
    for (const [key, pattern] of Object.entries(routeEntries)) {
      // Build prefixed key: "shop" + "cart" -> "shop.cart"
      const prefixedKey = prefix ? `${prefix.slice(1)}.${key}` : key;
      // Build prefixed pattern: "/shop" + "/cart" -> "/shop/cart"
      const prefixedPattern =
        prefix && pattern !== "/"
          ? `${prefix}${pattern}`
          : prefix && pattern === "/"
            ? prefix
            : pattern;
      mergedRouteMap[prefixedKey] = prefixedPattern;
    }

    // Auto-register route map for runtime href() usage
    registerRouteMap(mergedRouteMap);

    return {
      map(
        handler: () =>
          | Array<AllUseItems>
          | Promise<{ default: () => Array<AllUseItems> }>
          | Promise<() => Array<AllUseItems>>
      ) {
        routesEntries.push({
          prefix,
          routes: routes as ResolvedRouteMap<any>,
          handler,
          mountIndex: currentMountIndex,
        });
        // Return router with accumulated types
        // At runtime this is the same object, but TypeScript tracks the accumulated route types
        return router as any;
      },

      // Expose accumulated route map for typeof extraction
      get routeMap() {
        return mergedRouteMap as TNewRoutes;
      },
    };
  }

  /**
   * Router instance
   * The type system tracks accumulated routes through the builder chain
   * Initial TRoutes is {} (empty) to avoid poisoning accumulated types with Record<string, string>
   */
  const router: RSCRouter<TEnv, {}> = {
    routes(
      prefixOrRoutes: string | Record<string, string>,
      maybeRoutes?: Record<string, string>
    ): any {
      // If second argument exists, first is prefix
      if (maybeRoutes !== undefined) {
        return createRouteBuilder(prefixOrRoutes as string, maybeRoutes);
      }
      // Otherwise, first argument is routes with empty prefix
      return createRouteBuilder("", prefixOrRoutes as Record<string, string>);
    },

    // Type-safe URL builder using merged route map
    // Types are tracked through the builder chain via TRoutes parameter
    href: createHref(mergedRouteMap),

    // Expose accumulated route map for typeof extraction
    // Returns {} initially, but builder chain accumulates specific route types
    get routeMap() {
      return mergedRouteMap as {};
    },

    match,
    matchPartial,
    matchError,
  };

  return router;
}
