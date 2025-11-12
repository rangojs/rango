import type { ReactNode } from 'react';
import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
  HandlerContext,
  ResolvedSegment,
  MatchResult,
  RouteEntry,
} from './types.js';
import { route } from './route-definition.js';

/**
 * Router builder for chaining .use() and .map()
 */
interface RouteBuilder<TContext> {
  map(
    handlers:
      | HandlersForRouteMap<any, TContext>
      | (() => Promise<{ default: HandlersForRouteMap<any, TContext> }>)
  ): RSCRouter<TContext>;
}

/**
 * RSC Router interface
 */
export interface RSCRouter<TContext = any> {
  route<T extends RouteDefinition>(
    prefix: string,
    routes: ResolvedRouteMap<T>
  ): RouteBuilder<TContext>;

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
   * Helper to detect if a symbol is a route symbol
   */
  function getSymbolType(sym: symbol):
    | { type: 'layout' | 'parallel' | 'middleware' | 'revalidate'; global: boolean }
    | null {
    const str = sym.toString();

    if (str.includes('route.all.layout')) return { type: 'layout', global: true };
    if (str.includes('route.all.parallel')) return { type: 'parallel', global: true };
    if (str.includes('route.all.middleware')) return { type: 'middleware', global: true };
    if (str.includes('route.layout')) return { type: 'layout', global: false };
    if (str.includes('route.parallel')) return { type: 'parallel', global: false };
    if (str.includes('route.middleware')) return { type: 'middleware', global: false };
    if (str.includes('route.revalidate')) return { type: 'revalidate', global: false };

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

    // Track global metadata (cumulative from all route.all.* symbols)
    const globalLayouts: ReactNode[] = [];
    const globalParallel: Record<string, Handler> = {};

    // Track per-route metadata (from symbols before current route)
    let currentLayouts: ReactNode[] | null = null;
    let currentParallel: Record<string, Handler> | null = null;

    // Use Reflect.ownKeys to preserve insertion order (symbols + strings)
    const keys = Reflect.ownKeys(handlers);

    // PASS 1: Process all symbols to accumulate metadata
    for (const key of keys) {
      if (typeof key === 'symbol') {
        const symbolInfo = getSymbolType(key);
        if (!symbolInfo) continue;

        const value = handlers[key as any];

        if (symbolInfo.type === 'layout') {
          const layouts = Array.isArray(value) ? value : [value];
          if (symbolInfo.global) {
            // Cumulative: Add to global layouts
            globalLayouts.push(...layouts);
          } else {
            // Per-route: Replace current
            currentLayouts = layouts;
          }
        } else if (symbolInfo.type === 'parallel') {
          const slots = value as Record<string, Handler>;
          if (symbolInfo.global) {
            // Cumulative: Merge into global parallel
            Object.assign(globalParallel, slots);
          } else {
            // Per-route: Replace current (will merge with global later)
            currentParallel = slots;
          }
        }
        // Skip middleware and revalidate for now
      }
    }

    // PASS 2: Process route handlers
    for (const key of keys) {
      if (typeof key === 'string') {
        // It's a route handler
        if (key === routeKey) {
          // Use current or global layouts
          const layoutsToUse = currentLayouts || globalLayouts;
          for (const layout of layoutsToUse) {
            segments.push({
              id: `L${index}.${entry.registrationId}`,
              type: 'layout',
              index,
              component: layout,
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
          const mergedParallel = { ...globalParallel, ...currentParallel };
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
        // Note: Don't reset currentLayouts/currentParallel here
        // They should persist for all routes that don't have their own metadata
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
  ): RouteBuilder<TContext> {
    return {
      map(handlers) {
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
    ): RouteBuilder<TContext> {
      const registrationId = nextRegistrationId++;
      return createRouteBuilder(prefix, routes, registrationId);
    },

    match,
    matchPartial,
  };

  return router;
}
