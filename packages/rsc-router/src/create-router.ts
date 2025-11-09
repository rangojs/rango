/**
 * RSC Router factory and core router class
 */

import type {
  RouteDefinition,
  ResolvedRouteMap,
  HandlersForRouteMap,
} from './route-definition';
import { LinearMatcher } from './linear-matcher';

/**
 * Lazy handler import function type
 * Supports dynamic imports: () => import('./handlers')
 * The import can return either:
 * - Module with default export: { default: HandlersForRouteMap<T> }
 * - Direct handlers: HandlersForRouteMap<T>
 */
export type LazyHandlers<T extends Record<string, RouteDefinition>> =
  | (() => Promise<HandlersForRouteMap<T>>)
  | (() => Promise<{ default: HandlersForRouteMap<T> }>)
  | (() => Promise<any>); // Fallback for flexibility

/**
 * Router configuration options
 */
export interface RouterConfig {
  /**
   * Base path for all routes (e.g., '/api/v1')
   * All registered routes will be prefixed with this path
   */
  basePath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

/**
 * Middleware function type
 */
export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<void>
) => void | Promise<void>;

/**
 * Middleware context passed to middleware functions
 */
export interface MiddlewareContext {
  request: Request;
  pathname: string;
  url: URL;
  params: Record<string, string>;
  meta: Record<string, unknown>;
}

/**
 * Route builder for fluent API
 * Returned by router.route() to allow chaining .use() and .map()
 */
export class RouteBuilder<T extends Record<string, RouteDefinition>> {
  /**
   * Index of this builder's route registration in the router
   * Used to update middleware in the registered route
   */
  private registrationIndex: number;

  constructor(
    private router: RSCRouter,
    private _routeMap: ResolvedRouteMap<T>,
    registrationIndex: number,
    private _prefix?: string
  ) {
    this.registrationIndex = registrationIndex;
  }

  /**
   * Add middleware to this route group
   * @param middleware - One or more middleware functions
   * @returns This RouteBuilder for chaining
   */
  use(...middleware: Middleware[]): this {
    // Add middleware to the registered route
    this.router.addMiddlewareToRoute(this.registrationIndex, ...middleware);
    return this;
  }

  /**
   * Map handlers to routes (type-safe)
   * @param handlers - Object mapping route names to handler functions OR lazy import
   * @returns The router instance for chaining
   *
   * @example
   * Direct handlers:
   * ```typescript
   * router.route(routes).map({
   *   home: () => <HomePage />,
   *   about: () => <AboutPage />
   * });
   * ```
   *
   * @example
   * With symbols:
   * ```typescript
   * router.route(routes).map({
   *   [route.layout]: MyLayout,
   *   [route.parallel]: { '@sidebar': Sidebar },
   *   home: () => <HomePage />
   * });
   * ```
   *
   * @example
   * Lazy import:
   * ```typescript
   * router.route(routes).map(() => import('./handlers'));
   * ```
   */
  map(handlers: HandlersForRouteMap<T> | LazyHandlers<T>): RSCRouter {
    // Store handlers in the registered route
    this.router.addHandlersToRoute(this.registrationIndex, handlers);
    return this.router;
  }
}

/**
 * Registered route entry
 * Stores route map with optional prefix, middleware, and handlers
 */
export interface RegisteredRoute {
  routes: ResolvedRouteMap<any>;
  prefix?: string;
  middleware: Middleware[];
  handlers?: any;  // Handler object or lazy import function
}

/**
 * RSC Router class
 * Main router instance that manages route registration and matching
 */
export class RSCRouter {
  /**
   * Router configuration
   */
  private config: RouterConfig;

  /**
   * Global middleware applied to all routes
   */
  private globalMiddleware: Middleware[] = [];

  /**
   * Registered routes with their configurations
   */
  private registeredRoutes: RegisteredRoute[] = [];

  /**
   * @internal - Use createRSCRouter() instead
   */
  constructor(config: RouterConfig = {}) {
    this.config = config;
  }

  /**
   * Add global middleware to all routes
   *
   * @param middleware - One or more middleware functions
   * @returns This router for chaining
   *
   * @example
   * ```typescript
   * router
   *   .use(logger())
   *   .use(auth())
   *   .use(cors());
   * ```
   */
  use(...middleware: Middleware[]): this {
    this.globalMiddleware.push(...middleware);
    return this;
  }

