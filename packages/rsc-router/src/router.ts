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
interface RouteBuilder<T extends RouteDefinition, TContext> {
  map(
    handlers:
      | HandlersForRouteMap<T, TContext>
      | (() => Promise<{ default: HandlersForRouteMap<T, TContext> }>)
  ): RSCRouter<TContext>;
}

/**
 * RSC Router interface
 */
export interface RSCRouter<TContext = any> {
  route<T extends RouteDefinition>(
    prefix: string,
    routes: ResolvedRouteMap<T>
  ): RouteBuilder<T, TContext>;

  match(request: Request, context: TContext): Promise<MatchResult>;

  matchPartial(request: Request, context: TContext): Promise<MatchResult | null>;
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
export function createRSCRouter<TContext = any>(): RSCRouter<TContext> {
  const routes: RouteEntry<TContext>[] = [];
  let nextRegistrationId = 0;

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
    entry: RouteEntry<TContext>;
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
      | HandlersForRouteMap<any, TContext>
      | (() => Promise<{ default: HandlersForRouteMap<any, TContext> }>)
  ): Promise<HandlersForRouteMap<any, TContext>> {
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
    | { type: 'layout' | 'parallel' | 'middleware' | 'revalidate'; global: boolean; routeName?: string }
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

    // Check for revalidate: $revalidate.routeName
    if (key.startsWith('$revalidate.')) {
      const parts = key.split('.');
      if (parts.length >= 2) {
        const routeName = parts[1];
        return { type: 'revalidate', global: false, routeName };
      }
    }

    return null;
  }

  /**
   * Build segments from matched route using positional extraction
   */
  async function buildSegments(
    entry: RouteEntry<TContext>,
    routeKey: string,
    params: Record<string, string>,
    context: HandlerContext<any, TContext>
  ): Promise<ResolvedSegment[]> {
    const handlers = await loadHandlers(entry.handlers);
    const segments: ResolvedSegment[] = [];
    let index = 0;

    // Track global metadata (wildcard '*' routes)
    const globalLayouts: (ReactNode | Handler)[] = [];
    const globalParallel: Record<string, Handler> = {};

    // Track per-route metadata (specific to routeKey)
    const perRouteLayouts: (ReactNode | Handler)[] = [];
    const perRouteParallel: Record<string, Handler> = {};

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
      }
      // Skip middleware and revalidate for now
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
    context: TContext
  ): Promise<MatchResult> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    const matched = findMatch(pathname);
    if (!matched) {
      throw new Error(`No route matched for ${pathname}`);
    }

    const handlerContext: HandlerContext<any, TContext> = {
      params: matched.params,
      request,
      searchParams: url.searchParams,
      pathname,
      url,
      ...(context as any),
    };

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
   * Match partial request with revalidation
   */
  async function matchPartial(
    request: Request,
    context: TContext
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

    // Build previous segments for comparison
    let prevSegments: ResolvedSegment[] = [];
    if (prevMatch) {
      const prevContext: HandlerContext<any, TContext> = {
        params: prevMatch.params,
        request,
        searchParams: prevUrl.searchParams,
        pathname: prevUrl.pathname,
        url: prevUrl,
        ...(context as any),
      };
      prevSegments = await buildSegments(
        prevMatch.entry,
        prevMatch.routeKey,
        prevMatch.params,
        prevContext
      );
    }

    const handlerContext: HandlerContext<any, TContext> = {
      params: nextMatch.params,
      request,
      searchParams: url.searchParams,
      pathname,
      url,
      ...(context as any),
    };

    // Build all segments for current route
    const allSegments = await buildSegments(
      nextMatch.entry,
      nextMatch.routeKey,
      nextMatch.params,
      handlerContext
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

      // Client has this segment - check if params changed (default revalidation)
      const prevSegment = prevSegments.find((s) => s.id === segment.id);

      if (prevSegment && segment.params) {
        const prevParams = prevSegment.params || {};
        const nextParams = segment.params;

        // Check if any param changed
        const paramsChanged =
          Object.keys(nextParams).length !== Object.keys(prevParams).length ||
          Object.keys(nextParams).some((key) => nextParams[key] !== prevParams[key]);

        if (paramsChanged) {
          console.log(
            `[Router.matchPartial] ${segment.id}: PARAMS CHANGED - revalidating`,
            { prev: prevParams, next: nextParams }
          );
          segmentsToRender.push(segment);
        } else {
          console.log(`[Router.matchPartial] ${segment.id}: UNCHANGED - skipping`);
        }
      } else if (!prevSegment) {
        // Previous route didn't have this segment (shouldn't happen if IDs match)
        console.log(`[Router.matchPartial] ${segment.id}: NO PREV - including`);
        segmentsToRender.push(segment);
      } else {
        // No params on this segment, and client has it - skip
        console.log(`[Router.matchPartial] ${segment.id}: NO PARAMS - skipping`);
      }

      // TODO: Support custom revalidation functions from route.revalidate symbol
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
  ): RouteBuilder<T, TContext> {
    return {
      map(
        handlers:
          | HandlersForRouteMap<T, TContext>
          | (() => Promise<{ default: HandlersForRouteMap<T, TContext> }>)
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
  const router: RSCRouter<TContext> = {
    route<T extends RouteDefinition>(
      prefix: string,
      routes: ResolvedRouteMap<T>
    ): RouteBuilder<T, TContext> {
      const registrationId = nextRegistrationId++;
      return createRouteBuilder(prefix, routes, registrationId);
    },

    match,
    matchPartial,
  };

  return router;
}
