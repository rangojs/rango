/**
 * Router Handler Context
 *
 * Creates the handler context object passed to route handlers, middleware, and loaders.
 */

import type { HandlerContext } from "../types";
import { getRequestContext } from "../server/request-context.js";

/**
 * Create HandlerContext with typed env/var/get/set
 */
export function createHandlerContext<TEnv>(
  params: Record<string, string>,
  request: Request,
  searchParams: URLSearchParams,
  pathname: string,
  url: URL,
  bindings: any = {}
): HandlerContext<any, TEnv> {
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
  };
}
