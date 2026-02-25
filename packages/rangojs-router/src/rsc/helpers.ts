/**
 * RSC Handler Helpers
 *
 * Utility functions for RSC request handling.
 */

import { getRequestContext } from "../server/request-context.js";

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
  const ctx = getRequestContext();
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
