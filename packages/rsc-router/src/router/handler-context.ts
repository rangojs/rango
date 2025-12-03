/**
 * Router Handler Context
 *
 * Creates the handler context object passed to route handlers, middleware, and loaders.
 */

import type { HandlerContext } from "../types";

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
  // Variables object (mutable by middleware)
  const variables: any = {};

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
    // Placeholder use() - will be replaced with actual implementation during request
    use: () => {
      throw new Error("ctx.use() called before loaders were initialized");
    },
  };
}
