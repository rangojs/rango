/**
 * Router Handler Context
 *
 * Creates the handler context object passed to route handlers, middleware, and loaders.
 */

import type { HandlerContext, InternalHandlerContext } from "../types";
import { getRequestContext } from "../server/request-context.js";
import { getSearchSchema } from "../route-map-builder.js";
import { parseSearchParams, serializeSearchParams } from "../search-params.js";
import { contextGet, contextSet } from "../context-var.js";

/**
 * Resolve route name with namespace prefix support.
 * Supports local names (dot-prefixed) and absolute names (global lookup).
 */
function resolveRouteName(
  name: string,
  routeMap: Record<string, string>,
  currentRoutePrefix?: string
): string | undefined {
  // 1. Dot-prefixed (".article", ".author.posts") — local resolution only.
  //    Resolves within the current include() scope using the mount prefix.
  if (name.startsWith(".")) {
    const lookupName = name.slice(1);
    if (!currentRoutePrefix) return undefined;

    // Extract the include prefix from current route name
    // e.g., "magazine.author" -> prefix is "magazine"
    const lastDot = currentRoutePrefix.lastIndexOf(".");
    const prefix = lastDot > 0 ? currentRoutePrefix.substring(0, lastDot) : currentRoutePrefix;

    // Try prefixed name at current level
    const prefixedName = `${prefix}.${lookupName}`;
    if (routeMap[prefixedName] !== undefined) {
      return routeMap[prefixedName];
    }

    // Walk up parent prefixes for nested includes
    let currentPrefix = prefix;
    while (currentPrefix.includes(".")) {
      const parentDot = currentPrefix.lastIndexOf(".");
      currentPrefix = currentPrefix.substring(0, parentDot);
      const parentPrefixedName = `${currentPrefix}.${lookupName}`;
      if (routeMap[parentPrefixedName] !== undefined) {
        return routeMap[parentPrefixedName];
      }
    }

    return undefined;
  }

  // 2. Unprefixed ("magazine.index", "blog.post") — global resolution only.
  //    Direct lookup in the full named-routes map.
  return routeMap[name];
}

/**
 * Create a reverse function for URL generation from route names.
 * Used by both HandlerContext and MiddlewareContext.
 */
export function createReverseFunction(
  routeMap: Record<string, string>,
  currentRoutePrefix?: string
): (name: string, hrefParams?: Record<string, string>, search?: Record<string, unknown>) => string {
  return (name, hrefParams, search) => {
    // Resolve route name with namespace support
    const pattern = resolveRouteName(name, routeMap, currentRoutePrefix);

    if (pattern === undefined) {
      throw new Error(
        `Unknown route: "${name}"${currentRoutePrefix ? ` (current route: ${currentRoutePrefix})` : ""}`
      );
    }

    let result = pattern;

    // Substitute params (strip constraint syntax: :param(a|b) -> value)
    if (hrefParams) {
      result = result.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)(\([^)]*\))?/g, (_, key) => {
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
  };
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
    build: false,
    request,
    searchParams: cleanSearchParams,
    search: searchSchema ? resolvedSearchParams : {},
    pathname,
    url: cleanUrl, // Clean URL
    env: bindings,
    var: variables,
    get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as HandlerContext<
      any,
      TEnv
    >["get"],
    set: ((keyOrVar: any, value: any) => {
      contextSet(variables, keyOrVar, value);
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
    reverse: createReverseFunction(routeMap, routeName),
  };
}

/**
 * Create a PrerenderContext for Prerender() handlers at build time.
 *
 * Returns an InternalHandlerContext where params, pathname, url, searchParams,
 * search, reverse, and use(handle) work. Request-time properties
 * (request, env, headers, cookies, var, get, set, res) throw with a clear error.
 */
export function createPrerenderContext<TEnv>(
  params: Record<string, string>,
  pathname: string,
  routeMap: Record<string, string>,
  routeName?: string,
  buildVars?: Record<string, any>,
): InternalHandlerContext<any, TEnv> {
  const syntheticUrl = new URL(`http://prerender${pathname}`);
  const variables = buildVars ?? {};

  function throwUnavailable(prop: string): never {
    throw new Error(
      `Property "${prop}" is not available during pre-rendering. ` +
        `Fetch data directly in the handler or use a passthrough prerender handler.`,
    );
  }

  return {
    params,
    build: true,
    get request(): Request {
      return throwUnavailable("request");
    },
    searchParams: syntheticUrl.searchParams,
    search: {},
    pathname,
    url: syntheticUrl,
    get env(): TEnv {
      return throwUnavailable("env");
    },
    get var(): any {
      return throwUnavailable("var");
    },
    get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
    set: ((keyOrVar: any, value: any) => {
      contextSet(variables, keyOrVar, value);
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
    reverse: createReverseFunction(routeMap, routeName),
  } as InternalHandlerContext<any, TEnv>;
}

/**
 * Create a StaticContext for Static() handlers at build time.
 *
 * Returns an InternalHandlerContext where only reverse and use(handle) work.
 * Static handlers have no URL, no params, no pathname — everything else throws.
 */
export function createStaticContext<TEnv>(
  routeMap: Record<string, string>,
  routeName?: string,
): InternalHandlerContext<any, TEnv> {
  const variables: Record<string, any> = {};

  function throwUnavailable(prop: string): never {
    throw new Error(
      `Property "${prop}" is not available in Static() handlers. ` +
        `Static handlers render content without request context.`,
    );
  }

  return {
    get params(): any {
      return throwUnavailable("params");
    },
    build: true,
    get request(): Request {
      return throwUnavailable("request");
    },
    get searchParams(): URLSearchParams {
      return throwUnavailable("searchParams");
    },
    get search(): any {
      return throwUnavailable("search");
    },
    get pathname(): string {
      return throwUnavailable("pathname");
    },
    get url(): URL {
      return throwUnavailable("url");
    },
    get env(): TEnv {
      return throwUnavailable("env");
    },
    get var(): any {
      return throwUnavailable("var");
    },
    get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
    set: ((keyOrVar: any, value: any) => {
      contextSet(variables, keyOrVar, value);
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
    reverse: createReverseFunction(routeMap, routeName),
  } as InternalHandlerContext<any, TEnv>;
}
