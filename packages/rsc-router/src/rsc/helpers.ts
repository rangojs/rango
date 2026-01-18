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
 */
export function createResponseWithMergedHeaders(
  body: BodyInit | null,
  init: ResponseInit
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

  return new Response(body, {
    ...init,
    headers: mergedHeaders,
  });
}
