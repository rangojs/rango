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
import { get } from "http";
import { getContext } from "./server/context";

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
  route<T extends RouteDefinition>(
    prefix: string,
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
  const routes: RouteEntry<TEnv>[] = [];

  /**
   * Match a pathname against registered routes
   */
  function findMatch(pathname: string): {
    entry: RouteEntry<TEnv>;
    routeKey: string;
    params: Record<string, string>;
  } | null {
    for (const entry of routes) {
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
   * Helper to check if metadata should apply to the current route
   */
  function shouldApplyToRoute(
    keyInfo: { global: boolean; routeName?: string },
    routeKey: string
  ): boolean {
    return keyInfo.global || keyInfo.routeName === routeKey;
  }

  /**
   * Generator-based segment builder - yields segments lazily
   *
   * Benefits:
   * - Zero intermediate array allocations
   * - Lazy evaluation - only build segments that pass filter
   * - Clear single-responsibility
   * - Easier to test and compose
   *
   * @param entry - Route entry with handlers
   * @param routeKey - Current route key
   * @param params - Route params
   * @param context - Handler context
   * @param options - Build options
   * @param options.skipMiddleware - Skip middleware execution (for comparison builds)
   * @param options.metadataOnly - Only build metadata, skip component execution (for comparison)
   */
  async function* buildSegmentsStream(
    entry: RouteEntry<TEnv>,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    options: {
      skipMiddleware?: boolean;
      metadataOnly?: boolean;
    } = {}
  ): AsyncGenerator<ResolvedSegment> {
    const handlers = await loadHandlers(entry.handlers);
    let index = 0;

    // Extract metadata using single-pass iterator
    const metadata = extractMetadata(handlers, routeKey);

    // Execute middleware if needed
    if (!options.skipMiddleware) {
      const allMiddleware = [
        ...metadata.middleware.global,
        ...metadata.middleware.perRoute,
      ];
      if (allMiddleware.length > 0) {
        console.log(
          `[Router.buildSegmentsStream] Executing ${allMiddleware.length} middleware for route: ${routeKey}`
        );
        const middlewareResponse = await executeMiddleware(
          allMiddleware,
          context
        );

        // If middleware returned Response, short-circuit the pipeline
        if (middlewareResponse) {
          console.log(
            `[Router.buildSegmentsStream] Middleware short-circuited with Response`
          );
          throw middlewareResponse;
        }

        console.log(
          `[Router.buildSegmentsStream] Middleware execution complete`
        );
      }
    }

    // Separate layout and route parallels
    const layoutParallels = metadata.parallels.filter((p) => p.isGlobal);
    const routeParallels = metadata.parallels.filter((p) => !p.isGlobal);

    // Yield layouts
    for (const { component, isGlobal, name } of metadata.layouts) {
      // Skip component execution if only metadata needed (for comparison)
      const resolved = options.metadataOnly
        ? null
        : typeof component === "function"
        ? await component(context)
        : component;

      yield {
        id: `L${index}.${entry.registrationId}`,
        type: "layout",
        index: index++,
        component: resolved,
        isGlobal,
        layoutName: name,
        params, // Include params for comparison
      };
    }

    // Yield layout parallels (global parallels that belong to layouts)
    for (const {
      slot,
      handler: parallelHandler,
      isGlobal,
      parallelName,
    } of layoutParallels) {
      // Skip handler execution if only metadata needed
      const component = options.metadataOnly
        ? null
        : await parallelHandler(context);
      yield {
        id: `P${index}.${entry.registrationId}`,
        type: "parallel",
        index: index++,
        component,
        params,
        slot,
        isGlobal,
        parallelName,
      };
    }

    // Yield route
    const handler = handlers[routeKey];
    if (handler) {
      try {
        // Skip handler execution if only metadata needed
        const component = options.metadataOnly ? null : await handler(context);
        yield {
          id: `R${index}.${entry.registrationId}`,
          type: "route",
          index: index++,
          component,
          params,
        };
      } catch (error) {
        // Handler can throw Response as escape hatch (e.g., throw redirect('/login'))
        if (error instanceof Response) {
          console.log(
            `[Router.buildSegmentsStream] Handler threw Response - propagating`
          );
          throw error;
        }
        // Re-throw actual errors
        throw error;
      }
    }

    // Yield route parallels (route-specific parallels)
    for (const {
      slot,
      handler: parallelHandler,
      isGlobal,
      parallelName,
    } of routeParallels) {
      // Skip handler execution if only metadata needed
      const component = options.metadataOnly
        ? null
        : await parallelHandler(context);
      yield {
        id: `P${index}.${entry.registrationId}`,
        type: "parallel",
        index: index++,
        component,
        params,
        slot,
        isGlobal,
        parallelName,
      };
    }
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
    const Store = getContext().getOrCreateStore();

    const res = await getContext().context.run(Store, async () => {
      const res = await matched.entry.handler();
      if ("default" in res) {
        return res.default();
      }
      if (typeof res === "function") {
        return res();
      }
      return res;
    });

    invariant(
      res && res.length > 0,
      "Did not receive any handler from router.map()"
    );
    invariant(res[0].type === "layout", "Top-level handler must be a layout");

    invariant(Store.manifest.has(matched.routeKey), "Route must be registered");

    throw new Error("debug");
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
      for await (const segment of buildSegmentsStream(
        matched.entry,
        matched.routeKey,
        matched.params,
        handlerContext
      )) {
        segments.push(segment);
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
      // Actions: revalidate route-specific segments, skip global ones
      if (segment.type === "layout" || segment.type === "parallel") {
        // For layouts/parallels: only revalidate if route-specific (not global)
        defaultShouldRevalidate = segment.isGlobal === false;
      } else {
        // Routes always revalidate on actions
        defaultShouldRevalidate = true;
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
    const handlers = await loadHandlers(nextMatch.entry.handlers);
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
    routeMap: ResolvedRouteMap<T>,
    registrationId: number
  ): RouteBuilder<T, TEnv> {
    return {
      map(
        handlers:
          | HandlersForRouteMap<T, TEnv>
          | (() => Promise<{ default: HandlersForRouteMap<T, TEnv> }>)
      ) {
        routes.push({
          prefix,
          routes: routeMap as ResolvedRouteMap<any>,
          handlers,
          registrationId,
        });
        return router;
      },
    };
  }

  /**
   * Router instance
   */
  const router: RSCRouter<TEnv> = {
    route<T extends RouteDefinition>(
      prefix: string,
      _routes: ResolvedRouteMap<T>
    ): RouteBuilder<T, TEnv> {
      routes;
      routes.push({
        prefix,
        routes: _routes,
      });
      return;
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
