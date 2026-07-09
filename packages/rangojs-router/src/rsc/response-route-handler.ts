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
import { RESPONSE_TYPE_MIME } from "../router/content-negotiation.js";
import { createCacheScope, resolveCacheTags } from "../cache/cache-scope.js";
import { serveResponseRouteWithCache } from "./response-cache-serve.js";
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
  rewrapResponseRouteResponse,
} from "./helpers.js";
import { isWebSocketUpgradeResponse } from "../response-utils.js";
import { stringifyJsonRouteResult } from "./json-route-result.js";

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

    try {
      let result: unknown;
      try {
        result = await (preview.handler as Function)(responseHandlerCtx);
      } catch (error) {
        if (!(error instanceof Response)) throw error;
        result = error;
      }

      if (result instanceof Response) {
        return rewrapResponseRouteResponse(result);
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

  // Response-route cache: resolved through the shared serve leaf
  // (rsc/response-cache-serve.ts) so production and the dispatch testing
  // primitive share ONE owner of the cache contract. Returns undefined when no
  // cache applies, so we fall through to a plain handler run.
  if (preview.manifestEntry) {
    const cached = await serveResponseRouteWithCache({
      reqCtx,
      manifestEntry: preview.manifestEntry,
      responseType: preview.responseType,
      url,
      executeHandler,
      deps: { createCacheScope, resolveCacheTags },
    });
    if (cached !== undefined) return cached;
  }

  return executeHandler().then(finalizeResponse);
}
