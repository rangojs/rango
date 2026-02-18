/**
 * Router Handler Context
 *
 * Creates the handler context object passed to route handlers, middleware, and loaders.
 */

import type { HandlerContext, InternalHandlerContext } from "../types";
import type { HandleStore } from "../server/handle-store.js";
import { getRequestContext } from "../server/request-context.js";
import { getSearchSchema } from "../route-map-builder.js";
import { parseSearchParams, serializeSearchParams } from "../search-params.js";

/**
 * Resolve route name with namespace prefix support.
 * Supports local names, absolute names (dot notation), and path-based URLs.
 */
function resolveRouteName(
  name: string,
  routeMap: Record<string, string>,
  currentRoutePrefix?: string
): string | undefined {
  // 1. Path-based - starts with /
  if (name.startsWith("/")) {
    return name;
  }

  // 2. Absolute name - already has a dot (e.g., "shop.cart")
  if (name.includes(".")) {
    return routeMap[name];
  }

  // 3. Local name - try with current prefix first, then fall back to direct lookup
  if (currentRoutePrefix) {
    // Extract the prefix from current route name
    // e.g., "blog.posts.detail" → prefix is "blog.posts"
    const lastDot = currentRoutePrefix.lastIndexOf(".");
    const prefix = lastDot > 0 ? currentRoutePrefix.substring(0, lastDot) : currentRoutePrefix;

    // Try prefixed name
    const prefixedName = `${prefix}.${name}`;
    if (routeMap[prefixedName] !== undefined) {
      return routeMap[prefixedName];
    }

    // If current route is a nested include, try parent prefixes
    // e.g., for "blog.posts.detail", try "blog.posts.index", then "blog.index"
    let currentPrefix = prefix;
    while (currentPrefix.includes(".")) {
      const parentDot = currentPrefix.lastIndexOf(".");
      currentPrefix = currentPrefix.substring(0, parentDot);
      const parentPrefixedName = `${currentPrefix}.${name}`;
      if (routeMap[parentPrefixedName] !== undefined) {
        return routeMap[parentPrefixedName];
      }
    }
  }

  // Fall back to direct lookup (route without prefix)
  return routeMap[name];
}

/**
 * Create HandlerContext with typed env/var/get/set
 */
