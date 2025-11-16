import type { ReactNode } from "react";
import { RouteNotFoundError, sanitizeError } from "./errors.js";
import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
  HandlerContext,
  ResolvedSegment,
  MatchResult,
  RouteEntry,
  Handler,
} from "./types.js";

/**
 * Router builder for chaining .use() and .map()
 */
interface RouteBuilder<T extends RouteDefinition, TEnv> {
  map(
    handlers:
      | HandlersForRouteMap<T, TEnv>
      | (() => Promise<{ default: HandlersForRouteMap<T, TEnv> }>)
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
  let nextRegistrationId = 0;

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
   * Load handlers (resolve lazy imports)
   */
  async function loadHandlers(
    handlers:
      | HandlersForRouteMap<any, TEnv>
      | (() => Promise<{ default: HandlersForRouteMap<any, TEnv> }>)
  ): Promise<HandlersForRouteMap<any, TEnv>> {
    if (typeof handlers === "function") {
      const module = await handlers();
      return module.default;
    }
    return handlers;
  }

  /**
   * Helper to detect if a key is a route metadata key
   */
  function getKeyType(
    key: string | symbol
  ):
    | {
        type: "layout" | "parallel" | "middleware";
        global: boolean;
        routeName?: string;
        name?: string;
      }
    | {
        type: "revalidate-route";
        global: boolean;
        routeName?: string;
        name?: string;
      }
    | {
        type: "revalidate-layout";
        global: boolean;
        routeName?: string;
        layoutName: string;
        name?: string;
      }
    | {
        type: "revalidate-parallel";
        global: boolean;
        routeName?: string;
        parallelName: string;
        slotName: string;
        name?: string;
      }
    | null {
    if (typeof key !== "string") return null;

    // New pattern-based format: $layout.{routeName}.{layoutName}
    // Check for layout keys: $layout.*.layoutName or $layout.routeName.layoutName
    // For nested routes: $layout.products.detail.breadcrumbs → routeName: "products.detail", name: "breadcrumbs"
    if (key.startsWith("$layout.")) {
      const parts = key.split(".");
      if (parts.length >= 3) {
        // Last part is always the layout name
        const layoutName = parts[parts.length - 1];
        // Everything between $layout. and .layoutName is the routeName
        const routeNameParts = parts.slice(1, -1);
        const routeName = routeNameParts.join(".");
        const isGlobal = routeName === "*";
        return {
          type: "layout",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
          name: layoutName,
        };
      }
    }

    // Check for parallel keys: $parallel.*.name or $parallel.routeName.name
    // For nested routes: $parallel.products.detail.slots → routeName: "products.detail", name: "slots"
    if (key.startsWith("$parallel.")) {
      const parts = key.split(".");
      if (parts.length >= 3) {
        // Last part is the parallel group name
        const parallelName = parts[parts.length - 1];
        // Everything between $parallel. and .name is the routeName
        const routeNameParts = parts.slice(1, -1);
        const routeName = routeNameParts.join(".");
        const isGlobal = routeName === "*";
        return {
          type: "parallel",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
          name: parallelName,
        };
      }
    }

    // Check for middleware keys: $middleware.*.name or $middleware.routeName.name
    if (key.startsWith("$middleware.")) {
      const parts = key.split(".");
      if (parts.length >= 3) {
        const routeName = parts[1];
        const isGlobal = routeName === "*";
        return {
          type: "middleware",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
        };
      }
    }

    // Check for route revalidate: $revalidate.route.{routeName}.{name}
    // Format: $revalidate.route.products.detail.demo → routeName: "products.detail", name: "demo"
    if (key.startsWith("$revalidate.route.")) {
      const parts = key.split(".");
      // Minimum: $revalidate.route.*.default (4 parts)
      if (parts.length >= 4) {
        const name = parts[parts.length - 1]; // Last part is the revalidation name
        const routeNameParts = parts.slice(2, -1); // Between 'route.' and '.name'
        const routeName = routeNameParts.join(".");
        const isGlobal = routeName === "*";
        return {
          type: "revalidate-route",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
          name,
        };
      }
    }

    // Check for layout revalidate: $revalidate.layout.{routeName}.{layoutName}.{name}
    // Format: $revalidate.layout.products.detail.shop.demo → routeName: "products.detail", layoutName: "shop", name: "demo"
    if (key.startsWith("$revalidate.layout.")) {
      const parts = key.split(".");
      // Minimum: $revalidate.layout.*.shop.default (5 parts)
      if (parts.length >= 5) {
        const name = parts[parts.length - 1]; // Last part is the revalidation name
        const layoutName = parts[parts.length - 2]; // Second to last is layout name
        const routeNameParts = parts.slice(2, -2); // Between 'layout.' and '.{layoutName}.{name}'
        const routeName = routeNameParts.join(".");
        const isGlobal = routeName === "*";
        return {
          type: "revalidate-layout",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
          layoutName,
          name,
        };
      }
    }

    // Check for parallel revalidate: $revalidate.parallel.{routeName}.{parallelName}.{slotName}.{name}
    // Format: $revalidate.parallel.products.detail.related.@related.demo
    if (key.startsWith("$revalidate.parallel.")) {
      const parts = key.split(".");
      // Minimum: $revalidate.parallel.*.sidebar.@sidebar.default (6 parts)
      if (parts.length >= 6) {
        const name = parts[parts.length - 1]; // Last part is the revalidation name
        const slotName = parts[parts.length - 2]; // Second to last is slot name
        const parallelName = parts[parts.length - 3]; // Third to last is parallel name
        const routeNameParts = parts.slice(2, -3); // Between 'parallel.' and '.{parallelName}.{slotName}.{name}'
        const routeName = routeNameParts.join(".");
        const isGlobal = routeName === "*";
        return {
          type: "revalidate-parallel",
          global: isGlobal,
          routeName: isGlobal ? undefined : routeName,
          parallelName,
          slotName,
          name,
        };
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
   * Metadata container with disposable pattern for cleanup
   * Extracted metadata from handlers - layouts, parallels, middleware, revalidations
   */
  interface RouteMetadata {
    layouts: Array<{
      component: ReactNode | Handler;
      isGlobal: boolean;
      name: string;
      revalidations: Array<{ name: string; fn: any }>; // Layout-specific revalidations
    }>;
    parallels: Array<{
      slot: string;
      handler: Handler;
      isGlobal: boolean;
      parallelName: string; // Name used in parallel() helper
      revalidations: Array<{ name: string; fn: any }>; // Parallel-specific revalidations
    }>;
    middleware: { global: any[]; perRoute: any[] };
    routeRevalidations: {
      global: Array<{ name: string; fn: any }>;
      perRoute: Array<{ name: string; fn: any }>;
    };
  }

  /**
   * Extract metadata from handlers using single-pass iteration
   * Returns metadata object with all layouts, parallels, middleware, and revalidations
   */
  function extractMetadata(handlers: any, routeKey: string): RouteMetadata {
    const metadata: RouteMetadata = {
      layouts: [],
      parallels: [],
      middleware: { global: [], perRoute: [] },
      routeRevalidations: { global: [], perRoute: [] },
    };

    // Temporary storage for revalidations by type
    const layoutRevalidations = new Map<string, Array<{ name: string; fn: any }>>();
    const parallelRevalidations = new Map<string, Array<{ name: string; fn: any }>>();

    // First pass: Extract layouts, parallels, middleware
    for (const key of Reflect.ownKeys(handlers)) {
      const keyInfo = getKeyType(key);
      if (!keyInfo) continue;

      const value = handlers[key as any];

      switch (keyInfo.type) {
        case "layout": {
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            const layouts = Array.isArray(value) ? value : [value];
            const layoutName = keyInfo.name || "unnamed";
            metadata.layouts.push(
              ...layouts.map((component: any) => ({
                component,
                isGlobal: keyInfo.global,
                name: layoutName,
                revalidations: [], // Will be populated in second pass
              }))
            );
          }
          break;
        }

        case "parallel": {
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            const slots = value as Record<string, Handler>;
            const parallelName = keyInfo.name || "unnamed";
            metadata.parallels.push(
              ...Object.entries(slots).map(([slot, handler]) => ({
                slot,
                handler,
                isGlobal: keyInfo.global,
                parallelName,
                revalidations: [], // Will be populated in second pass
              }))
            );
          }
          break;
        }

        case "middleware": {
          const middlewareFns = value as any[];
          const target = keyInfo.global
            ? metadata.middleware.global
            : metadata.middleware.perRoute;
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            target.push(...middlewareFns);
          }
          break;
        }
      }
    }

    // Second pass: Extract revalidations and associate with segments
    for (const key of Reflect.ownKeys(handlers)) {
      const keyInfo = getKeyType(key);
      if (!keyInfo) continue;

      const value = handlers[key as any];

      switch (keyInfo.type) {
        case "revalidate-route": {
          const fn = value;
          const target = keyInfo.global
            ? metadata.routeRevalidations.global
            : metadata.routeRevalidations.perRoute;
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            target.push({ name: keyInfo.name || "unnamed", fn });
          }
          break;
        }

        case "revalidate-layout": {
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            const fn = value;
            const layoutKey = `${keyInfo.layoutName}`;
            if (!layoutRevalidations.has(layoutKey)) {
              layoutRevalidations.set(layoutKey, []);
            }
            layoutRevalidations.get(layoutKey)!.push({
              name: keyInfo.name || "unnamed",
              fn,
            });
          }
          break;
        }

        case "revalidate-parallel": {
          if (shouldApplyToRoute(keyInfo, routeKey)) {
            const fn = value;
            // Key by parallelName.slotName for unique identification
            const parallelKey = `${keyInfo.parallelName}.${keyInfo.slotName}`;
            if (!parallelRevalidations.has(parallelKey)) {
              parallelRevalidations.set(parallelKey, []);
            }
            parallelRevalidations.get(parallelKey)!.push({
              name: keyInfo.name || "unnamed",
              fn,
            });
          }
          break;
        }
      }
    }

