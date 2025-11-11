import type { ReactNode } from 'react';
import type { Segment, ResolvedSegment } from './types';

export type RouteContext = {
  params: Record<string, string>;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  request: Request;
  meta: Record<string, any>;
};

// Internal type - not exported to avoid conflict with route-definition.ts
type RouteHandler = (context: RouteContext) => ReactNode | Promise<ReactNode>;

export type LayoutHandler = (
  context: RouteContext
) => ReactNode | Promise<ReactNode>;

export type MiddlewareHandler = (
  context: RouteContext,
  next: () => Promise<void>
) => void | Promise<void>;

export type Route = {
  pattern: string;
  method: 'GET' | 'POST' | 'ALL';
  handlers: Array<MiddlewareHandler | RouteHandler | LayoutHandler>;
  isLayout: boolean;
  children: Route[];
  regex?: RegExp;
  paramNames?: string[];
};

/**
 * RSC Router - Express/Hono-style router for React Server Components
 */
export class RscRouter {
  private routes: Route[] = [];
  private currentRoute: Route | null = null;

  /**
   * Define a GET route
   */
  get(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute('GET', pattern, handlers);
  }

  /**
   * Define a POST route (for server actions)
   */
  post(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute('POST', pattern, handlers);
  }

  /**
   * Define a route for all methods
   */
  all(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute('ALL', pattern, handlers);
  }

  /**
   * Use middleware for all routes
   */
  use(...handlers: MiddlewareHandler[]) {
    // Add global middleware to all existing and future routes
    this.routes.forEach((route) => {
      route.handlers.unshift(...handlers);
    });
    return this;
  }

  private addRoute(
    method: 'GET' | 'POST' | 'ALL',
    pattern: string,
    handlers: Array<MiddlewareHandler | RouteHandler>
  ) {
    const route: Route = {
      pattern,
      method,
      handlers,
      isLayout: false,
      children: [],
    };

    this.compileRoute(route);

    if (this.currentRoute) {
      this.currentRoute.children.push(route);
    } else {
      this.routes.push(route);
    }

    return this;
  }