  /**
   * Register routes with optional path prefix
   *
   * @param prefixOrRoutes - Path prefix (string) or route map
   * @param routeMap - Route map (if prefix provided)
   * @returns RouteBuilder for chaining .use() and .map()
   *
   * @example
   * Without prefix:
   * ```typescript
   * router.route(mainRoutes).map(handlers);
   * ```
   *
   * @example
   * With prefix:
   * ```typescript
   * router.route('/blog', blogRoutes).map(handlers);
   * ```
   */
  route<T extends Record<string, RouteDefinition>>(
    routeMap: ResolvedRouteMap<T>
  ): RouteBuilder<T>;
  route<T extends Record<string, RouteDefinition>>(
    prefix: string,
    routeMap: ResolvedRouteMap<T>
  ): RouteBuilder<T>;
  route<T extends Record<string, RouteDefinition>>(
    prefixOrRoutes: string | ResolvedRouteMap<T>,
    routeMap?: ResolvedRouteMap<T>
  ): RouteBuilder<T> {
    let prefix: string | undefined;
    let routes: ResolvedRouteMap<T>;

    if (typeof prefixOrRoutes === 'string') {
      // Called with prefix: router.route('/blog', routes)
      prefix = this.normalizePrefix(prefixOrRoutes);
      routes = routeMap!;
    } else {
      // Called without prefix: router.route(routes)
      prefix = undefined;
      routes = prefixOrRoutes;
    }

    // Store route registration (will be finalized in Phase 3.4 when .map() is called)
    // For now, store immediately with empty middleware
    const registrationIndex = this.registeredRoutes.length;
    this.registeredRoutes.push({
      routes,
      prefix,
      middleware: [],
    });

    const builder = new RouteBuilder(this, routes, registrationIndex, prefix);

    return builder;
  }

  /**
   * Normalize path prefix
   * - Remove trailing slash
   * - Convert empty string and '/' to undefined (root)
   * @internal
   */
  private normalizePrefix(prefix: string): string | undefined {
    if (!prefix || prefix === '/') {
      return undefined;
    }

    // Remove trailing slash
    return prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  }

  /**
   * Match a request against registered routes
   *
   * @param request - HTTP request to match
   * @returns Matched route result or null
   *
   * @example
   * ```typescript
   * const result = await router.match(request);
   * if (result) {
   *   // Route matched
   * }
   * ```
   */
  async match(request: Request): Promise<unknown> {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Linear scan through registered routes (Hono-style)
    for (const registered of this.registeredRoutes) {
      // Get all paths from this route registration
      const paths = registered.routes.getAllPaths();

      // Try to match each path
      for (const routePath of paths) {
        // Compose full path (prefix + route path)
        const fullPath = registered.prefix
          ? registered.prefix + routePath
          : routePath;

        // Create matcher (lazy compilation happens here if needed)
        const matcher = new LinearMatcher(fullPath);
        const matchResult = matcher.match(pathname);

        if (matchResult.matched) {
          // Found a match! Execute middleware pipeline

          // Build context
          const context: MiddlewareContext = {
            request,
            pathname,
            url,
            params: matchResult.params,
            meta: {},
          };

          // Execute middleware chain
          const middlewareChain = [
            ...this.globalMiddleware,
            ...registered.middleware,
          ];

          let index = 0;
          let nextCalled = true;

          const executeNext = async (): Promise<void> => {
            if (index >= middlewareChain.length) {
              return;
            }

            const middleware = middlewareChain[index++];
            if (middleware) {
              nextCalled = false;
              await middleware(context, async () => {
                nextCalled = true;
                await executeNext();
              });
            }
          };

          await executeNext();

          // If middleware didn't call next, stop here
          if (!nextCalled && index < middlewareChain.length) {
            return null;
          }

          // Return match result
          return {
            matched: true,
            params: matchResult.params,
            handlers: registered.handlers,
            context,
          };
        }
      }
    }

    // No match found
    return null;
  }