    // Third pass: Associate revalidations with their segments
    for (const layout of metadata.layouts) {
      const layoutKey = `${layout.name}`;
      if (layoutRevalidations.has(layoutKey)) {
        layout.revalidations = layoutRevalidations.get(layoutKey)!;
      }
    }

    for (const parallel of metadata.parallels) {
      const parallelKey = `${parallel.parallelName}.${parallel.slot}`;
      if (parallelRevalidations.has(parallelKey)) {
        parallel.revalidations = parallelRevalidations.get(parallelKey)!;
      }
    }

    return metadata;
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

    // Yield parallel routes
    for (const {
      slot,
      handler: parallelHandler,
      isGlobal,
      parallelName,
    } of metadata.parallels) {
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
          `[Router.evaluateRevalidation] ${segment.id}: ${segment.type.toUpperCase()} segment - skipping (override with custom revalidation if needed)`
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
    const getRevalidationsForSegment = (segment: ResolvedSegment): Array<{ name: string; fn: any }> => {
      if (segment.type === "route") {
        return [
          ...metadata.routeRevalidations.global,
          ...metadata.routeRevalidations.perRoute,
        ];
      } else if (segment.type === "layout" && segment.layoutName) {
        const layout = metadata.layouts.find((l) => l.name === segment.layoutName);
        return layout?.revalidations || [];
      } else if (segment.type === "parallel" && segment.parallelName && segment.slot) {
        const parallel = metadata.parallels.find(
          (p) => p.parallelName === segment.parallelName && p.slot === segment.slot
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
      routes: ResolvedRouteMap<T>
    ): RouteBuilder<T, TEnv> {
      const registrationId = nextRegistrationId++;
      return createRouteBuilder(prefix, routes, registrationId);
    },

    match,
    matchPartial,
  };

  return router;
}
