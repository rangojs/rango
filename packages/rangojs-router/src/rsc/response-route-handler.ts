/**
 * Response Route Handler
 *
 * Handles response routes (JSON, text, HTML, XML, markdown, image, stream)
 * that bypass the RSC rendering pipeline entirely. Includes content-type
 * dispatch, route middleware execution, and response caching with SWR.
 */

import { RouterError } from "../errors.js";
import { requireRequestContext } from "../server/request-context.js";
import { contextGet } from "../context-var.js";
import { NOCACHE_SYMBOL } from "../cache/taint.js";
import { traverseBack } from "../router/pattern-matching.js";
import { createCacheScope } from "../cache/cache-scope.js";
import { executeMiddleware } from "../router/middleware.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import type { MiddlewareFn } from "../router/middleware.js";
import type { EntryData } from "../server/context.js";
import type { HandlerContext } from "./handler-context.js";
import { createResponseErrorPayload } from "./response-error.js";
import {
  createResponseWithMergedHeaders,
  isCacheableStatus,
  buildRouteMiddlewareEntries,
} from "./helpers.js";

export interface ResponseRouteMatch {
  responseType: string;
  handler: Function;
  params?: Record<string, string>;
  negotiated?: boolean;
  manifestEntry?: EntryData;
  routeMiddleware?: Array<{
    handler: MiddlewareFn;
    params: Record<string, string>;
  }>;
}

/**
 * Handle a response route (non-RSC). Dispatches by content type, wraps
 * with route middleware and response caching when configured.
 *
 * For partial (client-side navigation) requests, returns X-RSC-Reload
 * so the browser triggers a hard navigation to the response route URL.
 */
