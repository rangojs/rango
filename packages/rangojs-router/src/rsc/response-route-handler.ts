/**
 * Response Route Handler
 *
 * Handles response routes (JSON, text, HTML, XML, markdown, image, stream)
 * that bypass the RSC rendering pipeline entirely. Includes content-type
 * dispatch, route middleware execution, and response caching with SWR.
 */

import { RouterError } from "../errors.js";
import { getRequestContext } from "../server/request-context.js";
import { contextGet } from "../context-var.js";
import { NOCACHE_SYMBOL } from "../cache/taint.js";
import { traverseBack } from "../router/pattern-matching.js";
import { RESPONSE_TYPE_MIME } from "../router/content-negotiation.js";
import { createCacheScope, resolveCacheTags } from "../cache/cache-scope.js";
import { executeMiddleware } from "../router/middleware.js";
import {
  createReverseFunction,
  stripInternalParams,
} from "../router/handler-context.js";
import type { MiddlewareFn } from "../router/middleware.js";
import type { EntryData } from "../server/context.js";
import type { HandlerContext } from "./handler-context.js";
import { createProblemDetails } from "./response-error.js";
import {
  createResponseWithMergedHeaders,
  finalizeResponse,
  isCacheableStatus,
  buildRouteMiddlewareEntries,
  mergeStubHeadersAndFinalize,
} from "./helpers.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
import { stringifyJsonRouteResult } from "./json-route-result.js";
import {
  EXTERNAL_REDIRECT_MARKER,
  isExternalRedirect,
  markExternalRedirect,
} from "../redirect-origin.js";

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
  const reqCtx = getRequestContext();
  const cleanUrl = stripInternalParams(url);
  const responseHandlerCtx = {
    request,
    params: preview.params || {},
    env,
    searchParams: cleanUrl.searchParams,
    url: cleanUrl,
    originalUrl: reqCtx.originalUrl,
    pathname: url.pathname,
    reverse: createReverseFunction(handlerCtx.getRequiredRouteMap()),
    get: ((keyOrVar: any) => contextGet(variables, keyOrVar)) as any,
    header: (name: string, value: string) => reqCtx.header(name, value),
    waitUntil: reqCtx.waitUntil.bind(reqCtx),
    executionContext: reqCtx.executionContext,
    _responseType: preview.responseType,
  };
  // Brand with taint symbol so "use cache" detects it as request-scoped
  // and extracts route-identifying properties (params, pathname, _responseType)
  (responseHandlerCtx as any)[NOCACHE_SYMBOL] = true;

  // Call handler directly, wrapped by route middleware if present
  const callHandler = async () => {
    const errorCtx = { request, url, env };

    // Re-wrap a handler-returned Response through createResponseWithMergedHeaders
    // so that stub headers (cookies, custom headers set via ctx.header()) are included.
    // Use Headers (not Record<string, string>) to preserve duplicate entries like Set-Cookie.
    const rewrapResponse = (result: Response) => {
      // 204/205/304 are NOT short-circuited — they're valid for the Response
      // constructor and must honor ctx.setStatus() overrides. Only upgrade
      // responses (status 101 / `webSocket` property) bypass reconstruction.
      if (isWebSocketUpgradeResponse(result)) {
        return mergeStubHeadersAndFinalize(result);
      }
      const headers = new Headers();
      result.headers.forEach((value, key) => {
        // Never copy the reserved external-redirect marker off a handler result.
        // It is not a trust signal -- the opt-in is the out-of-band brand below
        // -- and a proxy-style route returning an attacker-controlled upstream
        // response must not let a forged value ride through to the browser.
        if (key.toLowerCase() === EXTERNAL_REDIRECT_MARKER) return;
        if (key.toLowerCase() === "set-cookie") {
          headers.append(key, value);
        } else {
          headers.set(key, value);
        }
      });
      const rewrapped = createResponseWithMergedHeaders(result.body, {
        status: result.status,
        headers,
      });
      // Transfer the out-of-band external brand only when the handler result is
      // genuinely branded (a real redirect(url, { external: true })). A proxied
      // upstream Response is never branded, so an attacker cannot opt a response
      // route's redirect out of the same-origin guard by injecting the header.
      if (isExternalRedirect(result)) {
        markExternalRedirect(rewrapped);
      }
      return rewrapped;
    };

    try {
      const result = await (preview.handler as Function)(responseHandlerCtx);

      if (result instanceof Response) {
        return rewrapResponse(result);
      }

      // Handled before the MIME lookup (json is also a RESPONSE_TYPE_MIME key).
      if (preview.responseType === "json") {
        // Runtime guard: the json() return type rejects nested Promises at
        // compile time, but an `as`-cast or untyped (JS) handler can still slip
        // one through. stringifyJsonRouteResult throws a clear error instead of
        // shipping empty data (shared with dispatch() so the two cannot drift).
        const body = stringifyJsonRouteResult(result);
        return createResponseWithMergedHeaders(body, {
          status: 200,
          headers: { "content-type": "application/json;charset=utf-8" },
        });
      }

      // Object.hasOwn (not truthiness) so prototype names like "toString" are not
      // matched; image/stream/any are absent and fall through to the throw.
      if (Object.hasOwn(RESPONSE_TYPE_MIME, preview.responseType)) {
        return createResponseWithMergedHeaders(String(result), {
          status: 200,
          headers: {
            "content-type": `${RESPONSE_TYPE_MIME[preview.responseType]};charset=utf-8`,
          },
        });
      }

      throw new Error(
        `Response route handler for "${preview.responseType}" must return a Response object, got ${typeof result}`,
      );
    } catch (error) {
      handlerCtx.callOnError(error, "handler", errorCtx);
      const isDev = process.env.NODE_ENV !== "production";
      const derivedStatus = error instanceof RouterError ? error.status : 500;
      // Resolve the effective status the same way createResponseWithMergedHeaders
      // will (ctx.res.status override) so the problem body's status/title match
      // the actual HTTP status — e.g. when a handler called ctx.setStatus()
      // before throwing.
      const status =
        reqCtx.res.status !== 200 ? reqCtx.res.status : derivedStatus;

      if (preview.responseType === "json") {
        return createResponseWithMergedHeaders(
          JSON.stringify(createProblemDetails(error, status, isDev)),
          {
            status,
            headers: {
              "content-type": "application/problem+json;charset=utf-8",
            },
          },
        );
      }

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
    if (preview.negotiated && !isWebSocketUpgradeResponse(response)) {
      // Skip Vary on upgrade responses: headers are semantically immutable
      // on some runtimes, and Vary is meaningless for a 101 response.
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
    let cacheScope: ReturnType<typeof createCacheScope> = null;
    for (const entry of traverseBack(preview.manifestEntry)) {
      if (entry.cache) {
        cacheScope = createCacheScope(entry.cache, cacheScope);
      }
    }

    if (cacheScope?.enabled) {
      // Evaluate condition — skip response cache when condition returns false
      let conditionPassed = true;
      if (cacheScope.config !== false && cacheScope.config.condition) {
        try {
          conditionPassed = !!cacheScope.config.condition(reqCtx);
        } catch {
          conditionPassed = false;
        }
      }

      const store = cacheScope.getStore() ?? reqCtx._cacheStore;
      if (conditionPassed && store?.getResponse && store?.putResponse) {
        // Build cache key with response:{type}: prefix to avoid collision
        // with segment keys and differentiate between response types.
        // Include host and url.search so query-driven and multi-host
        // responses cache separately.
        let cacheKey = `response:${preview.responseType}:${url.host}${url.pathname}${url.search}`;

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

        // Resolve cache tags for this document entry (static or dynamic),
        // while request context is available. Passed to putResponse so the
        // entry is tag-invalidatable.
        const responseTags = resolveCacheTags(cacheScope.config, reqCtx);

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
                // finalizeResponse drains any onResponse callbacks registered
                // during middleware execution (e.g. middleware short-circuit)
                // that createResponseWithMergedHeaders didn't reach.
                const fresh = finalizeResponse(await executeHandler());
                if (isCacheableStatus(fresh.status)) {
                  await store.putResponse!(
                    cacheKey,
                    fresh.clone(),
                    cacheScope!.ttl,
                    cacheScope!.swr,
                    responseTags,
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
        // createResponseWithMergedHeaders inside the handler drains callbacks
        // registered during handler execution. finalizeResponse catches any
        // remaining callbacks (e.g. from middleware short-circuit where the
        // handler never ran) so the cached artifact includes all transforms.
        const response = finalizeResponse(await executeHandler());

        if (isCacheableStatus(response.status)) {
          reqCtx.waitUntil(async () => {
            try {
              await store.putResponse!(
                cacheKey,
                response.clone(),
                cacheScope!.ttl,
                cacheScope!.swr,
                responseTags,
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

  return executeHandler().then(finalizeResponse);
}
