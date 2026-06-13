/**
 * RSC Handler Helpers
 *
 * Utility functions for RSC request handling.
 */

import {
  _getRequestContext,
  getLocationState,
} from "../server/request-context.js";
import type { RequestContext } from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import { isRedirectResponse } from "../response-utils.js";
import type { MiddlewareEntry, MiddlewareFn } from "../router/middleware.js";
import { formatCacheSignalHeader } from "../router/telemetry.js";

/**
 * DEVELOPMENT/TEST ONLY. When the debug cache signal gate is on,
 * match/matchPartial populate ctx._cacheSignal. Emit it as the X-Rango-Cache
 * header. When the gate is off, ctx._cacheSignal is undefined and NOTHING is
 * attached — output is byte-identical to the default. Header mutation failures
 * are swallowed so immutable Response headers (e.g. protocol-switch) are safe.
 */
function applyCacheSignalHeader(target: Headers, ctx: RequestContext): void {
  const signal = ctx._cacheSignal;
  if (!signal || signal.length === 0) return;
  try {
    target.set("X-Rango-Cache", formatCacheSignalHeader(signal));
  } catch {
    // Headers immutable — skip.
  }
}

/**
 * Copy stub headers from the request context onto a target Headers instance:
 * append Set-Cookie entries, set everything else only if absent. Header
 * mutation failures are swallowed so the same logic works against Response
 * headers that may be immutable (e.g. Cloudflare protocol-switch responses).
 */
function applyStubHeaders(target: Headers, stub: Headers): void {
  stub.forEach((value, name) => {
    try {
      if (name.toLowerCase() === "set-cookie") {
        target.append(name, value);
      } else if (!target.has(name)) {
        target.set(name, value);
      }
    } catch {
      // Headers immutable — skip.
    }
  });
}

/**
 * Drain ctx._onResponseCallbacks onto a response. Swapping the array before
 * iteration prevents re-entrant registrations from double-firing and matches
 * the contract that each callback runs at most once per request.
 */
function drainOnResponseCallbacks(
  ctx: RequestContext,
  response: Response,
): Response {
  const callbacks = ctx._onResponseCallbacks;
  if (callbacks.length === 0) return response;
  ctx._onResponseCallbacks = [];
  let result = response;
  for (const callback of callbacks) {
    result = callback(result) ?? result;
  }
  return result;
}

/**
 * Check if a request body has content to decode
 */
export function hasBodyContent(body: FormData | string): boolean {
  if (body instanceof FormData) {
    let hasContent = false;
    body.forEach(() => {
      hasContent = true;
    });
    return hasContent;
  }
  return typeof body === "string" && body.length > 0;
}

/**
 * Create a Response with headers merged from the request context's stub response.
 * This ensures headers/cookies set during middleware or handler execution are included.
 * Also triggers any registered onResponse callbacks.
 */
export function createResponseWithMergedHeaders(
  body: BodyInit | null,
  init: ResponseInit,
): Response {
  const ctx = _getRequestContext();
  if (!ctx) {
    return new Response(body, init);
  }

  // Delete Set-Cookie from the stub after consuming so downstream merge
  // points (e.g. executeMiddleware) don't duplicate them.
  const mergedHeaders = new Headers(init.headers);
  applyStubHeaders(mergedHeaders, ctx.res.headers);
  ctx.res.headers.delete("set-cookie");
  applyCacheSignalHeader(mergedHeaders, ctx);

  // ctx.res.status overrides init.status when explicitly set (e.g. 404 for
  // notFound, 500 for error). Default ctx.res.status is 200.
  const status = ctx.res.status !== 200 ? ctx.res.status : init.status;

  const response = new Response(body, {
    ...init,
    status,
    headers: mergedHeaders,
  });

  return drainOnResponseCallbacks(ctx, response);
}

