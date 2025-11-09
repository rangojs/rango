import type { ComponentType, ReactNode } from "react";
import type { Segment } from "./types";

export type RouteContext = {
  params: Record<string, string>;
  searchParams: URLSearchParams;
  pathname: string;
  url: URL;
  request: Request;
  meta: Record<string, any>;
};

export type RouteHandler = (
  context: RouteContext
) => ReactNode | Promise<ReactNode>;

export type LayoutHandler = (
  context: RouteContext
) => ReactNode | Promise<ReactNode>;

export type MiddlewareHandler = (
  context: RouteContext,
  next: () => Promise<void>
) => void | Promise<void>;

export type Route = {
  pattern: string;
  method: "GET" | "POST" | "ALL";
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
  private layoutStack: Route[] = [];

  /**
   * Define a layout route that wraps child routes
   */
  layout(
    pattern: string,
    ...handlers: Array<MiddlewareHandler | LayoutHandler>
  ) {
    const route: Route = {
      pattern,
      method: "ALL",
      handlers,
      isLayout: true,
      children: [],
    };

    // Parse pattern to create regex and extract param names
    this.compileRoute(route);

    // If we're inside another layout, add as child
    if (this.currentRoute) {
      this.currentRoute.children.push(route);
    } else {
      this.routes.push(route);
    }

    // Push to layout stack for nesting
    this.layoutStack.push(this.currentRoute || route);
    this.currentRoute = route;

    return this;
  }

  /**
   * End current layout group
   */
  endLayout() {
    this.currentRoute = this.layoutStack.pop() || null;
    return this;
  }

  /**
   * Define a GET route
   */
  get(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute("GET", pattern, handlers);
  }

  /**
   * Define a POST route (for server actions)
   */
  post(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute("POST", pattern, handlers);
  }

  /**
   * Define a route for all methods
   */
  all(pattern: string, ...handlers: Array<MiddlewareHandler | RouteHandler>) {
    return this.addRoute("ALL", pattern, handlers);
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
    method: "GET" | "POST" | "ALL",
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
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          // Dynamic segment
          const paramName = segment.slice(1);
          paramNames.push(paramName);
          return "([^/]+)";
        }
        if (segment === "*") {
          // Catch-all
          paramNames.push("*");
          return "(.*)";
        }
        // Static segment
        return segment;
      })
      .join("/");

    route.regex = new RegExp(`^${regexPattern}$`);
    route.paramNames = paramNames;
  }

  /**
   * Match a request against routes and execute handlers
   */
  async match(request: Request): Promise<[ReactNode | null, Segment[]]> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method;
    let currentSegments: Array<{
      index: number;
      pattern: string;
      component: React.ReactNode;
      isLayout: boolean;
    }> = [];
    console.log(`\n[Router.match] ========== START MATCHING ==========`);
    console.log(`[Router.match] Method: ${method}, Path: ${pathname}`);
    console.log(
      `[Router.match] Available routes:`,
      this.routes.map((r) => r.pattern)
    );

    // Find matching routes (including parent layouts)
    const matchedRoutes = this.findMatchingRoutes(
      pathname,
      method as "GET" | "POST",
      this.routes
    );

    console.log(
      `[Router.match] Matched routes:`,
      matchedRoutes.map((m) => ({
        pattern: m.route.pattern,
        isLayout: m.route.isLayout,
        params: m.params,
      }))
    );

    if (matchedRoutes.length === 0) {
      console.log(`[Router.match] ❌ No matching routes found`);
      return [null, []];
    }

    // Build context
    const context: RouteContext = {
      params: {},
      searchParams: url.searchParams,
      pathname,
      url,
      request,
      meta: {},
    };

    // Extract params from the matched routes
    for (const matched of matchedRoutes) {
      Object.assign(context.params, matched.params);
    }

    // Execute middleware and handlers in order
    let componentTree: ReactNode = null;

    console.log(
      `[Router.match] Processing ${matchedRoutes.length} matched routes...`
    );

    // Process from outermost to innermost
    for (let i = matchedRoutes.length - 1; i >= 0; i--) {
      const { route } = matchedRoutes[i];
      console.log(
        `\n[Router.match] Processing route ${i}: ${route.pattern} (isLayout: ${route.isLayout})`
      );

      for (const handler of route.handlers) {
        console.log(
          `[Router.match]   Handler: ${handler.name || "anonymous"}, length: ${
            handler.length
          }`
        );

        // Check route type first
        if (route.isLayout) {
          // It's a layout handler - just store the segment
          console.log(`[Router.match]   → Executing layout handler`);
          const layoutHandler = handler as LayoutHandler;
          const layoutComponent = await layoutHandler(context);
          console.log(
            `[Router.match]     Layout returned:`,
            typeof layoutComponent === 'object' && layoutComponent !== null && 'type' in layoutComponent
              ? (layoutComponent as any).type?.name || typeof layoutComponent
              : typeof layoutComponent
          );
          currentSegments.push({
            index: i,
            pattern: route.pattern,
            component: layoutComponent,
            isLayout: true,
          });

          console.log(`[Router.match]     Stored layout segment`);
        } else if (handler.length === 2) {
          // It's middleware (has 'next' parameter)
          console.log(`[Router.match]   → Executing middleware`);
          const middleware = handler as MiddlewareHandler;
          let nextCalled = false;
          await middleware(context, async () => {
            nextCalled = true;
            console.log(`[Router.match]     Middleware called next()`);
          });
          if (!nextCalled) {
            console.log(
              `[Router.match]   ⚠️ Middleware didn't call next, stopping`
            );
            break;
          }
        } else {
          // It's a route handler
          console.log(`[Router.match]   → Executing route handler`);
          const routeHandler = handler as RouteHandler;
          componentTree = await routeHandler(context);
          currentSegments.push({
            index: i,
            pattern: route.pattern,
            component: componentTree,
            isLayout: false,
          });
          console.log(
            `[Router.match]     Route returned:`,
            typeof componentTree === 'object' && componentTree !== null && 'type' in componentTree
              ? (componentTree as any).type?.name || typeof componentTree
              : typeof componentTree
          );
        }
      }
    }

    console.log(`[Router.match] ========== END MATCHING ==========\n`);
    // Server sends segments - client will reconstruct tree using OutletProvider
    return [null, currentSegments] as const;
  }

  private findMatchingRoutes(
    pathname: string,
    method: "GET" | "POST",
    routes: Route[],
    parentMatches: Array<{ route: Route; params: Record<string, string> }> = [],
    depth: number = 0
  ): Array<{ route: Route; params: Record<string, string> }> {
    const indent = "  ".repeat(depth);
    console.log(
      `${indent}[findMatching] Searching at depth ${depth} for ${pathname}`
    );

    for (const route of routes) {
      console.log(
        `${indent}  Checking route: ${route.pattern} (${route.method}, isLayout: ${route.isLayout})`
      );

      if (route.method !== "ALL" && route.method !== method) {
        console.log(`${indent}    Skipped: method mismatch`);
        continue;
      }

      const match = route.regex?.exec(pathname);
      console.log(`${indent}    Regex match: ${match ? "YES" : "NO"}`);

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

      const currentMatch = { route, params };
      console.log(`${indent}    Created match with params:`, params);

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
   * Get partial route match for client-side navigation
   * Returns only changed segments for true partial rendering
   */
  async matchPartial(
    request: Request,
    previousPathname?: string | null
  ): Promise<{
    segments: Array<Segment>;
    startIndex: number;
    preservedLayouts: string[];
  } | null> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Find matches for current route
    const nextMatches = this.findMatchingRoutes(pathname, "GET", this.routes);

    // If no matches, return null
    if (nextMatches.length === 0) {
      return null;
    }

    // Determine divergence point if previous pathname provided
    let divergenceIndex = 0;
    let preservedLayouts: string[] = [];

    if (previousPathname) {
      const prevMatches = this.findMatchingRoutes(
        previousPathname,
        "GET",
        this.routes
      );

      // Find where routes diverge
      for (
        let i = 0;
        i < Math.min(prevMatches.length, nextMatches.length);
        i++
      ) {
        if (prevMatches[i].route !== nextMatches[i].route) {
          break;
        }
        divergenceIndex++;
      }

      preservedLayouts = prevMatches
        .slice(0, divergenceIndex)
        .filter((m) => m.route.isLayout)
        .map((m) => m.route.pattern);
    }

    // Build context
    const context: RouteContext = {
      params: {},
      searchParams: url.searchParams,
      pathname,
      url,
      request,
      meta: {},
    };

    // Extract all params
    for (const matched of nextMatches) {
      Object.assign(context.params, matched.params);
    }

    // Build segments array - ONLY the changed segments
    const segments: Array<Segment> = [];

    // Process ONLY from divergence point to end
    // This gives us minimal segments needed
    for (let i = divergenceIndex; i < nextMatches.length; i++) {
      const { route } = nextMatches[i];

      for (const handler of route.handlers) {
        // Skip middleware
        if (route.isLayout) {
          const layoutHandler = handler as LayoutHandler;
          // Pass null as children - client will reconstruct
          const layoutComponent = await layoutHandler(context);

          segments.push({
            index: i,
            pattern: route.pattern,
            component: layoutComponent,
            isLayout: true,
          });
        } else if (handler.length === 1) {
          const routeHandler = handler as RouteHandler;
          const pageComponent = await routeHandler(context);

          segments.push({
            index: i,
            pattern: route.pattern,
            component: pageComponent,
            isLayout: false,
          });
        }
      }
    }

    console.log(
      `[Router.matchPartial] Returning ${segments.length} segments starting from index ${divergenceIndex}`
    );

    return {
      segments,
      startIndex: divergenceIndex,
      preservedLayouts,
    };
  }
}
