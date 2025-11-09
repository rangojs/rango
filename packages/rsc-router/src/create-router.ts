/**
 * RSC Router factory and core router class
 */

import type { RouteDefinition, ResolvedRouteMap } from './route-definition';
import { route } from './route-definition';
import { LinearMatcher } from './linear-matcher';

/**
 * Route handler function type
 */
export type RouteHandler<TContext = MiddlewareContext> =
  | ((ctx: TContext) => any)
  | ((ctx?: TContext) => any)
  | (() => any);

/**
 * Recursively build handler type from route map
 * - String routes → RouteHandler
 * - Nested routes → Nested handler object
 */
export type HandlersForRouteMap<T extends Record<string, RouteDefinition>> = {
  [K in keyof T]?: T[K] extends string
    ? RouteHandler
    : T[K] extends Record<string, RouteDefinition>
      ? HandlersForRouteMap<T[K]>
      : never;
} & {
  // Allow special symbols
  [route.layout]?:
    | any // Single layout or array
    | Record<keyof T, any>; // Per-route layouts
  [route.parallel]?:
    | Record<string, any> // Global parallel routes
    | Record<keyof T, Record<string, any>>; // Per-route parallel routes
  [route.loading]?: any | Record<keyof T, any>;
  [route.error]?: any | Record<keyof T, any>;
  [route.revalidate]?: any | Record<keyof T, any>;
};

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
   * @param handlers - Object mapping route names to handler functions
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
   */
  map(handlers: HandlersForRouteMap<T>): RSCRouter {
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