/**
 * Create a 204 response with X-RSC-Redirect header for stateless redirects.
 * Used during partial/action requests where fetch would auto-follow a raw
 * 3xx to a URL that renders full HTML instead of Flight data. The 204 status
 * prevents auto-follow; the client reads the header and re-navigates via
 * the router.
 */
export function createSimpleRedirectResponse(redirectUrl: string): Response {
  return createResponseWithMergedHeaders(null, {
    status: 204,
    headers: { "X-RSC-Redirect": redirectUrl },
  });
}

/**
 * Carry over headers from a source redirect Response to a wrapper Response.
 * Skips Location and X-RSC-Redirect (intentionally replaced by the wrapper)
 * and appends Set-Cookie to avoid clobbering multiple cookie headers.
 */
export function carryOverRedirectHeaders(
  source: Response,
  target: Response,
): void {
  source.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "location" || lower === "x-rsc-redirect") return;
    if (lower === "set-cookie") {
      target.headers.append(name, value);
    } else if (!target.headers.has(name)) {
      target.headers.set(name, value);
    }
  });
}

/**
 * If a response is a 3xx redirect during a partial (client-side) request,
 * intercept it and return a Flight-compatible redirect instead.
 * fetch() auto-follows 3xx which would hit a URL that renders full HTML
 * the client can't parse. Returns null if the response is not a redirect.
 */
export function interceptRedirectForPartial(
  response: Response,
  createRedirectFlightResponse: (
    redirectUrl: string,
    locationState?: Record<string, unknown>,
  ) => Response,
): Response | null {
  if (!isRedirectResponse(response)) {
    return null;
  }
  const redirectUrl = response.headers.get("Location")!;
  const locationState = getLocationState();
  let intercepted: Response;
  if (locationState) {
    intercepted = createRedirectFlightResponse(
      redirectUrl,
      resolveLocationStateEntries(locationState),
    );
  } else {
    intercepted = createSimpleRedirectResponse(redirectUrl);
  }

  carryOverRedirectHeaders(response, intercepted);

  return intercepted;
}

/**
 * Only cache successful responses. Non-200 statuses (errors, redirects) are
 * not cached -- notFound() produces 500 in response routes, and explicit
 * non-200 Responses are rare enough that caching them would be surprising.
 */
export function isCacheableStatus(status: number): boolean {
  return status === 200;
}

/**
 * Convert route-level middleware entries to the format expected by
 * executeMiddleware. Route middleware from previewMatch carries just
 * { handler, params }; this wraps them in the full MiddlewareEntry shape.
 */
export function buildRouteMiddlewareEntries<TEnv>(
  routeMiddleware: Array<{
    handler: MiddlewareFn;
    params: Record<string, string>;
  }>,
): Array<{ entry: MiddlewareEntry<TEnv>; params: Record<string, string> }> {
  return routeMiddleware.map((mw) => ({
    entry: {
      pattern: null,
      regex: null,
      paramNames: [],
      handler: mw.handler,
      mountPrefix: null,
    } as MiddlewareEntry<TEnv>,
    params: mw.params,
  }));
}

/**
 * Merge stub headers from the request context onto an existing Response in
 * place, then drain onResponse callbacks. Used when a Response cannot flow
 * through `new Response()` — status 101 is outside the constructor's
 * 200-599 range, and the Cloudflare-specific `webSocket` property would be
 * lost on reconstruction.
 */
export function mergeStubHeadersAndFinalize(response: Response): Response {
  const ctx = _getRequestContext();
  if (!ctx) return response;

  applyStubHeaders(response.headers, ctx.res.headers);
  ctx.res.headers.delete("set-cookie");

  return drainOnResponseCallbacks(ctx, response);
}

/**
 * Run onResponse callbacks on an existing Response. Used by code paths that
 * bypass createResponseWithMergedHeaders (e.g. middleware short-circuits)
 * but still need ctx.onResponse() callbacks to fire.
 */
export function finalizeResponse(response: Response): Response {
  const ctx = _getRequestContext();
  if (!ctx) return response;
  return drainOnResponseCallbacks(ctx, response);
}
