/**
 * RSC Handler Helpers
 *
 * Utility functions for RSC request handling.
 */

import {
  _getRequestContext,
  getLocationState,
} from "../server/request-context.js";
import { resolveLocationStateEntries } from "../browser/react/location-state-shared.js";
import type { MiddlewareEntry, MiddlewareFn } from "../router/middleware.js";

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

  // Merge headers from stub response into the new response
  const mergedHeaders = new Headers(init.headers);
  ctx.res.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") {
      mergedHeaders.append(name, value);
    } else if (!mergedHeaders.has(name)) {
      // Only set if not already present in init.headers
      mergedHeaders.set(name, value);
    }
  });

  // Use ctx.res.status if it was set (e.g., 404 for notFound, 500 for error)
  // Otherwise use the status from init
  const status = ctx.res.status !== 200 ? ctx.res.status : init.status;

  let response = new Response(body, {
    ...init,
    status,
    headers: mergedHeaders,
  });

  // Run onResponse callbacks - each can inspect/modify the response
  for (const callback of ctx._onResponseCallbacks) {
    response = callback(response) ?? response;
  }

  return response;
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
  const redirectUrl = response.headers.get("Location");
  if (!(response.status >= 300 && response.status < 400 && redirectUrl)) {
    return null;
  }
  const locationState = getLocationState();
  if (locationState) {
    return createRedirectFlightResponse(
      redirectUrl,
      resolveLocationStateEntries(locationState),
    );
  }
  return createSimpleRedirectResponse(redirectUrl);
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
