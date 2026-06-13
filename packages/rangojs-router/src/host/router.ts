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

export interface HostRouterRegistryEntry {
  routes: RouteEntry[];
  fallback: RouteEntry | null;
}

export const HostRouterRegistry: Map<string, HostRouterRegistryEntry> =
  new Map();

let hostRouterAutoId = 0;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

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

  async function executeLazyMount(
    loader: LazyHandler,
    request: Request,
    input: RouterRequestInput<any>,
  ): Promise<Response> {
    const module = await loader();

    if (typeof module === "object" && module !== null && "default" in module) {
      const defaultExport = (module as { default: Handler | HostRouter })
        .default;

      if (
        typeof defaultExport === "object" &&
        defaultExport !== null &&
        "match" in defaultExport
      ) {
        return (defaultExport as HostRouter).match(request, input);
      }

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

  const router: HostRouter = {
    host(patterns: HostPattern): HostRouteBuilder {
      const patternsArray = Array.isArray(patterns) ? patterns : [patterns];

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
        effectiveHostname = handleCookieOverride(request, hostOverride, input);
      } catch (error) {
        if (error instanceof HostRouterError) {
          log(`Cookie override error: ${error.message}`);

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

          if (hostOverride) {
            return createCookieErrorResponse(
              hostOverride.cookieName,
              error.message,
            );
          }
        }

        throw error;
      }

      const { pathname } = parseRequest(request);

      if (effectiveHostname !== parseRequest(request).hostname) {
        log(`Cookie override: ${effectiveHostname}`);
      }

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

      const allMiddleware = [...globalMiddleware, ...matchedRoute.middleware];

      return executeMiddleware(allMiddleware, request, input, () =>
        executeHandler(matchedRoute, request, input),
      );
    },
  };

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
