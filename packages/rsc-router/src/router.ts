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
import { route as routeSymbols } from './types.js';

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
   * Build segments from matched route
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

    // Process layouts
    const layouts = handlers[routeSymbols.layout];
    if (layouts) {
      const layoutArray = Array.isArray(layouts) ? layouts : [layouts];

      for (const layout of layoutArray) {
        segments.push({
          id: `L${index}.${entry.registrationId}`,
          type: 'layout',
          index,
          component: layout,
        });
        index++;
      }
    }

    // Process route handler
    const handler = handlers[routeKey];
    if (handler) {
      const component = await handler(context);
      segments.push({
        id: `R${index}.${entry.registrationId}`,
        type: 'route',
        index,
        component,
        params,
      });
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
        segmentsToRender.push(segment);
        continue;
      }

      // Client has this segment - check if params changed (default revalidation)
      if (segment.params && prevMatch) {
        const prevParams = prevMatch.params;
        const paramsChanged = Object.keys(segment.params).some(
          (key) => segment.params![key] !== prevParams[key]
        );

        if (paramsChanged) {
          segmentsToRender.push(segment);
        }
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