  private compileRoute(route: Route) {
    const paramNames: string[] = [];

    // Convert Express-style pattern to regex
    const regexPattern = route.pattern
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          // Dynamic segment
          const paramName = segment.slice(1);
          paramNames.push(paramName);
          return '([^/]+)';
        }
        if (segment === '*') {
          // Catch-all
          paramNames.push('*');
          return '(.*)';
        }
        // Static segment
        return segment;
      })
      .join('/');

    route.regex = new RegExp(`^${regexPattern}$`);
    route.paramNames = paramNames;
  }

  /**
   * Match a request against routes and execute handlers
   */
  async match(request: Request, context: RouteContext) {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;

    console.log(`\n[Router.match] ========== START MATCHING ==========`);
    console.log(`[Router.match] Method: ${method}, Path: ${pathname}`);

    // Find matching routes (including parent layouts)
    const matchedRoutes = this.findMatchingRoutes(
      pathname,
      method as 'GET' | 'POST',
      this.routes
    );

    const matchedSegmentIds = matchedRoutes.map((m) => m.id);
    console.log(
      `[Router.match] Matched segments: ${matchedSegmentIds.join(', ')}`
    );

    // Render all segments (no filtering needed for full match)
    const segments: Array<ResolvedSegment> = await this.renderSegments(
      matchedRoutes,
      context
    );

    console.log(`[Router.match] Rendered ${segments.length} segments`);
    console.log('[Router.match] Segments:', segments);
    console.log(`[Router.match] ========== END MATCHING ==========\n`);

    return {
      segments,
      matched: matchedSegmentIds,
      diff: matchedSegmentIds,
    };
  }

  private findMatchingRoutes(
    pathname: string,
    method: 'GET' | 'POST',
    routes: Route[],
    parentMatches: Array<{
      route: Route;
      params: Record<string, string>;
      id: string;
    }> = [],
    depth: number = 0
  ): Array<{ route: Route; params: Record<string, string>; id: string }> {
    const indent = '  '.repeat(depth);
    console.log(
      `${indent}[findMatching] Searching at depth ${depth} for ${pathname}`
    );
    console.log('[findMatching] routes', routes);

    for (const route of routes) {
      console.log('[findMatching] route', route);

      console.log(
        `${indent}  Checking route: ${route.pattern} (${route.method}, isLayout: ${route.isLayout})`
      );

      if (route.method !== 'ALL' && route.method !== method) {
        console.log(`${indent}    Skipped: method mismatch`);
        continue;
      }

      const match = route.regex?.exec(pathname);
      console.log(`${indent}    Regex match: ${match ? 'YES' : 'NO'}`);

      if (!match && !route.isLayout) {
        console.log(`${indent}    Skipped: no match and not a layout`);
        continue;
      }

      const params: Record<string, string> = {};

      if (match && route.paramNames) {
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1];
        });
      }

      // Generate ID based on position and type
      // TODO: Handle parallel routes - they should use 'P' prefix (e.g., 'P0', 'P1')
      // Currently Route type doesn't have a field to identify parallel routes
      const id = route.isLayout
        ? `L${parentMatches.length}`
        : `R${parentMatches.length}`;
      const currentMatch = { route, params, id };
      console.log(`${indent}    Created match with ID: ${id}, params:`, params);

      // If this is a layout, check its children
      if (route.isLayout) {
        console.log(
          `${indent}    → Checking children (${route.children.length} children)`
        );
        const childMatches = this.findMatchingRoutes(
          pathname,
          method,
          route.children,
          [...parentMatches, currentMatch],
          depth + 1
        );
        if (childMatches.length > 0) {
          console.log(`${indent}    ✓ Found matching child routes`);
          return childMatches;
        }
        console.log(`${indent}    No matching children found`);
      } else if (match) {
        // This is a matching page route
        console.log(`${indent}    ✓ Found matching page route!`);
        return [...parentMatches, currentMatch];
      }
    }

    console.log(`${indent}[findMatching] No matches found at depth ${depth}`);
    return [];
  }

  /**
   * Render segments by calling their handlers and resolving components
   */
  private async renderSegments(
    matches: Array<{
      route: Route;
      params: Record<string, string>;
      id: string;
    }>,
    context: RouteContext
  ): Promise<Array<ResolvedSegment>> {
    const segments: Array<ResolvedSegment> = [];

    // Process each match and render the component
    for (let i = 0; i < matches.length; i++) {
      const { route, params, id } = matches[i];

      // Update context with params from this match
      const segmentContext = {
        ...context,
        params: { ...context.params, ...params },
      };

      let component: ReactNode = null;

      try {
        // Execute all handlers for this route
        for (const handler of route.handlers) {
          // Check if it's a regular handler or middleware
          if (handler.length === 1 || route.isLayout) {
            // Regular handler or layout handler
            const result = await handler(segmentContext);

            // Handle dynamic imports (e.g., () => import('./Component'))
            if (typeof result === 'function') {
              const importResult = await result();
              // Handle ES module default exports
              component = importResult.default || importResult;
            } else {
              component = result;
            }
          }
          // Skip middleware handlers (they have 2 params: context and next)
        }
      } catch (error) {
        console.error(
          `[Router.renderSegments] Error rendering segment ${id}:`,
          error
        );
        // Return error component
        component = <div>Error loading segment {id}</div>;
      }

      // Create resolved segment
      const segment: ResolvedSegment = {
        id,
        type: route.isLayout ? 'layout' : 'route',
        index: i,
        pattern: route.pattern,
        component,
        isLayout: route.isLayout,
        params,
      };

      segments.push(segment);
    }

    return segments;
  }

  /**
   * Get partial route match for client-side navigation
   * Returns only changed segments for true partial rendering
   *
   */
  async matchPartial(
    request: Request,
    clientSegmentIds: string[],
    context: RouteContext
  ) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Find matches for current route
    const nextMatches = this.findMatchingRoutes(pathname, 'GET', this.routes);
    const matchedSegmentIds = nextMatches.map((m) => m.id);
    const clientSegmentIdsSet = new Set(clientSegmentIds);
    const toRenderSegments = nextMatches.filter((s) => {
      if (clientSegmentIdsSet.has(s.id)) {
        // here we need to call segmets.revalidate(ctx) which is by default false and if true we should render it again
        // await match.route.revalidate(context, other props as needed)
        // revalidate must not be async func
        const revalidate = false;
        if (revalidate) {
          return true;
        }
        return false;
      }
      return true;
    });
    const renderedSegmentIds = toRenderSegments.map((s) => s.id);

    console.log(
      `[Router.matchPartial] Next segments: ${matchedSegmentIds.join(', ')}`
    );
    console.log(
      `[Router.matchPartial] Client segments: ${clientSegmentIds.join(', ')}`
    );
    console.log(
      `[Router.matchPartial] Rendered segments: ${renderedSegmentIds.join(', ')}`
    );
    // Render segments - call handlers to get components
    const segments: Array<ResolvedSegment> = await this.renderSegments(
      toRenderSegments,
      context
    );

    return {
      segments,
      matched: matchedSegmentIds,
      diff: renderedSegmentIds,
    };
  }
}
