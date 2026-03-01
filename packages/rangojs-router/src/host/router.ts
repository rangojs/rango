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
} from "./types.js";
import type { RouterRequestInput } from "../router/router-interfaces.js";
import {
  matchPattern,
  parseRequest,
  normalizePattern,
  validatePattern,
} from "./pattern-matcher.js";
import {
  handleCookieOverride,
  createCookieErrorResponse,
} from "./cookie-handler.js";
import {
  HostRouterError,
  NoRouteMatchError,
  InvalidHandlerError,
} from "./errors.js";

/**
 * Registry entry for a host router instance.
 * Stores references to the live routes array and fallback, so the discovery
 * plugin can iterate handlers registered after createHostRouter() returns.
 */
export interface HostRouterRegistryEntry {
  routes: RouteEntry[];
  fallback: RouteEntry | null;
}

/**
 * Global registry for host routers (parallel to RouterRegistry for RSC routers).
 * Populated by createHostRouter() so the build-time discovery plugin can find
 * host routers and resolve their lazy handlers to trigger sub-app createRouter() calls.
 */
export const HostRouterRegistry: Map<string, HostRouterRegistryEntry> =
  new Map();

let hostRouterAutoId = 0;

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
    isFallback = false,
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
          `Registered ${isFallback ? "fallback" : "route"}:`,
          patterns.join(", "),
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
    pathname: string,
  ): RouteEntry | null {
    const parts = hostname.split(".");

    for (const route of routes) {
      for (const pattern of route.patterns) {
        if (matchPattern(pattern, hostname, pathname, parts)) {
          log(`Matched pattern: "${pattern}"`);
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
    input: RouterRequestInput<any>,
    finalHandler: () => Promise<Response>,
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

      return mw(request, input, next);
    }

    return next();
  }

  /**
   * Execute handler (lazy or direct)
   */
  async function executeHandler(
    handler: Handler | LazyHandler,
    request: Request,
    input: RouterRequestInput<any>,
  ): Promise<Response> {
    // Check if it's a lazy handler (function that returns promise)
    if (typeof handler === "function") {
      const result = handler(request, input);

      // If it returns a promise with default export
      if (result && typeof result === "object" && "then" in result) {
        const module = await result;
        if (
          typeof module === "object" &&
          module !== null &&
          "default" in module
        ) {
          const defaultExport = (module as { default: Handler | HostRouter })
            .default;

          // If default export is a router with match method
          if (
            typeof defaultExport === "object" &&
            defaultExport !== null &&
            "match" in defaultExport
          ) {
            return (defaultExport as HostRouter).match(request, input);
          }

          // Otherwise treat as handler
          return (defaultExport as Handler)(request, input);
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
      const parts = hostname.split(".");
      const pathname = "/";

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

    async match(
      request: Request,
      input: RouterRequestInput<any> = {},
    ): Promise<Response> {
      log(`Request: ${request.url}`);

      let effectiveHostname: string;

      try {
        // Handle cookie override (may throw HostRouterError)
        effectiveHostname = handleCookieOverride(request, hostOverride, input);
      } catch (error) {
        // If it's a HostRouterError from cookie override
        if (error instanceof HostRouterError) {
          log(`Cookie override error: ${error.message}`);

          // If fallback exists, use it
          if (fallbackRoute) {
            const fallbackInput = { ...input, error };
            const allMiddleware = [
              ...globalMiddleware,
              ...fallbackRoute.middleware,
            ];

            return executeMiddleware(
              allMiddleware,
              request,
              fallbackInput,
              () =>
                executeHandler(fallbackRoute!.handler, request, fallbackInput),
            );
          }

          // Otherwise return error response with cookie deletion
          if (hostOverride) {
            return createCookieErrorResponse(
              hostOverride.cookieName,
              error.message,
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
      return executeMiddleware(allMiddleware, request, input, () =>
        executeHandler(matchedRoute.handler, request, input),
      );
    },
  };

  // Register in the global HostRouterRegistry for build-time discovery.
  // The routes array and fallbackRoute ref are live - they reflect routes
  // added via .host().map() after this point.
  const registryId = `host-router-${hostRouterAutoId++}`;
  HostRouterRegistry.set(registryId, {
    get routes() {
      return routes;
    },
    get fallback() {
      return fallbackRoute;
    },
  });

  return router;
}
