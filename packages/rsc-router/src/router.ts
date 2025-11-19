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
} from "./types";
import { AllUseItems } from "./route-definition";
import { EntryData, getContext } from "./server/context";
import { error } from "console";

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

  matchPartial(request: Request, context: TEnv): Promise<MatchResult | null>;
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
 * const router = createRSCRouter<AppContext>();
 *
 * router
 *   .route('/blog', blogRoutes)
 *   .map(() => import('./blog.handlers'));
 * ```
 */
export function createRSCRouter<TEnv = any>(): RSCRouter<TEnv> {
  const routesEntries: RouteEntry<TEnv>[] = [];

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
    ctx: HandlerContext<any, TEnv>
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

      const currentMiddleware = middleware[index++];

      try {
        const result = await currentMiddleware(ctx, next);

        // Check if middleware short-circuited with Response
        if (result instanceof Response) {
          earlyResponse = result;
          console.log(
            `[Router.executeMiddleware] Middleware returned Response - short-circuit`
          );
        }
      } catch (error) {
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
   * Resolve segments from EntryData
   * Executes middlewares, loaders, parallels, and handlers in correct order
   * Returns array: [main segment, ...orphan layout segments]
   */
  async function resolveSegment(
    entry: EntryData,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>
  ): Promise<ResolvedSegment[]> {
    const segments: ResolvedSegment[] = [];

    if (entry.type === "layout") {
      // Layout execution order:
      // 1. Layout MW → 2. Layout Loader → 3. Layout Parallels (emit segments) → 4. Layout Handler (emit segment) → 5. Orphan Layouts

      // Step 1: Run layout middleware
      if (entry.middleware.length > 0) {
        const middlewareResponse = await executeMiddleware(
          entry.middleware,
          context
        );
        if (middlewareResponse) throw middlewareResponse;
      }

      // Step 2: Run layout loaders
      // TODO: Run entry loaders (entry.loader)

      // Step 3: Process and emit layout parallel segments
      for (const parallelRecord of entry.parallel) {
        // TODO: Run parallel loaders before executing handlers
        for (const [slot, handler] of Object.entries(parallelRecord)) {
          const component =
            typeof handler === "function" ? await handler(context) : handler;

          // Emit parallel segment
          segments.push({
            id: `P.${entry.id}.${slot}`,
            type: "parallel",
            index: 0,
            component,
            params,
            slot,
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
        id: `L.${entry.id}`,
        type: "layout",
        index: 0,
        component,
        params,
        layoutName: entry.id,
      });

      // Step 5: Process orphan layouts
      for (const orphan of entry.layout) {
        const orphanSegments = await resolveOrphanLayout(
          orphan,
          params,
          context
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
          context
        );
        if (middlewareResponse) throw middlewareResponse;
      }

      // Step 2: Run route loaders
      // TODO: Run entry loaders (entry.loader)

      // Step 3: Process orphan layouts first
      for (const orphan of entry.layout) {
        const orphanSegments = await resolveOrphanLayout(
          orphan,
          params,
          context
        );
        segments.push(...orphanSegments);
      }

      // Step 4: Process and emit route parallel segments
      for (const parallelRecord of entry.parallel) {
        // TODO: Run parallel loaders before executing handlers
        for (const [slot, handler] of Object.entries(parallelRecord)) {
          const component =
            typeof handler === "function" ? await handler(context) : handler;

          // Emit parallel segment
          segments.push({
            id: `P.${entry.id}.${slot}`,
            type: "parallel",
            index: 0,
            component,
            params,
            slot,
            parallelName: `${entry.id}.${slot}`,
          });
        }
      }

      // Step 5: Execute route handler and emit route segment
      const component = await entry.handler(context);

      segments.push({
        id: `R.${entry.id}`,
        type: "route",
        index: 0,
        component,
        params,
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
    context: HandlerContext<any, TEnv>
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
        context
      );
      if (middlewareResponse) throw middlewareResponse;
    }

    // Step 2: Run orphan loaders
    // TODO: Run orphan loaders (orphan.loader)

    // Step 3: Process and emit orphan parallel segments
    const segments: ResolvedSegment[] = [];
    for (const parallelRecord of orphan.parallel) {
      // TODO: Run parallel loaders
      for (const [slot, handler] of Object.entries(parallelRecord)) {
        const component =
          typeof handler === "function" ? await handler(context) : handler;

        // Emit parallel segment
        segments.push({
          id: `P.${orphan.id}.${slot}`,
          type: "parallel",
          index: 0,
          component,
          params,
          slot,
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
      id: `L.${orphan.id}`,
      type: "layout",
      index: 0,
      component,
      params,
      layoutName: orphan.id,
    });

    return segments;
  }

  /**
   * Match request and return segments
   * Uses generator-based stream for efficient segment building
   */
  async function match(request: Request, context: TEnv): Promise<MatchResult> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const matched = findMatch(pathname);
    if (!matched) {
      throw new RouteNotFoundError(`No route matched for ${pathname}`, {
        cause: {
          pathname,
          method: request.method,
        },
      });
    }

    // Load manifest with AsyncLocalStorage context and validation
    await loadManifest(matched.entry, matched.routeKey, pathname);

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
      // Collect all segments from stream
      const segments: ResolvedSegment[] = [];
      for await (const entry of buildSegmentsStream(
        matched.entry,
        matched.routeKey,
        pathname
      )) {
        // Resolve entry into segments (may return multiple for orphan layouts)
        const resolvedSegments = await resolveSegment(
          entry,
          matched.routeKey,
          matched.params,
          handlerContext
        );

        segments.push(...resolvedSegments);
      }

      const segmentIds = segments.map((s) => s.id);

      return {
        segments,
        matched: segmentIds,
        diff: segmentIds,
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
    context: TEnv,
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
      // Actions: revalidate all segments by default
      // TODO: Add global vs route-specific tracking for optimization
      defaultShouldRevalidate = true;
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

      // Check if hard decision (boolean) or soft decision (object)
      if (typeof result === "boolean") {
        // Hard decision - short-circuit
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) HARD: ${result}`
        );
        return result;
      } else {
        // Soft decision - update suggestion and continue
        currentSuggestion = result.defaultShouldRevalidate;
        console.log(
          `[Router.evaluateRevalidation] ${segment.id}: REVALIDATE (${name}) SOFT: ${currentSuggestion}`
        );
      }
    }

    // All revalidators returned soft decisions - use final suggestion
    console.log(
      `[Router.evaluateRevalidation] ${segment.id}: All SOFT decisions - final: ${currentSuggestion}`
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

    // Extract client state from query params and header
    const clientSegmentIds =
      url.searchParams.get("_rsc_segments")?.split(",") || [];
    const previousUrl = request.headers.get("X-RSC-Router-Client-Path");

    if (!previousUrl) {
      // No previous URL - fall back to full render
      return null;
    }

    // Match current route
    const nextMatch = findMatch(pathname);
    if (!nextMatch) {
      throw new RouteNotFoundError(`No route matched for ${pathname}`, {
        cause: {
          pathname,
          method: request.method,
          previousUrl,
        },
      });
    }

    // Match previous route
    const prevUrl = new URL(previousUrl);
    const prevMatch = findMatch(prevUrl.pathname);

    // Extract bindings from context
    const bindings = (context as any)?.Bindings || {};

    // Extract previous params from route match without building segments
    // Optimization: params available from findMatch result, no segment building needed
    const prevParams = prevMatch?.params || {};

    // Lazy loader for previous segments - only builds if custom revalidation needs them
    // Most navigations skip this entirely when using default revalidation logic
    let prevSegmentsMap: Map<string, ResolvedSegment> | null = null;
    let prevSegmentsBuildStarted = false;

    const buildPrevSegmentsLazy = async (): Promise<
      Map<string, ResolvedSegment>
    > => {
      if (prevSegmentsMap) {
        return prevSegmentsMap; // Already built
      }

      if (!prevSegmentsBuildStarted) {
        prevSegmentsBuildStarted = true;
        console.log(`[Router.matchPartial] Building prev segments (lazy)...`);
      }

      prevSegmentsMap = new Map();
      if (!prevMatch) {
        return prevSegmentsMap;
      }

      const prevContext = createHandlerContext(
        prevMatch.params,
        request,
        prevUrl.searchParams,
        prevUrl.pathname,
        prevUrl,
        bindings
      );

      // Build metadata-only segments for comparison
      // Skip middleware and component execution - only need segment structure and params
      for await (const segment of buildSegmentsStream(
        prevMatch.entry,
        prevMatch.routeKey,
        prevMatch.params,
        prevContext,
        { skipMiddleware: true, metadataOnly: true }
      )) {
        prevSegmentsMap.set(segment.id, segment);
      }

      console.log(
        `[Router.matchPartial] Prev segments built: ${prevSegmentsMap.size}`
      );
      return prevSegmentsMap;
    };

    const handlerContext = createHandlerContext(
      nextMatch.params,
      request,
      url.searchParams,
      pathname,
      url,
      bindings
    );

    // Extract metadata to get revalidations (without loading components)
    const handlers = await loadManifest(nextMatch.entry, nextMatch.routeKey);
    const metadata = extractMetadata(handlers, nextMatch.routeKey);

    // Helper to get revalidations for a specific segment
    const getRevalidationsForSegment = (
      segment: ResolvedSegment
    ): Array<{ name: string; fn: any }> => {
      if (segment.type === "route") {
        return [
          ...metadata.routeRevalidations.global,
          ...metadata.routeRevalidations.perRoute,
        ];
      } else if (segment.type === "layout" && segment.layoutName) {
        const layout = metadata.layouts.find(
          (l) => l.name === segment.layoutName
        );
        return layout?.revalidations || [];
      } else if (
        segment.type === "parallel" &&
        segment.parallelName &&
        segment.slot
      ) {
        const parallel = metadata.parallels.find(
          (p) =>
            p.parallelName === segment.parallelName && p.slot === segment.slot
        );
        return parallel?.revalidations || [];
      }
      return [];
    };

    const clientSegmentSet = new Set(clientSegmentIds);
    const segmentsToRender: ResolvedSegment[] = [];
    const allSegmentIds: string[] = [];

    try {
      // Stream next segments with inline filtering
      for await (const segment of buildSegmentsStream(
        nextMatch.entry,
        nextMatch.routeKey,
        nextMatch.params,
        handlerContext
      )) {
        allSegmentIds.push(segment.id);

        // Client doesn't have segment = include it
        if (!clientSegmentSet.has(segment.id)) {
          console.log(`[Router.matchPartial] ${segment.id}: NEW - including`);
          segmentsToRender.push(segment);
          continue;
        }

        // Get segment-specific revalidations from metadata
        const segmentRevalidations = getRevalidationsForSegment(segment);

        // Provide lazy prev segment loader only if custom revalidations exist
        // Without custom revalidation, default logic uses params only
        const getPrevSegment =
          segmentRevalidations.length > 0
            ? async () => {
                const map = await buildPrevSegmentsLazy();
                return map.get(segment.id);
              }
            : null;

        const shouldRevalidate = await evaluateRevalidation(
          segment,
          prevParams,
          getPrevSegment,
          request,
          prevUrl,
          url,
          segmentRevalidations,
          nextMatch.routeKey,
          context,
          actionContext
        );

        if (shouldRevalidate) {
          segmentsToRender.push(segment);
        }
      }

      // Log if we avoided building prev segments
      if (!prevSegmentsBuildStarted) {
        console.log(
          `[Router.matchPartial] Optimization: Skipped building prev segments entirely`
        );
      }

      return {
        segments: segmentsToRender,
        matched: allSegmentIds,
        diff: segmentsToRender.map((s) => s.id),
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
  path: string
): Promise<EntryData> {
  const Store = getContext().getOrCreateStore(routeKey);
  try {
    const useItems = await getContext().runWithStore(
      Store,
      Store.namespace || "#" + routeKey + ".",
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
