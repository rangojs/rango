import type { ReactNode } from "react";
import { invariant, RouteNotFoundError, sanitizeError } from "./errors";
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
} from "./types";
import type { AllUseItems } from "./route-types.js";
import { EntryData, LoaderEntry, getContext, track, MetricsStore, PerformanceMetric } from "./server/context";
import { error } from "console";

/**
 * Router configuration options
 */
export interface RSCRouterOptions {
  /**
   * Enable performance metrics collection
   * When enabled, metrics are output to console and available via Server-Timing header
   */
  debugPerformance?: boolean;
}

/**
 * Router builder for chaining .use() and .map()
 */
interface RouteBuilder<T extends RouteDefinition, TEnv> {
  map(
    handler: () =>
      | Array<AllUseItems>
      | Promise<{ default: () => Array<AllUseItems> }>
      | Promise<() => Array<AllUseItems>>
  ): RSCRouter<TEnv>;
}

/**
 * RSC Router interface
 */
export interface RSCRouter<TEnv = any> {
  routes<T extends RouteDefinition>(
    prefix: string,
    routes: ResolvedRouteMap<T>
  ): RouteBuilder<T, TEnv>;

  routes<T extends RouteDefinition>(
    routes: ResolvedRouteMap<T>
  ): RouteBuilder<T, TEnv>;

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
}

/**
 * Create an RSC router with generic context type
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
 * router
 *   .route('/blog', blogRoutes)
 *   .map(() => import('./blog.handlers'));
 * ```
 */