  /**
   * Match a request for partial rendering
   *
   * Computes differential segments between previous and current routes.
   * Used for RSC partial rendering to send only changed segments.
   *
   * @param request - HTTP request to match
   * @param previousPathname - Previous route pathname
   * @returns Partial match result with differential segments, or null if no match
   *
   * @example
   * ```typescript
   * // Client navigates from /blog to /blog/post-123
   * const result = await router.matchPartial(
   *   new Request('http://localhost/blog/post-123'),
   *   '/blog'
   * );
   *
   * // result: {
   * //   segments: [R2],        // Only changed segment
   * //   startIndex: 2,         // L0, L1 preserved
   * //   preservedLayouts: ['/blog']
   * // }
   * ```
   */
  async matchPartial(
    request: Request,
    previousPathname: string
  ): Promise<{
    segments: any[];
    startIndex: number;
    preservedLayouts: string[];
  } | null> {
    // Match the current request
    const currentMatch = await this.match(request);
    if (!currentMatch || !(currentMatch as any).matched) {
      return null;
    }

    const matchResult = currentMatch as any;

    // If no previous pathname or empty, return full render
    if (!previousPathname || previousPathname.trim() === '') {
      // Import segment building
      const { buildSegmentMap } = await import('./segment-system');
      const segments = buildSegmentMap({
        pathname: matchResult.context.pathname,
        params: matchResult.params,
        handlers: matchResult.handlers,
      });

      return {
        segments,
        startIndex: 0,
        preservedLayouts: [],
      };
    }

    // Try to match previous pathname to get its segments
    // Use the same origin as the current request
    const url = new URL(request.url);
    const previousUrl = new URL(previousPathname, url.origin);
    const previousRequest = new Request(previousUrl.href);
    const previousMatch = await this.match(previousRequest);

    console.log('[matchPartial] Previous pathname:', previousPathname);
    console.log('[matchPartial] Previous URL:', previousUrl.href);
    console.log('[matchPartial] Previous match:', previousMatch ? 'found' : 'null');

    // Import segment building
    const { buildSegmentMap } = await import('./segment-system');

    // Build segment maps for both routes
    const currentSegments = buildSegmentMap({
      pathname: matchResult.context.pathname,
      params: matchResult.params,
      handlers: matchResult.handlers,
    });

    // If previous didn't match, return full render
    if (!previousMatch || !(previousMatch as any).matched) {
      return {
        segments: currentSegments,
        startIndex: 0,
        preservedLayouts: [],
      };
    }

    const prevMatchResult = previousMatch as any;
    const previousSegments = buildSegmentMap({
      pathname: prevMatchResult.context.pathname,
      params: prevMatchResult.params,
      handlers: prevMatchResult.handlers,
    });

    // Find where segments diverge (startIndex)
    let startIndex = 0;
    const preservedLayouts: string[] = [];

    for (let i = 0; i < Math.min(currentSegments.length, previousSegments.length); i++) {
      const curr = currentSegments[i];
      const prev = previousSegments[i];

      // Segments diverge if:
      // - Different types
      // - Different IDs
      // - Different components (reference equality)
      // - Different params (for routes with params)
      const sameType = curr?.type === prev?.type;
      const sameId = curr?.id === prev?.id;
      const sameComponent = curr?.component === prev?.component;

      // Check params difference for routes
      const paramsChanged =
        curr?.params &&
        prev?.params &&
        JSON.stringify(curr.params) !== JSON.stringify(prev.params);

      if (!sameType || !sameId || !sameComponent || paramsChanged) {
        // Segments diverge here
        startIndex = i;
        break;
      }

      // This segment is preserved
      if (curr?.type === 'layout' && curr?.path) {
        preservedLayouts.push(curr.path);
      }

      // If we reach the end of the loop, all checked segments match
      if (i === Math.min(currentSegments.length, previousSegments.length) - 1) {
        startIndex = i + 1;
      }
    }

    // Return segments from startIndex onwards
    const changedSegments = currentSegments.slice(startIndex);

    return {
      segments: changedSegments,
      startIndex,
      preservedLayouts,
    };
  }

  /**
   * Get router configuration
   * @internal
   */
  getConfig(): RouterConfig {
    return { ...this.config };
  }

  /**
   * Get global middleware
   * @internal
   */
  getGlobalMiddleware(): Middleware[] {
    return [...this.globalMiddleware];
  }

  /**
   * Get all registered routes
   * @internal - Used for testing and debugging
   */
  getRegisteredRoutes(): RegisteredRoute[] {
    return [...this.registeredRoutes];
  }

  /**
   * Add middleware to a specific registered route
   * @internal - Used by RouteBuilder
   */
  addMiddlewareToRoute(index: number, ...middleware: Middleware[]): void {
    const route = this.registeredRoutes[index];
    if (route) {
      route.middleware.push(...middleware);
    }
  }

  /**
   * Add handlers to a specific registered route
   * @internal - Used by RouteBuilder
   */
  addHandlersToRoute(index: number, handlers: any): void {
    const route = this.registeredRoutes[index];
    if (route) {
      route.handlers = handlers;
    }
  }
}

/**
 * Create a new RSC Router instance
 *
 * @param config - Optional router configuration
 * @returns New RSCRouter instance
 *
 * @example
 * ```typescript
 * const router = createRSCRouter();
 *
 * router
 *   .use(logger())
 *   .route('/blog', blogRoutes)
 *   .use(auth())
 *   .map(blogHandlers);
 * ```
 *
 * @example
 * With configuration:
 * ```typescript
 * const router = createRSCRouter({
 *   basePath: '/api/v1',
 *   debug: true
 * });
 * ```
 */
export function createRSCRouter(config?: RouterConfig): RSCRouter {
  return new RSCRouter(config);
}
