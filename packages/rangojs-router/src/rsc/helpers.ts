/**
 * RSC Handler Helpers
 *
 * Utility functions for RSC request handling.
 */

import { _getRequestContext } from "../server/request-context.js";

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
