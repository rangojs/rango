/**
 * Router Handler Context
 *
 * Creates the handler context object passed to route handlers, middleware, and loaders.
 */

import type { HandlerContext, InternalHandlerContext } from "../types";
import { getRequestContext } from "../server/request-context.js";

/**
 * Resolve route name with namespace prefix support.
 * Same logic as client-side useHref for consistency.
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
      cleanSearchParams.set(key, value);
    }
  });

  // Create clean URL without system params
  const cleanUrl = new URL(url);
  cleanUrl.search = cleanSearchParams.toString();

  // Get stub response from request context for setting headers
  const stubResponse = requestContext?.res ?? new Response(null, { status: 200 });

  return {
    params,
    request,
    searchParams: cleanSearchParams, // Filtered params
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
    // Scoped href for URL generation
    href: (name: string, hrefParams?: Record<string, string>) => {
      // Path-based - return directly (optionally with param substitution)
      if (name.startsWith("/")) {
        if (hrefParams) {
          return name.replace(/:([^/]+)/g, (_, key) => {
            const value = hrefParams[key];
            if (value === undefined) {
              throw new Error(`Missing param "${key}" for path "${name}"`);
            }
            return encodeURIComponent(value);
          });
        }
        return name;
      }

      // Resolve route name with namespace support
      const pattern = resolveRouteName(name, routeMap, routeName);

      if (pattern === undefined) {
        throw new Error(
          `Unknown route: "${name}"${routeName ? ` (current route: ${routeName})` : ""}`
        );
      }

      // If no params, return pattern directly
      if (!hrefParams) {
        return pattern;
      }

      // Substitute params
      return pattern.replace(/:([^/]+)/g, (_, key) => {
        const value = hrefParams[key];
        if (value === undefined) {
          throw new Error(`Missing param "${key}" for route "${name}"`);
        }
        return encodeURIComponent(value);
      });
    },
  };
}
