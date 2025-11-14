import type { ReactNode } from 'react';
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

    return {
      params,
      request,
      searchParams,
      pathname,
      url,
      env: bindings,
      var: variables,
      get: (key: string) => variables[key],
      set: (key: string, value: any) => {
        variables[key] = value;
      },
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
    if (key.startsWith('$layout.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        const routeName = parts[1]; // '*' for global, or route name
        const isGlobal = routeName === '*';
        return { type: 'layout', global: isGlobal, routeName: isGlobal ? undefined : routeName };
      }
    }

    // Check for parallel keys: $parallel.*.name or $parallel.routeName.name
    if (key.startsWith('$parallel.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        const routeName = parts[1];
        const isGlobal = routeName === '*';
        return { type: 'parallel', global: isGlobal, routeName: isGlobal ? undefined : routeName };
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
    if (key.startsWith('$revalidate.')) {
      const parts = key.split('.');
      if (parts.length >= 3) {
        const routeName = parts[1];
        const isGlobal = routeName === '*';
        const name = parts[2];
        return { type: 'revalidate', global: isGlobal, routeName: isGlobal ? undefined : routeName, name };
      }
    }

    return null;
  }

  /**
   * Execute middleware chain with recursive chaining
   */
  async function executeMiddleware(
    middleware: any[],
    ctx: HandlerContext<any, TEnv>
  ): Promise<void> {
    if (middleware.length === 0) {
      return;
    }

    let index = 0;

    const next = async (): Promise<void> => {
      if (index >= middleware.length) {
        return;
      }

      const currentMiddleware = middleware[index++];
      await currentMiddleware(ctx, next);
    };

    await next();
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
    const globalLayouts: (ReactNode | Handler)[] = [];
    const globalParallel: Record<string, Handler> = {};
    const globalMiddleware: any[] = [];

    // Track per-route metadata (specific to routeKey)
    const perRouteLayouts: (ReactNode | Handler)[] = [];
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
        if (keyInfo.global) {
          // Global: Add to global layouts
          globalLayouts.push(...layouts);
        } else if (keyInfo.routeName === routeKey) {
          // Per-route: Only add if routeName matches current routeKey
          perRouteLayouts.push(...layouts);
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
        await executeMiddleware(allMiddleware, context);
        console.log(`[Router.buildSegments] Middleware execution complete`);
      }
    }

    // PASS 2: Process route handlers
    for (const key of keys) {
      if (typeof key === 'string' && !key.startsWith('$')) {
        // It's a route handler (not a metadata key)
        if (key === routeKey) {
          // Combine global layouts + per-route layouts
          const allLayouts = [...globalLayouts, ...perRouteLayouts];
          for (const layout of allLayouts) {
            // Check if layout is a handler function
            const component = typeof layout === 'function'
              ? await layout(context)
              : layout;

            segments.push({
              id: `L${index}.${entry.registrationId}`,
              type: 'layout',
              index,
              component,
            });
            index++;
          }

          // Process route handler
          const handler = handlers[key];
          if (handler) {
            const component = await handler(context);
            segments.push({
              id: `R${index}.${entry.registrationId}`,
              type: 'route',
              index,
              component,
              params,
            });
            index++;
          }

          // Process parallel routes (merge global + per-route)
          const mergedParallel = { ...globalParallel, ...perRouteParallel };
          if (Object.keys(mergedParallel).length > 0) {
            for (const [slot, parallelHandler] of Object.entries(mergedParallel)) {
              const component = await parallelHandler(context);
              segments.push({
                id: `P${index}.${entry.registrationId}`,
                type: 'parallel',
                index,
                component,
                params,
                slot,
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
      throw new Error(`No route matched for ${pathname}`);
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
    context: TEnv
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
      throw new Error(`No route matched for ${pathname}`);
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
    const allSegments = await buildSegments(
      nextMatch.entry,
      nextMatch.routeKey,
      nextMatch.params,
      handlerContext
    );

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

      // Calculate default revalidation (true if params changed)
      const prevParams = prevSegment?.params || {};
      const nextParams = segment.params || {};
      const defaultShouldRevalidate =
        Object.keys(nextParams).length !== Object.keys(prevParams).length ||
        Object.keys(nextParams).some((key) => nextParams[key] !== prevParams[key]);

      // Execute revalidation functions with short-circuit OR logic
      // Order: global functions first, then route-specific functions
      const allRevalidations = [...revalidations.global, ...revalidations.perRoute];
      let shouldRevalidate = false;

      if (allRevalidations.length > 0) {
        // Custom revalidation functions exist - execute with short-circuit
        for (const { name, fn } of allRevalidations) {
          const result = fn({
            currentParams: prevParams,
            currentUrl: prevUrl,
            nextParams,
            nextUrl: url,
            defaultShouldRevalidate,
            context,
          });

          if (result === true) {
            console.log(
              `[Router.matchPartial] ${segment.id}: REVALIDATE (${name}) returned TRUE - revalidating`
            );
            shouldRevalidate = true;
            break; // Short-circuit on first true
          }
        }

        if (!shouldRevalidate) {
          console.log(`[Router.matchPartial] ${segment.id}: All revalidations FALSE - skipping`);
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
          routes: routeMap,
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
