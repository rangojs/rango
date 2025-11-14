import type { ReactNode } from 'react';
import { RouteNotFoundError, sanitizeError } from './errors.js';
import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
  HandlerContext,
  ResolvedSegment,
  MatchResult,
  RouteEntry,
  Handler,
} from './types.js';

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
      if (!key.startsWith('_rsc')) {
        cleanSearchParams.set(key, value);
      }
    });

    // Create clean URL without system params
    const cleanUrl = new URL(url);
    cleanUrl.search = cleanSearchParams.toString();

    return {
      params,
      request,
      searchParams: cleanSearchParams,  // Filtered params
      pathname,
      url: cleanUrl,                    // Clean URL
      env: bindings,
      var: variables,
      get: (key: string) => variables[key],
      set: (key: string, value: any) => {
        variables[key] = value;
      },
      _originalRequest: request,        // Raw request for advanced use
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
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          const paramName = segment.slice(1);
          paramNames.push(paramName);
          return '([^/]+)';
        }
        if (segment === '*') {
          paramNames.push('*');
          return '(.*)';
        }
        return segment;
      })
      .join('/');

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
        if (entry.prefix === '' || entry.prefix === '/') {
          fullPattern = pattern;
        } else if (pattern === '/' || pattern === '') {
          fullPattern = entry.prefix;
        } else {
          fullPattern = entry.prefix + pattern;
        }

        const { regex, paramNames } = compilePattern(fullPattern);
        const match = regex.exec(pathname);

        if (match) {
          const params: Record<string, string> = {};
          paramNames.forEach((name, index) => {
            params[name] = match[index + 1] || '';
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
    if (typeof handlers === 'function') {
      const module = await handlers();
      return module.default;
    }
    return handlers;
  }

  /**
   * Helper to detect if a key is a route metadata key
   */
  function getKeyType(key: string | symbol):
    | { type: 'layout' | 'parallel' | 'middleware' | 'revalidate'; global: boolean; routeName?: string; name?: string }
    | null {
    if (typeof key !== 'string') return null;

    // New pattern-based format: $layout.{routeName}.{layoutName}
    // Check for layout keys: $layout.*.layoutName or $layout.routeName.layoutName
    // For nested routes: $layout.products.detail.breadcrumbs → routeName: "products.detail", name: "breadcrumbs"
    if (key.startsWith('$layout.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        // Last part is always the layout name
        const layoutName = parts[parts.length - 1];
        // Everything between $layout. and .layoutName is the routeName
        const routeNameParts = parts.slice(1, -1);
        const routeName = routeNameParts.join('.');
        const isGlobal = routeName === '*';
        return { type: 'layout', global: isGlobal, routeName: isGlobal ? undefined : routeName, name: layoutName };
      }
    }

    // Check for parallel keys: $parallel.*.name or $parallel.routeName.name
    // For nested routes: $parallel.products.detail.slots → routeName: "products.detail", name: "slots"
    if (key.startsWith('$parallel.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        // Last part is the parallel group name
        const parallelName = parts[parts.length - 1];
        // Everything between $parallel. and .name is the routeName
        const routeNameParts = parts.slice(1, -1);
        const routeName = routeNameParts.join('.');
        const isGlobal = routeName === '*';
        return { type: 'parallel', global: isGlobal, routeName: isGlobal ? undefined : routeName, name: parallelName };
      }
    }

    // Check for middleware keys: $middleware.*.name or $middleware.routeName.name
    if (key.startsWith('$middleware.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        const routeName = parts[1];
        const isGlobal = routeName === '*';
        return { type: 'middleware', global: isGlobal, routeName: isGlobal ? undefined : routeName };
      }
    }

    // Check for revalidate: $revalidate.routeName.name
    // Format: $revalidate.products.detail.demo → routeName: "products.detail", name: "demo"
    if (key.startsWith('$revalidate.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        // Extract: everything between '$revalidate.' and the last part (which is the name)
        const name = parts[parts.length - 1]; // Last part is always the name
        const routeNameParts = parts.slice(1, -1); // Everything between $revalidate. and .name
        const routeName = routeNameParts.join('.'); // Rejoin for nested routes
        const isGlobal = routeName === '*';
        return { type: 'revalidate', global: isGlobal, routeName: isGlobal ? undefined : routeName, name };
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
          console.log(`[Router.executeMiddleware] Middleware returned Response - short-circuit`);
        }
      } catch (error) {
        // Middleware threw error - propagate it
        console.error(`[Router.executeMiddleware] Middleware threw error:`, error);
        throw error;
      }
    };

    await next();
    return earlyResponse; // null if all middleware called next()
  }

  /**
   * Build segments from matched route using positional extraction
   *
   * @param skipMiddleware - If true, skip middleware execution (for building prev segments in comparison)
   */
  async function buildSegments(
    entry: RouteEntry<TEnv>,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TEnv>,
    skipMiddleware = false
  ): Promise<ResolvedSegment[]> {
    const handlers = await loadHandlers(entry.handlers);
    const segments: ResolvedSegment[] = [];
    let index = 0;

    // Track global metadata (wildcard '*' routes)
    const globalLayouts: Array<{ component: ReactNode | Handler; name: string }> = [];
    const globalParallel: Record<string, Handler> = {};
    const globalMiddleware: any[] = [];

    // Track per-route metadata (specific to routeKey)
    const perRouteLayouts: Array<{ component: ReactNode | Handler; name: string }> = [];
    const perRouteParallel: Record<string, Handler> = {};
    const perRouteMiddleware: any[] = [];

    // Use Reflect.ownKeys to preserve insertion order (symbols + strings)
    const keys = Reflect.ownKeys(handlers);

    // PASS 1: Process all metadata keys to accumulate
    for (const key of keys) {
      const keyInfo = getKeyType(key);
      if (!keyInfo) continue;

      const value = handlers[key as any];

      if (keyInfo.type === 'layout') {
        const layouts = Array.isArray(value) ? (value as unknown as (ReactNode | Handler)[]) : [value as unknown as (ReactNode | Handler)];
        const layoutName = keyInfo.name || 'unnamed';
        if (keyInfo.global) {
          // Global: Add to global layouts with name
          globalLayouts.push(...layouts.map(component => ({ component, name: layoutName })));
        } else if (keyInfo.routeName === routeKey) {
          // Per-route: Only add if routeName matches current routeKey
          perRouteLayouts.push(...layouts.map(component => ({ component, name: layoutName })));
        }
      } else if (keyInfo.type === 'parallel') {
        const slots = value as unknown as Record<string, Handler>;
        if (keyInfo.global) {
          // Global: Merge into global parallel
          Object.assign(globalParallel, slots);
        } else if (keyInfo.routeName === routeKey) {
          // Per-route: Only add if routeName matches current routeKey
          Object.assign(perRouteParallel, slots);
        }
      } else if (keyInfo.type === 'middleware') {
        const middlewareFns = value as any[];
        if (keyInfo.global) {
          // Global middleware: Apply to all routes
          globalMiddleware.push(...middlewareFns);
        } else if (keyInfo.routeName === routeKey) {
          // Per-route middleware: Only add if routeName matches current routeKey
          perRouteMiddleware.push(...middlewareFns);
        }
      }
      // Skip revalidate (handled separately in matchPartial)
    }

    // Execute middleware before processing handlers
    // Global middleware runs first, then route-specific middleware
    if (!skipMiddleware) {
      const allMiddleware = [...globalMiddleware, ...perRouteMiddleware];
      if (allMiddleware.length > 0) {
        console.log(`[Router.buildSegments] Executing ${allMiddleware.length} middleware for route: ${routeKey}`);
        const middlewareResponse = await executeMiddleware(allMiddleware, context);

        // If middleware returned Response, short-circuit the pipeline
        if (middlewareResponse) {
          console.log(`[Router.buildSegments] Middleware short-circuited with Response`);
          throw middlewareResponse; // Propagate Response to be caught by caller
        }

        console.log(`[Router.buildSegments] Middleware execution complete`);
      }
    }

    // PASS 2: Process route handlers
    for (const key of keys) {
      if (typeof key === 'string' && !key.startsWith('$')) {
        // It's a route handler (not a metadata key)
        if (key === routeKey) {
          // Combine global layouts + per-route layouts
          const allLayouts: Array<{ component: ReactNode | Handler; isGlobal: boolean; name: string }> = [
            ...globalLayouts.map(({ component, name }) => ({ component, isGlobal: true, name })),
            ...perRouteLayouts.map(({ component, name }) => ({ component, isGlobal: false, name }))
          ];

          for (const { component: layout, isGlobal, name } of allLayouts) {
            // Check if layout is a handler function
            const component = typeof layout === 'function'
              ? await layout(context)
              : layout;

            segments.push({
              id: `L${index}.${entry.registrationId}`,
              type: 'layout',
              index,
              component,
              isGlobal, // Track if global or route-specific
              layoutName: name, // Layout identifier
            });
            index++;
          }

          // Process route handler
          const handler = handlers[key];
          if (handler) {
            try {
              const component = await handler(context);
              segments.push({
                id: `R${index}.${entry.registrationId}`,
                type: 'route',
              index,
              component,
              params,
            });
              index++;
            } catch (error) {
              // Handler can throw Response as escape hatch (e.g., throw redirect('/login'))
              if (error instanceof Response) {
                console.log(`[Router.buildSegments] Handler threw Response - propagating`);
                throw error;
              }
              // Re-throw actual errors
              throw error;
            }
          }

          // Process parallel routes (track global vs route-specific)
          const allParallels: Array<{ slot: string; handler: Handler; isGlobal: boolean }> = [
            ...Object.entries(globalParallel).map(([slot, handler]) => ({ slot, handler, isGlobal: true })),
            ...Object.entries(perRouteParallel).map(([slot, handler]) => ({ slot, handler, isGlobal: false }))
          ];

          if (allParallels.length > 0) {
            for (const { slot, handler: parallelHandler, isGlobal } of allParallels) {
              const component = await parallelHandler(context);
              segments.push({
                id: `P${index}.${entry.registrationId}`,
                type: 'parallel',
                index,
                component,
                params,
                slot,
                isGlobal, // Track if global or route-specific
              });
              index++;
            }
          }

          break;  // Found our route, stop processing
        }
      }
    }

    return segments;
  }

  /**
   * Match request and return segments
   */
  async function match(
    request: Request,
    context: TEnv
  ): Promise<MatchResult> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const matched = findMatch(pathname);
    if (!matched) {
      throw new RouteNotFoundError(`No route matched for ${pathname}`, {
        cause: {
          pathname,
          method: request.method,
          registeredRoutes: routes.map(r => ({
            prefix: r.prefix,
            routes: Object.keys(r.routes),
          })),
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
      const segments = await buildSegments(
        matched.entry,
        matched.routeKey,
        matched.params,
        handlerContext
      );

      const segmentIds = segments.map((s) => s.id);

      return {
        segments,
        matched: segmentIds,
        diff: segmentIds,
      };
    } catch (error) {
      // Check if middleware/handler short-circuited with Response
      if (error instanceof Response) {
        console.log(`[Router.match] Response short-circuit - returning directly`);
        throw error; // Propagate to top-level handler (entry.rsc.tsx)
      }

      // Sanitize error for production security
      console.error(`[Router.match] Error during match:`, error);
      throw sanitizeError(error);
    }
  }

  /**
   * Extract revalidation functions from handlers
   */
  async function extractRevalidations(
    handlers: any,
    routeKey: string
  ): Promise<{ global: any[]; perRoute: any[] }> {
    const loadedHandlers = await loadHandlers(handlers);
    const global: any[] = [];
    const perRoute: any[] = [];

    const keys = Reflect.ownKeys(loadedHandlers);
    for (const key of keys) {
      const keyInfo = getKeyType(key);
      if (keyInfo?.type === 'revalidate') {
        const fn = loadedHandlers[key as any];
        if (keyInfo.global) {
          global.push({ name: keyInfo.name, fn });
        } else if (keyInfo.routeName === routeKey) {
          perRoute.push({ name: keyInfo.name, fn });
        }
      }
    }

    return { global, perRoute };
  }

  /**
   * Match partial request with revalidation
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
      url.searchParams.get('_rsc_segments')?.split(',') || [];
    const previousUrl = request.headers.get('X-RSC-Router-Client-Path');

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
          registeredRoutes: routes.map(r => ({
            prefix: r.prefix,
            routes: Object.keys(r.routes),
          })),
        },
      });
    }

    // Match previous route
    const prevUrl = new URL(previousUrl);
    const prevMatch = findMatch(prevUrl.pathname);

    // If navigating to a different route handler, force full re-render
    if (prevMatch && prevMatch.routeKey !== nextMatch.routeKey) {
      console.log(`[Router.matchPartial] Different route handler: ${prevMatch.routeKey} → ${nextMatch.routeKey}`);
      // Return null to trigger full render
      return null;
    }

    // Extract bindings from context
    const bindings = (context as any)?.Bindings || {};

    // Build previous segments for comparison
    let prevSegments: ResolvedSegment[] = [];
    if (prevMatch) {
      const prevContext = createHandlerContext(
        prevMatch.params,
        request,
        prevUrl.searchParams,
        prevUrl.pathname,
        prevUrl,
        bindings
      );
      prevSegments = await buildSegments(
        prevMatch.entry,
        prevMatch.routeKey,
        prevMatch.params,
        prevContext,
        true  // Skip middleware for prev segments (comparison only)
      );
    }

    const handlerContext = createHandlerContext(
      nextMatch.params,
      request,
      url.searchParams,
      pathname,
      url,
      bindings
    );

    // Build all segments for current route
    let allSegments;
    try {
      allSegments = await buildSegments(
        nextMatch.entry,
        nextMatch.routeKey,
        nextMatch.params,
        handlerContext
      );
    } catch (error) {
      // Check if middleware/handler short-circuited with Response
      if (error instanceof Response) {
        console.log(`[Router.matchPartial] Response short-circuit - returning directly`);
        throw error; // Propagate to top-level handler
      }

      // Sanitize error for production security
      console.error(`[Router.matchPartial] Error during matchPartial:`, error);
      throw sanitizeError(error);
    }

    // Extract revalidation functions for this route
    const revalidations = await extractRevalidations(
      nextMatch.entry.handlers,
      nextMatch.routeKey
    );

    // Filter: only render segments client doesn't have or need revalidation
    const clientSegmentSet = new Set(clientSegmentIds);
    const segmentsToRender: ResolvedSegment[] = [];

    for (const segment of allSegments) {
      if (!clientSegmentSet.has(segment.id)) {
        // Client doesn't have this segment
        console.log(`[Router.matchPartial] ${segment.id}: NEW - including`);
        segmentsToRender.push(segment);
        continue;
      }

      // Client has this segment - determine if it needs revalidation
      const prevSegment = prevSegments.find((s) => s.id === segment.id);

      // Calculate default revalidation based on segment type and request method
      const prevParams = prevSegment?.params || {};
      const nextParams = segment.params || {};
      const paramsChanged =
        Object.keys(nextParams).length !== Object.keys(prevParams).length ||
        Object.keys(nextParams).some((key) => nextParams[key] !== prevParams[key]);

      let defaultShouldRevalidate: boolean;

      if (request.method === 'POST') {
        // Actions: revalidate route-specific segments, skip global ones
        if (segment.type === 'layout' || segment.type === 'parallel') {
          // For layouts/parallels: only revalidate if route-specific (not global)
          defaultShouldRevalidate = segment.isGlobal === false;
        } else {
          // Routes always revalidate on actions
          defaultShouldRevalidate = true;
        }
      } else {
        // Navigation: revalidate if params changed
        defaultShouldRevalidate = paramsChanged;
      }

      // Execute revalidation functions with soft/hard decision pattern
      // Order: global functions first, then route-specific functions
      const allRevalidations = [...revalidations.global, ...revalidations.perRoute];
      let shouldRevalidate = false;
      let currentSuggestion = defaultShouldRevalidate;

      if (allRevalidations.length > 0) {
        // Custom revalidation functions exist - execute with soft/hard decision pattern
        let hardDecisionMade = false;

        for (const { name, fn } of allRevalidations) {
          const result = fn({
            currentParams: prevParams,
            currentUrl: prevUrl,
            nextParams,
            nextUrl: url,
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
            routeName: nextMatch.routeKey, // User-friendly route name (e.g., "products.detail")
          });

          // Check if hard decision (boolean) or soft decision (object)
          if (typeof result === 'boolean') {
            // Hard decision - short-circuit
            console.log(
              `[Router.matchPartial] ${segment.id}: REVALIDATE (${name}) HARD decision: ${result} - short-circuit`
            );
            shouldRevalidate = result;
            hardDecisionMade = true;
            break;
          } else {
            // Soft decision - update suggestion and continue
            currentSuggestion = result.defaultShouldRevalidate;
            console.log(
              `[Router.matchPartial] ${segment.id}: REVALIDATE (${name}) SOFT decision: ${currentSuggestion} - continuing`
            );
          }
        }

        if (!hardDecisionMade) {
          // All revalidators returned soft decisions - use final suggestion
          shouldRevalidate = currentSuggestion;
          console.log(
            `[Router.matchPartial] ${segment.id}: All SOFT decisions - final suggestion: ${shouldRevalidate}`
          );
        }
      } else {
        // No custom revalidations - use default behavior
        shouldRevalidate = defaultShouldRevalidate;
        if (shouldRevalidate) {
          console.log(
            `[Router.matchPartial] ${segment.id}: PARAMS CHANGED (default) - revalidating`,
            { prev: prevParams, next: nextParams }
          );
        } else {
          console.log(`[Router.matchPartial] ${segment.id}: UNCHANGED (default) - skipping`);
        }
      }

      if (shouldRevalidate) {
        segmentsToRender.push(segment);
      }
    }

    return {
      segments: segmentsToRender,
      matched: allSegments.map((s) => s.id),
      diff: segmentsToRender.map((s) => s.id),
    };
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