export function createRSCRouter<TEnv = any>(
  options: RSCRouterOptions = {}
): RSCRouter<TEnv> {
  const { debugPerformance = false } = options;
  const routesEntries: RouteEntry<TEnv>[] = [];
  let mountIndex = 0;

  /**
   * Create a metrics store for the request if debugPerformance is enabled
   */
  function createMetricsStore(): MetricsStore | undefined {
    if (!debugPerformance) return undefined;
    return {
      enabled: true,
      requestStart: performance.now(),
      metrics: [],
    };
  }

  /**
   * Log metrics to console in a formatted way
   */
  function logMetrics(
    method: string,
    pathname: string,
    metricsStore: MetricsStore
  ): void {
    const total = performance.now() - metricsStore.requestStart;

    // Find max label length for alignment
    const maxLabelLen = Math.max(
      ...metricsStore.metrics.map((m) => m.label.length),
      20
    );

    console.log(`[RSC Perf] ${method} ${pathname} (${total.toFixed(1)}ms)`);

    for (const m of metricsStore.metrics) {
      const paddedLabel = m.label.padEnd(maxLabelLen);
      console.log(`  ${paddedLabel} ${m.duration.toFixed(1)}ms`);
    }
  }

  /**
   * Generate Server-Timing header value from metrics
   * Format: metric-name;dur=X.XX
   */
  function generateServerTiming(metricsStore: MetricsStore): string {
    return metricsStore.metrics
      .map((m) => {
        // Convert label to valid Server-Timing name (alphanumeric and hyphens)
        const name = m.label
          .replace(/:/g, "-")
          .replace(/[^a-zA-Z0-9-]/g, "")
          .toLowerCase();
        return `${name};dur=${m.duration.toFixed(2)}`;
      })
      .join(", ");
  }

  /**
   * Create HandlerContext with typed env/var/get/set
   */
  function createHandlerContext(
    params: Record<string, string>,
    request: Request,
    searchParams: URLSearchParams,
    pathname: string,
    url: URL,
    bindings: any = {}
  ): HandlerContext<any, TEnv> {
    // Variables object (mutable by middleware)
    const variables: any = {};

    // Filter system parameters (starting with _rsc) from searchParams
    // This ensures handlers only see user-facing query params
    const cleanSearchParams = new URLSearchParams();
    searchParams.forEach((value, key) => {
      if (!key.startsWith("_rsc")) {
        cleanSearchParams.set(key, value);
      }
    });

    // Create clean URL without system params
    const cleanUrl = new URL(url);
    cleanUrl.search = cleanSearchParams.toString();

    return {
      params,
      request,
      searchParams: cleanSearchParams, // Filtered params
      pathname,
      url: cleanUrl, // Clean URL
      env: bindings,
      var: variables,
      get: ((key: string) => variables[key]) as HandlerContext<
        any,
        TEnv
      >["get"],
      set: ((key: string, value: any) => {
        variables[key] = value;
      }) as HandlerContext<any, TEnv>["set"],
      _originalRequest: request, // Raw request for advanced use
      // Placeholder use() - will be replaced with actual implementation during request
      use: () => {
        throw new Error("ctx.use() called before loaders were initialized");
      },
    };
  }

  /**
   * Match a pathname against registered routes
   */
  function findMatch(pathname: string): {
    entry: RouteEntry<TEnv>;
    routeKey: string;
    params: Record<string, string>;
  } | null {
    for (const entry of routesEntries) {
      const routeEntries = Object.entries(entry.routes);

      for (const [routeKey, pattern] of routeEntries) {
        // Join prefix and pattern, handling edge cases
        let fullPattern: string;
        if (entry.prefix === "" || entry.prefix === "/") {
          fullPattern = pattern;
        } else if (pattern === "/" || pattern === "") {
          fullPattern = entry.prefix;
        } else {
          fullPattern = entry.prefix + pattern;
        }
        console.log(fullPattern);

        const { regex, paramNames } = compilePattern(fullPattern);
        const match = regex.exec(pathname);

        if (match) {
          const params: Record<string, string> = {};
          paramNames.forEach((name, index) => {
            params[name] = match[index + 1] || "";
          });

          return { entry, routeKey, params };
        }
      }
    }

    return null;
  }

  /**
   * Execute middleware chain with recursive chaining
   * Returns Response if middleware short-circuits, null otherwise
   */
  async function executeMiddleware(
    middleware: any[],
    ctx: HandlerContext<any, TEnv>,
    entryId?: string
  ): Promise<Response | null> {
    if (middleware.length === 0) {
      return null;
    }

    let index = 0;
    let earlyResponse: Response | null = null;

    const next = async (): Promise<void> => {
      if (index >= middleware.length || earlyResponse) {
        return; // Stop if reached end or middleware returned Response
      }

      const currentIndex = index++;
      const currentMiddleware = middleware[currentIndex];

      // Track each middleware execution
      const mwName = currentMiddleware.name || `mw${currentIndex}`;
      const label = entryId ? `middleware:${entryId}.${mwName}` : `middleware:${mwName}`;
      const done = track(label);

      try {
        const result = await currentMiddleware(ctx, next);
        done();

        // Check if middleware short-circuited with Response
        if (result instanceof Response) {
          earlyResponse = result;
          console.log(
            `[Router.executeMiddleware] Middleware returned Response - short-circuit`
          );
        }
      } catch (error) {
        done();
        // Middleware threw error - propagate it
        console.error(
          `[Router.executeMiddleware] Middleware threw error:`,
          error
        );
        throw error;
      }
    };

    await next();
    return earlyResponse; // null if all middleware called next()
  }

  /**
   * Resolve loaders for an entry and emit segments
   * Loaders are run lazily via ctx.use() and memoized for parallel execution
   */
  async function resolveLoaders(
    entry: EntryData,
    ctx: HandlerContext<any, TEnv>,
    belongsToRoute: boolean
  ): Promise<ResolvedSegment[]> {
    const segments: ResolvedSegment[] = [];
    const loaderEntries = entry.loader ?? [];

    // For each loader, trigger via ctx.use() and create segment
    for (let i = 0; i < loaderEntries.length; i++) {
      const { loader } = loaderEntries[i];

      // Trigger loader via ctx.use() (lazy execution with memoization)
      const data = await ctx.use(loader);

      // Create loader segment
      segments.push({
        id: `${entry.shortCode}D${i}.${loader.name}`,
        namespace: entry.id,
        type: "loader",
        index: i,
        component: null, // Loaders don't render directly
        params: ctx.params,
        loaderName: loader.name,
        loaderData: data,
        belongsToRoute,
      });
    }

    return segments;
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
    }
  ): Promise<LoaderRevalidationResult> {
    const segments: ResolvedSegment[] = [];
    const matchedIds: string[] = [];
    const loaderEntries = entry.loader ?? [];

    for (let i = 0; i < loaderEntries.length; i++) {
      const { loader, revalidate: loaderRevalidateFns } = loaderEntries[i];
      const segmentId = `${entry.shortCode}D${i}.${loader.name}`;

      // Always add to matchedIds - this loader is part of the page structure
      matchedIds.push(segmentId);

      // Check if we need to revalidate this loader
      const shouldRevalidate = await revalidate(
        async () => {
          // New segment - always run
          if (!clientSegmentIds.has(segmentId)) return true;

          // Create dummy segment for evaluation
          const dummySegment: ResolvedSegment = {
            id: segmentId,
            namespace: entry.id,
            type: "loader",
            index: i,
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
        async () => true, // Return true if should revalidate
        () => false // Return false if should not revalidate
      );

      // Only emit segment to client if revalidation is needed
      if (shouldRevalidate) {
        // Trigger loader via ctx.use() (lazy execution with memoization)
        const data = await ctx.use(loader);
        segments.push({
          id: segmentId,
          namespace: entry.id,
          type: "loader",
          index: i,
          component: null,
          params: ctx.params,
          loaderName: loader.name,
          loaderData: data,
          belongsToRoute,
        });
      }
      // If shouldRevalidate is false, don't emit the segment
      // But the ID is still in matchedIds so client knows to keep its cached data
      // Loader will run lazily if any handler calls ctx.use(loader)
    }

    return { segments, matchedIds };
  }

  /**
   * Set up the use() method on handler context to lazily run loaders
   * Loaders are started on first call to ctx.use() and memoized for subsequent calls
   */
  function setupLoaderAccess(
    ctx: HandlerContext<any, TEnv>,
    loaderPromises: Map<string, Promise<any>>
  ): void {
    ctx.use = <T, TLoaderParams = any>(loader: LoaderDefinition<T, TLoaderParams>): Promise<T> => {
      // Return cached promise if already started
      if (loaderPromises.has(loader.name)) {
        return loaderPromises.get(loader.name) as Promise<T>;
      }

      // Ensure loader has a function
      if (!loader.fn) {
        throw new Error(
          `Loader "${loader.name}" has no function. This usually means the loader was defined without "use server" and the function was not included in the build.`
        );
      }

      // Create loader context with recursive use() support
      const loaderCtx: LoaderContext<Record<string, string | undefined>, TEnv> = {
        params: ctx.params,
        request: ctx.request,
        searchParams: ctx.searchParams,
        pathname: ctx.pathname,
        url: ctx.url,
        env: ctx.env,
        var: ctx.var,
        get: ctx.get,
        use: <TDep, TDepParams = any>(dep: LoaderDefinition<TDep, TDepParams>): Promise<TDep> => {
          // Recursive call - will start dep loader if not already started
          return ctx.use(dep);
        },
      };

      // Start loader execution with tracking
      const doneLoader = track(`loader:${loader.name}`);
      const promise = Promise.resolve(
        loader.fn(loaderCtx as LoaderContext<TLoaderParams, TEnv>)
      ).finally(() => {
        doneLoader();
      });

      // Memoize for subsequent calls
      loaderPromises.set(loader.name, promise);

      return promise as Promise<T>;
    };
  }

  /**
   * Conditional execution based on revalidation
   * Evaluates revalidation logic lazily, then executes appropriate callback
   *
   * @param shouldRevalidate - Async function that determines if revalidation is needed
   * @param onRevalidate - Callback executed if revalidation returns true
   * @param onSkip - Callback executed if revalidation returns false
   * @returns Result from either onRevalidate or onSkip
   */
  async function revalidate<T>(
    shouldRevalidate: () => Promise<boolean>,
    onRevalidate: () => Promise<T>,
    onSkip: () => T
  ): Promise<T> {
    const needsRevalidation = await shouldRevalidate();
    return needsRevalidation ? await onRevalidate() : onSkip();
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
      for (const parallelRecord of entry.parallel) {
        for (const [slot, handler] of Object.entries(parallelRecord)) {
          const component =
            typeof handler === "function" ? await handler(context) : handler;

          // Emit parallel segment
          segments.push({
            id: `${entry.shortCode}.${slot}`,
            namespace: entry.id,
            type: "parallel",
            index: 0,
            component,
            params,
            slot,
            belongsToRoute: false, // Parent chain parallels don't belong to specific route
            parallelName: `${entry.id}.${slot}`,
          });
        }
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
          loaderPromises
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
          loaderPromises
        );
        segments.push(...orphanSegments);
      }

      // Step 4: Process and emit route parallel segments
      for (const parallelRecord of entry.parallel) {
        for (const [slot, handler] of Object.entries(parallelRecord)) {
          const component =
            typeof handler === "function" ? await handler(context) : handler;

          // Emit parallel segment
          segments.push({
            id: `${entry.shortCode}.${slot}`,
            namespace: entry.id,
            type: "parallel",
            index: 0,
            component,
            params,
            slot,
            belongsToRoute: true, // Route's parallels belong to the route
            parallelName: `${entry.id}.${slot}`,
          });
        }
      }

      // Step 5: Execute route handler and emit route segment
      const component = await entry.handler(context);

      segments.push({
        id: entry.shortCode,
        namespace: entry.id,
        type: "route",
        index: 0,
        component,
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
    loaderPromises: Map<string, Promise<any>>
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
      true // Orphan loaders belong to the route
    );

    // Step 3: Process and emit orphan parallel segments
    const segments: ResolvedSegment[] = [...loaderSegments];
    for (const parallelRecord of orphan.parallel) {
      for (const [slot, handler] of Object.entries(parallelRecord)) {
        const component =
          typeof handler === "function" ? await handler(context) : handler;

        // Emit parallel segment
        segments.push({
          id: `${orphan.shortCode}.${slot}`,
          namespace: orphan.id,
          type: "parallel",
          index: 0,
          component,
          params,
          slot,
          belongsToRoute: true, // Orphan's parallel belongs to the route
          parallelName: `${orphan.id}.${slot}`,
        });
      }
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
      belongsToRoute: true, // Orphan layout belongs to the route
      layoutName: orphan.id,
    });

    return segments;
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
   * Extracted to reduce duplication between layout and route branches
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

    for (const parallelRecord of entry.parallel) {
      for (const [slot, handler] of Object.entries(parallelRecord)) {
        const parallelId = `${entry.shortCode}.${slot}`;

        matchedIds.push(parallelId);

        const component = await revalidate(
          async () => {
            if (!clientSegmentIds.has(parallelId)) return true;

            const dummySegment: ResolvedSegment = {
              id: parallelId,
              namespace: entry.id,
              type: "parallel",
              index: 0,
              component: null as any,
              params,
              slot,
              belongsToRoute,
              parallelName: `${entry.id}.${slot}`,
            };

            return await evaluateRevalidation(
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
          },
          async () => (typeof handler === "function" ? await handler(context) : handler),
          () => null
        );

        segments.push({
          id: parallelId,
          namespace: entry.id,
          type: "parallel",
          index: 0,
          component,
          params,
          slot,
          belongsToRoute,
          parallelName: `${entry.id}.${slot}`,
        });
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
        if (!clientSegmentIds.has(entry.shortCode)) return true;

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

        return await evaluateRevalidation(
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
      },
      async () => {
        if (entry.type === "layout") {
          return typeof entry.handler === "function"
            ? await entry.handler(context)
            : entry.handler;
        }
        // entry.type === "route" - handler is always callable
        return await (entry as Extract<EntryData, { type: "route" }>).handler(
          context
        );
      },
      () => null
    );

    const segment: ResolvedSegment = {
      id: entry.shortCode,
      namespace: entry.id,
      type: entry.type as "layout" | "route",
      index: 0,
      component,
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
      const response = await executeMiddleware(entry.middleware, context, entry.id);
      if (response) throw response;
    }

    // Step 2: Run loaders with revalidation
    const loaderResult = await resolveLoadersWithRevalidation(
      entry, context, belongsToRoute,
      clientSegmentIds, prevParams, request, prevUrl, nextUrl, routeKey, actionContext
    );
    segments.push(...loaderResult.segments);
    matchedIds.push(...loaderResult.matchedIds);

    // Step 3: Process orphan layouts (for routes, these come before parallels)
    if (entry.type === "route") {
      for (const orphan of entry.layout) {
        const orphanResult = await resolveOrphanLayoutWithRevalidation(
          orphan, params, context, clientSegmentIds, prevParams,
          request, prevUrl, nextUrl, routeKey, loaderPromises, actionContext
        );
        segments.push(...orphanResult.segments);
        matchedIds.push(...orphanResult.matchedIds);
      }
    }

    // Step 4: Process parallel segments
    const parallelResult = await resolveParallelSegmentsWithRevalidation(
      entry, params, context, belongsToRoute,
      clientSegmentIds, prevParams, request, prevUrl, nextUrl, routeKey, actionContext
    );
    segments.push(...parallelResult.segments);
    matchedIds.push(...parallelResult.matchedIds);

    // Step 5: Process orphan layouts (for layouts, these come after parallels)
    if (entry.type === "layout") {
      for (const orphan of entry.layout) {
        const orphanResult = await resolveOrphanLayoutWithRevalidation(
          orphan, params, context, clientSegmentIds, prevParams,
          request, prevUrl, nextUrl, routeKey, loaderPromises, actionContext
        );
        segments.push(...orphanResult.segments);
        matchedIds.push(...orphanResult.matchedIds);
      }
    }

    // Step 6: Execute main handler with revalidation
    const handlerResult = await resolveEntryHandlerWithRevalidation(
      entry, params, context, belongsToRoute,
      clientSegmentIds, prevParams, request, prevUrl, nextUrl, routeKey, actionContext
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
      true, // Orphan loaders belong to the route
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

    // Step 3: Process and emit orphan parallel segments with revalidation
    for (const parallelRecord of orphan.parallel) {
      for (const [slot, handler] of Object.entries(parallelRecord)) {
        const parallelId = `${orphan.shortCode}.${slot}`;

        // Always add to matchedIds
        matchedIds.push(parallelId);

        const component = await revalidate(
          async () => {
            if (!clientSegmentIds.has(parallelId)) return true;

            const dummySegment: ResolvedSegment = {
              id: parallelId,
              namespace: orphan.id,
              type: "parallel",
              index: 0,
              component: null as any,
              params,
              slot,
              belongsToRoute: true, // Orphan's parallel belongs to the route
              parallelName: `${orphan.id}.${slot}`,
            };

            return await evaluateRevalidation(
              dummySegment,
              prevParams,
              null,
              request,
              prevUrl,
              nextUrl,
              orphan.revalidate.map((fn, i) => ({
                name: `revalidate${i}`,
                fn,
              })),
              routeKey,
              context,
              actionContext
            );
          },
          async () =>
            typeof handler === "function" ? await handler(context) : handler,
          () => null
        );

        segments.push({
          id: parallelId,
          namespace: orphan.id,
          type: "parallel",
          index: 0,
          component,
          params,
          slot,
          belongsToRoute: true, // Orphan's parallel belongs to the route
          parallelName: `${orphan.id}.${slot}`,
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
          belongsToRoute: true, // Orphan layout belongs to the route
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
      belongsToRoute: true, // Orphan layout belongs to the route
      layoutName: orphan.id,
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
    const metricsStore = createMetricsStore();

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
    const manifestStart = metricsStore ? performance.now() : 0;
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      metricsStore
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
            // Resolve entry into segments (may return multiple for orphan layouts)
            const resolvedSegments = await resolveSegment(
              entry,
              matched.routeKey,
              matched.params,
              handlerContext,
              loaderPromises
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
   * Evaluate if a segment should revalidate using soft/hard decision pattern
   * Optimized to use prevParams directly and avoid building previous segments
   *
   * @param segment - Current segment to evaluate
   * @param prevParams - Previous route params (from route match, not segment)
   * @param getPrevSegment - Lazy function to get previous segment if needed
   * @param request - Current request
   * @param prevUrl - Previous URL
   * @param nextUrl - Next URL
   * @param revalidations - Custom revalidation functions
   * @param routeKey - Current route key
   * @param context - Handler context
   * @param actionContext - Action context if triggered by action
   */
  async function evaluateRevalidation(
    segment: ResolvedSegment,
    prevParams: Record<string, string>,
    getPrevSegment: (() => Promise<ResolvedSegment | undefined>) | null,
    request: Request,
    prevUrl: URL,
    nextUrl: URL,
    revalidations: Array<{ name: string; fn: any }>,
    routeKey: string,
    context: HandlerContext<any, TEnv>,
    actionContext?: {
      actionId?: string;
      actionUrl?: URL;
      actionResult?: any;
      formData?: FormData;
    }
  ): Promise<boolean> {
    const nextParams = segment.params || {};
    const paramsChanged =
      Object.keys(nextParams).length !== Object.keys(prevParams).length ||
      Object.keys(nextParams).some(
        (key) => nextParams[key] !== prevParams[key]
      );

    // Calculate default revalidation based on segment type and request method
    let defaultShouldRevalidate: boolean;

    if (request.method === "POST") {
      // Actions: revalidate segments that belong to the route, skip parent chain
      if (segment.type === "route") {
        // Route segment always revalidates on actions
        defaultShouldRevalidate = true;
      } else if (segment.belongsToRoute) {
        // Segment belongs to route (orphan layouts/parallels) - revalidate
        defaultShouldRevalidate = true;
      } else {
        // Parent chain segment (shared layouts/parallels) - don't revalidate
        defaultShouldRevalidate = false;
      }
    } else {
      // Navigation (GET): Conservative defaults to minimize unnecessary revalidations
      // Only the route segment revalidates by default - all others require explicit opt-in

      if (segment.type === "route") {
        // Route segments revalidate when params change
        // Routes are the primary param-dependent content and always need updates
        defaultShouldRevalidate = paramsChanged;
        if (paramsChanged) {
          console.log(
            `[Router.evaluateRevalidation] ${segment.id}: ROUTE - params changed, revalidating`
          );
        }
      } else {
        // Layouts and parallels default to no revalidation
        // Cannot assume these segments depend on params without explicit declaration
        // Use custom revalidation functions to opt-in when needed
        defaultShouldRevalidate = false;
        console.log(
          `[Router.evaluateRevalidation] ${
            segment.id
          }: ${segment.type.toUpperCase()} segment - skipping (override with custom revalidation if needed)`
        );
      }
    }

    // No custom revalidations defined - return default behavior without prev segment
    if (revalidations.length === 0) {
      if (defaultShouldRevalidate) {
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: PARAMS CHANGED (default) - revalidating`,
          { prev: prevParams, next: nextParams }
        );
      } else {
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: UNCHANGED (default) - skipping`
        );
      }
      return defaultShouldRevalidate;
    }

    // Custom revalidations exist - may need full prev segment
    // Lazy load prev segment only if getPrevSegment provided
    const prevSegment = getPrevSegment ? await getPrevSegment() : null;

    // Execute revalidation functions with soft/hard decision pattern
    let currentSuggestion = defaultShouldRevalidate;

    for (const { name, fn } of revalidations) {
      const result = fn({
        currentParams: prevSegment?.params || prevParams, // Use segment params if available, else route params
        currentUrl: prevUrl,
        nextParams,
        nextUrl,
        defaultShouldRevalidate: currentSuggestion,
        context,
        // Segment metadata (which segment is being evaluated)
        segmentType: segment.type,
        layoutName: segment.layoutName,
        slotName: segment.slot,
        // Action context (only populated when triggered by server action)
        actionId: actionContext?.actionId,
        actionUrl: actionContext?.actionUrl,
        actionResult: actionContext?.actionResult,
        formData: actionContext?.formData,
        method: request.method, // GET for navigation, POST for actions
        routeName: routeKey, // User-friendly route name (e.g., "products.detail")
      });

      // Check return type:
      // - boolean: hard decision, short-circuit immediately
      // - { defaultShouldRevalidate: boolean }: soft decision, update suggestion and continue
      // - null/undefined: use default behavior (equivalent to returning { defaultShouldRevalidate })
      if (typeof result === "boolean") {
        // Hard decision - short-circuit
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) HARD: ${result}`
        );
        return result;
      } else if (
        result &&
        typeof result === "object" &&
        "defaultShouldRevalidate" in result
      ) {
        // Soft decision - update suggestion and continue
        currentSuggestion = result.defaultShouldRevalidate;
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) SOFT: ${currentSuggestion}`
        );
      } else if (result === null || result === undefined) {
        // Defer to default - equivalent to { defaultShouldRevalidate: currentSuggestion }
        // This means "I don't care, use whatever the default is"
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) DEFER to default: ${currentSuggestion}`
        );
        // currentSuggestion stays the same, continue to next function
      }
    }

    // All revalidators completed - use final suggestion
    console.log(
      `[Router.evaluateRevalidation] ${segment.id}: Final decision: ${currentSuggestion}`
    );
    return currentSuggestion;
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
    const metricsStore = createMetricsStore();

    // Extract client state from query params and header
    const clientSegmentIds =
      url.searchParams.get("_rsc_segments")?.split(",") || [];
    const previousUrl = request.headers.get("X-RSC-Router-Client-Path");

    if (!previousUrl) {
      // No previous URL - fall back to full render
      return null;
    }

    const prevUrl = new URL(previousUrl);

    // Track route matching (direct recording since ALS context not yet available)
    const routeMatchStart = metricsStore ? performance.now() : 0;
    const prevMatch = findMatch(prevUrl.pathname);
    const prevParams = prevMatch?.params || {};

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

    // Load manifest with AsyncLocalStorage context and validation
    // Track manifest loading (direct recording since ALS context not yet available)
    const manifestStart = metricsStore ? performance.now() : 0;
    const manifestEntry = await loadManifest(
      matched.entry,
      matched.routeKey,
      pathname,
      metricsStore
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

      // Collect all segments with revalidation-aware rendering (run within store context for metrics tracking)
      // Now returns both segments to render AND all matched IDs (including skipped loaders)
      const result = await getContext().runWithStore(
        Store,
        Store.namespace || "#router",
        Store.parent,
        async () => {
          const segs: ResolvedSegment[] = [];
          const matchedIds: string[] = [];
          for (const entry of traverseBack(manifestEntry)) {
            // Resolve entry into segments with revalidation checks
            const resolved = await resolveSegmentWithRevalidation(
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
            );

            segs.push(...resolved.segments);
            matchedIds.push(...resolved.matchedIds);
          }
          return { segments: segs, matchedIds };
        }
      );

      const { segments, matchedIds: allMatchedIds } = result;

      // Filter out segments with null components (client already has them)
      // BUT always include loader segments - they carry data even with null component
      const segmentsToRender = segments.filter(
        (s) => s.component !== null || s.type === "loader"
      );

      // Output metrics if enabled
      let serverTiming: string | undefined;
      if (metricsStore) {
        logMetrics(request.method, pathname, metricsStore);
        serverTiming = generateServerTiming(metricsStore);
      }

      return {
        segments: segmentsToRender,
        matched: allMatchedIds, // Use the complete matched IDs including skipped loaders
        diff: segmentsToRender.map((s) => s.id),
        serverTiming,
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
   * Create route builder
   */
  function createRouteBuilder<T extends RouteDefinition>(
    prefix: string,
    routes: ResolvedRouteMap<T>
  ): RouteBuilder<T, TEnv> {
    const currentMountIndex = mountIndex++;
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
        return router;
      },
    };
  }

  /**
   * Router instance
   */
  const router: RSCRouter<TEnv> = {
    routes<T extends RouteDefinition>(
      prefixOrRoutes: string | ResolvedRouteMap<T>,
      maybeRoutes?: ResolvedRouteMap<T>
    ): RouteBuilder<T, TEnv> {
      // If second argument exists, first is prefix
      if (maybeRoutes !== undefined) {
        return createRouteBuilder<T>(prefixOrRoutes as string, maybeRoutes);
      }
      // Otherwise, first argument is routes with empty prefix
      return createRouteBuilder<T>("", prefixOrRoutes as ResolvedRouteMap<T>);
    },

    match,
    matchPartial,
  };

  return router;
}

/**
 * Compile a route pattern to regex
 */
function compilePattern(pattern: string): {
  regex: RegExp;
  paramNames: string[];
} {
  console.log("pattern", pattern);

  const paramNames: string[] = [];
  const regexPattern = pattern
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) {
        const paramName = segment.slice(1);
        paramNames.push(paramName);
        return "([^/]+)";
      }
      if (segment === "*") {
        paramNames.push("*");
        return "(.*)";
      }
      return segment;
    })
    .join("/");

  return {
    regex: new RegExp(`^${regexPattern}$`),
    paramNames,
  };
}
/**
 * Traverse from entry to bottom to top, yielding each EntryData
 * e.g. {child -> parent -> grandparent ...}
 */
function* traverseBack(entry: EntryData): Generator<EntryData> {
  let current: EntryData | null = entry;
  const items = [] as EntryData[];
  while (current !== null) {
    items.push(current); // Move up to next parent
    current = current.parent;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    yield items[i];
  }
}

/**
 * Generator-based segment builder - yields segments lazily
 */
async function* buildSegmentsStream(
  entry: RouteEntry<any>,
  routeKey: string,
  path: string
): AsyncGenerator<EntryData> {
  const manifest = await loadManifest(entry, routeKey, path);
  for (const node of traverseBack(manifest)) {
    yield node;
  }
}

/**
 * Load manifest from route entry with AsyncLocalStorage context
 * Handles lazy imports, unwrapping, and validation
 */
async function loadManifest(
  entry: RouteEntry<any>,
  routeKey: string,
  path: string,
  metricsStore?: MetricsStore
): Promise<EntryData> {
  const Store = getContext().getOrCreateStore(routeKey);

  // Set mount index in store for unique shortCode prefixes
  Store.mountIndex = entry.mountIndex;

  // Attach metrics store to context if provided
  if (metricsStore) {
    Store.metrics = metricsStore;
  }

  // Clear manifest before rebuilding to prevent stale entry mutations
  Store.manifest.clear();

  try {
    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || "#router",
      Store.parent,
      async () => {
        const load = await entry.handler();
        if (
          load &&
          load !== null &&
          typeof load === "object" &&
          "default" in load
        ) {
          return load.default();
        }
        if (typeof load === "function") {
          return load();
        }
        return load;
      }
    );

    invariant(
      useItems && useItems.length > 0,
      "Did not receive any handler from router.map()"
    );
    invariant(
      useItems.some((item) => item.type === "layout"),
      "Top-level handler must be a layout"
    );

    invariant(
      Store.manifest.has(routeKey),
      `Route must be registered for ${routeKey}`
    );

    return Store.manifest.get(routeKey)!;
  } catch (e) {
    throw new RouteNotFoundError(
      `Failed to load route handlers for ${path}: ${(e as Error).message}`,
      {
        cause: {
          error: e,
          state: {
            path,
            routeKey,
          },
        },
      }
    );
  }
}
