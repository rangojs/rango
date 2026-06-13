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

/** Whether a value is thenable (a Promise or Promise-like). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Whether a resolved value looks like a module namespace from a lazy import -
 * an object with a `default` export that is a function (a Handler) or a host
 * router (an object with `match`). Used to detect a `.map(() => import(...))`
 * misuse: an inline handler should return a Response, not a module.
 */
function looksLikeLazyModule(value: unknown): boolean {
  if (value === null || typeof value !== "object" || !("default" in value)) {
    return false;
  }
  const defaultExport = (value as { default: unknown }).default;
  return (
    typeof defaultExport === "function" ||
    (typeof defaultExport === "object" &&
      defaultExport !== null &&
      "match" in defaultExport)
  );
}

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

    function register(
      handler: Handler | LazyHandler,
      kind: RouteEntry["kind"],
    ): HostRouter {
      const entry: RouteEntry = {
        patterns,
        middleware,
        handler,
        kind,
        isFallback,
      };

      if (isFallback) {
        fallbackRoute = entry;
      } else {
        routes.push(entry);
      }

      log(
        `Registered ${isFallback ? "fallback" : "route"} (${kind}):`,
        patterns.join(", "),
      );

      return router;
    }

    return {
      use(...mw: Middleware[]): HostRouteBuilder {
        middleware.push(...mw);
        return this;
      },

      map(handler: Handler): HostRouter {
        return register(handler, "handler");
      },

      lazy(handler: LazyHandler): HostRouter {
        return register(handler, "lazy");
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

      // Guard against double next() calls — a second call would
      // re-enter the downstream chain and run handlers/side-effects twice.
      let nextCalled = false;
      const guardedNext = (): Promise<Response> => {
        if (nextCalled) {
          throw new Error(
            `[HostRouter] Middleware called next() more than once.`,
          );
        }
        nextCalled = true;
        return next();
      };

      return mw(request, input, guardedNext);
    }

    return next();
  }

  /**
   * Execute a route entry, branching on its declared kind:
   *   - "lazy": await the loader, then delegate to the default export
   *     (a nested HostRouter via `.match`, or a request Handler directly).
   *   - "handler": call the inline handler with the request. A `.map()` handler
   *     that resolves to a module namespace (`{ default }`) is almost certainly
   *     a misused lazy import, so it is rejected with a clear message rather
   *     than silently returning a module object as the response.
   */
  async function executeHandler(
    entry: RouteEntry,
    request: Request,
    input: RouterRequestInput<any>,
  ): Promise<Response> {
    const { handler, kind } = entry;

    if (typeof handler !== "function") {
      throw new InvalidHandlerError(handler, {
        cause: { handlerType: typeof handler },
      });
    }

    if (kind === "lazy") {
      return executeLazyMount(handler as LazyHandler, request, input);
    }

    const result = (handler as Handler)(request, input);

    // Inline handlers may be async; await to obtain the Response and to run the
    // misuse guard below.
    if (isThenable(result)) {
      const awaited = await result;
      if (looksLikeLazyModule(awaited)) {
        throw new HostRouterError(
          ".map() is for inline request handlers; use .lazy(() => import(...)) for lazy host mounts.",
        );
      }
      return awaited as Response;
    }

    return result;
  }

  /**
   * Resolve a `.lazy()` mount: invoke the zero-arg loader, then dispatch to the
   * module's default export.
   */
  async function executeLazyMount(
    loader: LazyHandler,
    request: Request,
    input: RouterRequestInput<any>,
  ): Promise<Response> {
    const module = await loader();

    if (typeof module === "object" && module !== null && "default" in module) {
      const defaultExport = (module as { default: Handler | HostRouter })
        .default;

      // Default export is a nested host router
      if (
        typeof defaultExport === "object" &&
        defaultExport !== null &&
        "match" in defaultExport
      ) {
        return (defaultExport as HostRouter).match(request, input);
      }

      // Otherwise treat the default export as a request handler
      return (defaultExport as Handler)(request, input);
    }

    throw new InvalidHandlerError(loader, {
      cause: {
        reason:
          "lazy mount did not resolve to a module with a default export; " +
          "use .lazy(() => import('./sub-app')) where the module default-exports a handler or host router",
      },
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

    test(hostname: string, pathname = "/"): HostMatchResult | null {
      const parts = hostname.split(".");

      for (const route of routes) {
        for (const pattern of route.patterns) {
          if (matchPattern(pattern, hostname, pathname, parts)) {
            return {
              pattern,
              handler: route.handler,
              kind: route.kind,
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
              () => executeHandler(fallbackRoute!, request, fallbackInput),
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
        executeHandler(matchedRoute, request, input),
      );
    },
  };

  // Register in the global HostRouterRegistry for build-time discovery.
  // The routes array and fallbackRoute ref are live - they reflect routes
  // added via .host().map()/.lazy() after this point.
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