export async function handleResponseRoute<TEnv>(
  handlerCtx: HandlerContext<TEnv>,
  preview: ResponseRouteMatch,
  request: Request,
  env: TEnv,
  url: URL,
  variables: Record<string, any>,
): Promise<Response> {
  const isPartial = url.searchParams.has("_rsc_partial");

  // Partial requests (client-side navigation) to response routes
  // get X-RSC-Reload to trigger hard navigation in the browser
  if (isPartial) {
    return createResponseWithMergedHeaders(null, {
      status: 200,
      headers: {
        "X-RSC-Reload": stripInternalParams(url).toString(),
        "content-type": "text/x-component;charset=utf-8",
      },
    });
  }

  // Build lightweight context for response handler
  const reqCtx = requireRequestContext();
  const responseHandlerCtx = {
    request,
    params: preview.params || {},
    env,
    searchParams: url.searchParams,
    url,
    pathname: url.pathname,
    href: (name: string, hrefParams?: Record<string, string>) => {
      if (name.startsWith("/")) {
        if (!hrefParams) return name;
        return name.replace(/:([^/]+)/g, (_, key) => {
          const value = hrefParams[key];
          if (value === undefined)
            throw new Error(`Missing param "${key}" for path "${name}"`);
          return encodeURIComponent(value);
        });
      }
      return name;
    },
    get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
    header: (name: string, value: string) => reqCtx.header(name, value),
    setCookie: (name: string, value: string, options?: any) =>
      reqCtx.setCookie(name, value, options),
    _responseType: preview.responseType,
  };
  // Brand with taint symbol so "use cache" detects it as request-scoped
  // and extracts route-identifying properties (params, pathname, _responseType)
  (responseHandlerCtx as any)[NOCACHE_SYMBOL] = true;

  // Call handler directly, wrapped by route middleware if present
  const callHandler = async () => {
    const errorCtx = { request, url, env };

    // JSON response routes: wrap in { data } / { error } envelope
    if (preview.responseType === "json") {
      try {
        const result = await (preview.handler as Function)(responseHandlerCtx);
        if (result instanceof Response) {
          const mergedHeaders: Record<string, string> = {};
          result.headers.forEach((value, key) => {
            mergedHeaders[key] = value;
          });
          return createResponseWithMergedHeaders(result.body, {
            status: result.status,
            headers: mergedHeaders,
          });
        }
        return createResponseWithMergedHeaders(
          JSON.stringify({ data: result }),
          {
            status: 200,
            headers: { "content-type": "application/json;charset=utf-8" },
          },
        );
      } catch (error) {
        handlerCtx.callOnError(error, "handler", errorCtx);
        const isDev = process.env.NODE_ENV !== "production";
        const status = error instanceof RouterError ? error.status : 500;
        return createResponseWithMergedHeaders(
          JSON.stringify({
            error: createResponseErrorPayload(error, isDev),
          }),
          {
            status,
            headers: { "content-type": "application/json;charset=utf-8" },
          },
        );
      }
    }

    // Non-JSON response routes: catch errors and return plain Response
    try {
      const result = await (preview.handler as Function)(responseHandlerCtx);

      if (result instanceof Response) {
        // Handler returned a Response directly -- pass through
        const mergedHeaders: Record<string, string> = {};
        result.headers.forEach((value, key) => {
          mergedHeaders[key] = value;
        });
        return createResponseWithMergedHeaders(result.body, {
          status: result.status,
          headers: mergedHeaders,
        });
      }

      // Auto-wrap based on response type tag
      switch (preview.responseType) {
        case "text":
          return createResponseWithMergedHeaders(String(result), {
            status: 200,
            headers: { "content-type": "text/plain;charset=utf-8" },
          });
        case "html":
          return createResponseWithMergedHeaders(String(result), {
            status: 200,
            headers: { "content-type": "text/html;charset=utf-8" },
          });
        case "xml":
          return createResponseWithMergedHeaders(String(result), {
            status: 200,
            headers: { "content-type": "application/xml;charset=utf-8" },
          });
        case "md":
          return createResponseWithMergedHeaders(String(result), {
            status: 200,
            headers: { "content-type": "text/markdown;charset=utf-8" },
          });
        default:
          // image, stream, any -- must return Response
          throw new Error(
            `Response route handler for "${preview.responseType}" must return a Response object, got ${typeof result}`,
          );
      }
    } catch (error) {
      handlerCtx.callOnError(error, "handler", errorCtx);
      const isDev = process.env.NODE_ENV !== "production";
      const status = error instanceof RouterError ? error.status : 500;
      const message =
        error instanceof RouterError
          ? error.message
          : isDev && error instanceof Error
            ? error.message
            : "Internal Server Error";
      return createResponseWithMergedHeaders(message, {
        status,
        headers: { "content-type": "text/plain;charset=utf-8" },
      });
    }
  };

  // Wrap callHandler to append Vary: Accept on content-negotiated responses
  const callHandlerWithVary = async () => {
    const response = await callHandler();
    if (preview.negotiated) {
      response.headers.append("Vary", "Accept");
    }
    return response;
  };

  // Wrap with route middleware if present
  const executeHandler = async () => {
    if (preview.routeMiddleware && preview.routeMiddleware.length > 0) {
      return executeMiddleware(
        buildRouteMiddlewareEntries<TEnv>(preview.routeMiddleware),
        request,
        env,
        variables,
        callHandlerWithVary,
        createReverseFunction(handlerCtx.getRequiredRouteMap()),
      );
    }
    return callHandlerWithVary();
  };

  // Resolve cache config from entry tree (same pattern as match-api.ts)
  if (preview.manifestEntry) {
    const entries = [...traverseBack(preview.manifestEntry)];
    let cacheScope: ReturnType<typeof createCacheScope> = null;
    for (const entry of entries) {
      if (entry.cache) {
        cacheScope = createCacheScope(entry.cache, cacheScope);
      }
    }

    if (cacheScope?.enabled) {
      const store = cacheScope.getStore() ?? reqCtx._cacheStore;
      if (store?.getResponse && store?.putResponse) {
        // Build cache key with response:{type}: prefix to avoid collision
        // with segment keys and differentiate between response types.
        // Include url.search so query-driven responses cache separately.
        let cacheKey = `response:${preview.responseType}:${url.pathname}${url.search}`;

        // Priority 1: Route-level key function (full override)
        if (cacheScope.config !== false && cacheScope.config.key) {
          try {
            const customKey = await cacheScope.config.key(reqCtx);
            cacheKey = `response:${customKey}`;
          } catch {
            // Fall back to default key on route-level key failure
          }
        } else if (store.keyGenerator) {
          // Priority 2: Store-level keyGenerator (modifies default key)
          try {
            cacheKey = await store.keyGenerator(reqCtx, cacheKey);
          } catch {
            // Fall back to default key on keyGenerator failure
          }
        }

        // Save pre-handler callbacks (registered by app-level middleware
        // before we reach the cache block) and clear the live array.
        // createResponseWithMergedHeaders (inside the handler) eagerly
        // executes any callbacks present in _onResponseCallbacks, so
        // handler-registered callbacks are baked into the handler's
        // response and the cached artifact. Pre-handler callbacks are
        // NOT in the live array during execution, so they are applied
        // once per serve on every path (hit + miss) below.
        const savedCallbacks = reqCtx._onResponseCallbacks;
        reqCtx._onResponseCallbacks = [];

        const applyPreHandlerCallbacks = (response: Response): Response => {
          let result = response;
          for (const callback of savedCallbacks) {
            result = callback(result) ?? result;
          }
          return result;
        };

        try {
          const cached = await store.getResponse(cacheKey);

          if (cached && isCacheableStatus(cached.response.status)) {
            if (!cached.shouldRevalidate) {
              // Fresh hit
              return applyPreHandlerCallbacks(cached.response);
            }

            // Stale hit (SWR) - return cached, revalidate in background
            reqCtx.waitUntil(async () => {
              try {
                const fresh = await executeHandler();
                if (isCacheableStatus(fresh.status)) {
                  await store.putResponse!(
                    cacheKey,
                    fresh,
                    cacheScope!.ttl,
                    cacheScope!.swr,
                  );
                }
              } catch (error) {
                console.error(`[ResponseCache] Revalidation failed:`, error);
              }
            });

            return applyPreHandlerCallbacks(cached.response);
          }
        } catch (error) {
          console.error(`[ResponseCache] Cache lookup failed:`, error);
        }

        // Cache miss - execute handler and cache the result.
        // createResponseWithMergedHeaders inside the handler applies
        // any callbacks registered during execution, so the response
        // (and its clone) already include those transforms.
        const response = await executeHandler();

        if (isCacheableStatus(response.status)) {
          reqCtx.waitUntil(async () => {
            try {
              await store.putResponse!(
                cacheKey,
                response.clone(),
                cacheScope!.ttl,
                cacheScope!.swr,
              );
            } catch (error) {
              console.error(`[ResponseCache] Cache write failed:`, error);
            }
          });
        }

        return applyPreHandlerCallbacks(response);
      }
    }
  }

  return executeHandler();
}