export function createHandlerContext<TEnv>(
  params: Record<string, string>,
  request: Request,
  searchParams: URLSearchParams,
  pathname: string,
  url: URL,
  bindings: any = {},
  routeMap: Record<string, string> = {},
  routeName?: string
): InternalHandlerContext<any, TEnv> {
  // Get variables from request context - this is the unified context
  // shared between middleware and route handlers
  const requestContext = getRequestContext();
  const variables: any = requestContext?.var ?? {};

  // Filter system parameters (starting with _rsc) from searchParams
  // This ensures handlers only see user-facing query params
  const cleanSearchParams = new URLSearchParams();
  searchParams.forEach((value, key) => {
    if (!key.startsWith("_rsc")) {
      cleanSearchParams.append(key, value);
    }
  });

  // Create clean URL without system params
  const cleanUrl = new URL(url);
  cleanUrl.search = cleanSearchParams.toString();

  // If route has a search schema, parse URLSearchParams into typed object
  const searchSchema = routeName ? getSearchSchema(routeName) : undefined;
  const resolvedSearchParams = searchSchema
    ? parseSearchParams(cleanSearchParams, searchSchema)
    : cleanSearchParams;

  // Get stub response from request context for setting headers
  const stubResponse = requestContext?.res ?? new Response(null, { status: 200 });

  return {
    params,
    request,
    searchParams: resolvedSearchParams as any, // Filtered params (typed object or URLSearchParams)
    pathname,
    url: cleanUrl, // Clean URL
    env: bindings,
    var: variables,
    get: ((key: string) => variables[key]) as HandlerContext<
      any,
      TEnv
    >["get"],
    set: ((key: string, value: any) => {
      variables[key] = value;
    }) as HandlerContext<any, TEnv>["set"],
    _originalRequest: request, // Raw request for advanced use
    res: stubResponse, // Stub response for setting headers
    headers: stubResponse.headers, // Shorthand for res.headers
    // Placeholder use() - will be replaced with actual implementation during request
    use: () => {
      throw new Error("ctx.use() called before loaders were initialized");
    },
    // Theme support (when enabled via router config)
    theme: requestContext?.theme,
    setTheme: requestContext?.setTheme,
    // Location state support (delegates to request context)
    setLocationState(entries) {
      if (!requestContext) {
        throw new Error("setLocationState() is not available outside a request context");
      }
      requestContext.setLocationState(entries);
    },
    // Scoped reverse for URL generation
    reverse: (name: string, hrefParams?: Record<string, string>, search?: Record<string, unknown>) => {
      // Path-based - return directly (optionally with param substitution)
      if (name.startsWith("/")) {
        let result = name;
        if (hrefParams) {
          result = result.replace(/:([^/]+)/g, (_, key) => {
            const value = hrefParams[key];
            if (value === undefined) {
              throw new Error(`Missing param "${key}" for path "${name}"`);
            }
            return encodeURIComponent(value);
          });
        }
        if (search) {
          const qs = serializeSearchParams(search);
          if (qs) result += `?${qs}`;
        }
        return result;
      }

      // Resolve route name with namespace support
      const pattern = resolveRouteName(name, routeMap, routeName);

      if (pattern === undefined) {
        throw new Error(
          `Unknown route: "${name}"${routeName ? ` (current route: ${routeName})` : ""}`
        );
      }

      let result = pattern;

      // Substitute params
      if (hrefParams) {
        result = result.replace(/:([^/]+)/g, (_, key) => {
          const value = hrefParams[key];
          if (value === undefined) {
            throw new Error(`Missing param "${key}" for route "${name}"`);
          }
          return encodeURIComponent(value);
        });
      }

      // Append search params as query string
      if (search) {
        const qs = serializeSearchParams(search);
        if (qs) result += `?${qs}`;
      }

      return result;
    },
  };
}

/**
 * Create a BuildContext for pre-rendering.
 *
 * Returns a HandlerContext-compatible object where params, pathname, url,
 * and use(handle) work, but request/env/headers/cookies/var/searchParams
 * throw with a clear error. Loaders are not available during pre-rendering.
 */
export function createBuildContext<TEnv>(
  params: Record<string, string>,
  pathname: string,
  handleStore: HandleStore,
): InternalHandlerContext<any, TEnv> {
  const syntheticUrl = new URL(`http://prerender${pathname}`);

  function throwUnavailable(prop: string): never {
    throw new Error(
      `Property "${prop}" is not available during pre-rendering. ` +
        `Fetch data directly in the handler or use a passthrough prerender handler.`,
    );
  }

  return {
    params,
    get request(): Request {
      return throwUnavailable("request");
    },
    get searchParams(): URLSearchParams {
      return throwUnavailable("searchParams");
    },
    pathname,
    url: syntheticUrl,
    get env(): TEnv {
      return throwUnavailable("env");
    },
    get var(): any {
      return throwUnavailable("var");
    },
    get: (() => {
      throwUnavailable("get");
    }) as any,
    set: (() => {
      throwUnavailable("set");
    }) as any,
    get _originalRequest(): Request {
      return throwUnavailable("request");
    },
    get res(): Response {
      return throwUnavailable("res");
    },
    get headers(): Headers {
      return throwUnavailable("headers");
    },
    // Placeholder use() - replaced by setupBuildUse
    use: () => {
      throw new Error("ctx.use() called before build context was initialized");
    },
    theme: undefined,
    setTheme: undefined,
    setLocationState: () => {
      throwUnavailable("setLocationState");
    },
    reverse: () => {
      throwUnavailable("reverse");
    },
  } as InternalHandlerContext<any, TEnv>;
}
