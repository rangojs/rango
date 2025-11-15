/**
 * Host Router Implementation
 *
 * Main router that handles host-based routing with middleware and cookie override.
 */

import type {
  HostRouter,
  HostRouteBuilder,
  HostRouterOptions,
  Handler,
  LazyHandler,
  Middleware,
  HostPattern,
  RouteEntry,
  HostMatchResult,
} from './types.js';
import {
  matchPattern,
  parseRequest,
  normalizePattern,
  validatePattern,
} from './pattern-matcher.js';
import {
  handleCookieOverride,
  createCookieErrorResponse,
} from './cookie-handler.js';
import {
  HostRouterError,
  NoRouteMatchError,
  InvalidHandlerError,
} from './errors.js';

/**
 * Create a host router
 */
export function createHostRouter(options: HostRouterOptions = {}): HostRouter {
  const routes: RouteEntry[] = [];
  const globalMiddleware: Middleware[] = [];
  let fallbackRoute: RouteEntry | null = null;

  const { debug = false, hostOverride } = options;

  function log(message: string, ...args: any[]): void {
    if (debug) {
      console.log(`[HostRouter] ${message}`, ...args);
    }
  }

  /**
   * Create a route builder for chaining
   */
  function createRouteBuilder(
    patterns: string[],
    isFallback = false
  ): HostRouteBuilder {
    const middleware: Middleware[] = [];

    return {
      use(...mw: Middleware[]): HostRouteBuilder {
        middleware.push(...mw);
        return this;
      },

      map(handler: Handler | LazyHandler): HostRouter {
        const entry: RouteEntry = {
          patterns,
          middleware,
          handler,
          isFallback,
        };

        if (isFallback) {
          fallbackRoute = entry;
        } else {
          routes.push(entry);
        }

        log(
          `Registered ${isFallback ? 'fallback' : 'route'}:`,
          patterns.join(', ')
        );

        return router;
      },
    };
  }

  /**
   * Find matching route for hostname and path
   */
  function findMatchingRoute(
    hostname: string,
    pathname: string
  ): RouteEntry | null {
    const parts = hostname.split('.');

    for (const route of routes) {
      for (const pattern of route.patterns) {
        if (matchPattern(pattern, hostname, pathname, parts)) {
          log(`Matched pattern: "${pattern}" ✓`);
          return route;
        }
      }
    }

    return null;
  }

  /**
   * Execute middleware chain
   */
  async function executeMiddleware(
    middleware: Middleware[],
    request: Request,
    context: any,
    finalHandler: () => Promise<Response>
  ): Promise<Response> {
    let index = 0;

    async function next(): Promise<Response> {
      if (index >= middleware.length) {
        return finalHandler();
      }

      const mw = middleware[index++];
      if (!mw) {
        return finalHandler();
      }

      return mw(request, context, next);
    }

    return next();
  }

  /**
   * Execute handler (lazy or direct)
   */
  async function executeHandler(
    handler: Handler | LazyHandler,
    request: Request,
    context: any
  ): Promise<Response> {
    // Check if it's a lazy handler (function that returns promise)
    if (typeof handler === 'function') {
      const result = handler(request, context);

      // If it returns a promise with default export
      if (result && typeof result === 'object' && 'then' in result) {
        const module = await result;
        if (
          typeof module === 'object' &&
          module !== null &&
          'default' in module
        ) {
          const defaultExport = (module as { default: Handler | HostRouter })
            .default;

          // If default export is a router with match method
          if (
            typeof defaultExport === 'object' &&
            defaultExport !== null &&
            'match' in defaultExport
          ) {
            return (defaultExport as HostRouter).match(request, context);
          }

          // Otherwise treat as handler
          return (defaultExport as Handler)(request, context);
        }
        // If promise resolves to Response
        return result as Promise<Response>;
      }

      // Direct handler
      return result as Response | Promise<Response>;
    }

    throw new InvalidHandlerError(handler, {
      cause: { handlerType: typeof handler },
    });
  }

  /**
   * Router instance
   */
  const router: HostRouter = {
    host(patterns: HostPattern): HostRouteBuilder {
      const patternsArray = Array.isArray(patterns) ? patterns : [patterns];

      // Validate and normalize patterns
      const normalized = patternsArray.map((p) => {
        validatePattern(p);
        return normalizePattern(p);
      });

      return createRouteBuilder(normalized, false);
    },

    use(...middleware: Middleware[]): HostRouter {
      globalMiddleware.push(...middleware);
      log(`Registered global middleware (${middleware.length})`);
      return router;
    },

    fallback(): HostRouteBuilder {
      return createRouteBuilder([], true);
    },

    test(hostname: string): HostMatchResult | null {
      const parts = hostname.split('.');
      const pathname = '/';

      for (const route of routes) {
        for (const pattern of route.patterns) {
          if (matchPattern(pattern, hostname, pathname, parts)) {
            return {
              pattern,
              handler: route.handler,
            };
          }
        }
      }

      return null;
    },

    async match(request: Request, context: any = {}): Promise<Response> {
      log(`Request: ${request.url}`);

      let effectiveHostname: string;

      try {
        // Handle cookie override (may throw HostRouterError)
        effectiveHostname = handleCookieOverride(
          request,
          hostOverride,
          context
        );
      } catch (error) {
        // If it's a HostRouterError from cookie override
        if (error instanceof HostRouterError) {
          log(`Cookie override error: ${error.message}`);

          // If fallback exists, use it
          if (fallbackRoute) {
            context.error = error;
            const allMiddleware = [
              ...globalMiddleware,
              ...fallbackRoute.middleware,
            ];

            return executeMiddleware(allMiddleware, request, context, () =>
              executeHandler(fallbackRoute!.handler, request, context)
            );
          }

          // Otherwise return error response with cookie deletion
          if (hostOverride) {
            return createCookieErrorResponse(
              hostOverride.cookieName,
              error.message
            );
          }
        }

        // Re-throw non-HostRouterErrors
        throw error;
      }

      const { pathname } = parseRequest(request);

      if (effectiveHostname !== parseRequest(request).hostname) {
        log(`Cookie override: ${effectiveHostname}`);
      }

      // Find matching route
      const matchedRoute = findMatchingRoute(effectiveHostname, pathname);

      if (!matchedRoute) {
        log(`No route matched`);
        throw new NoRouteMatchError(effectiveHostname, pathname, {
          cause: {
            hostname: effectiveHostname,
            pathname,
          },
        });
      }

      // Combine global and route-specific middleware
      const allMiddleware = [...globalMiddleware, ...matchedRoute.middleware];

      // Execute middleware chain and handler
      return executeMiddleware(allMiddleware, request, context, () =>
        executeHandler(matchedRoute.handler, request, context)
      );
    },
  };

  return router;
}
