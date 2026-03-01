/**
 * Cookie Merge Utility
 *
 * Merges Set-Cookie response headers into a request Cookie header.
 * Used by inline action redirects to make cookies set during the action
 * visible to loaders on the redirect target.
 */

import { parseCookies } from "../router/middleware-cookies.js";

/**
 * Parse a single Set-Cookie header value to extract the cookie name and value.
 * Returns null for deletion cookies (Max-Age=0 or Expires in the past).
 */
function parseSetCookie(
  setCookieValue: string,
): { name: string; value: string; deleted: boolean } | null {
  const parts = setCookieValue.split(";");
  const nameValue = parts[0]?.trim();
  if (!nameValue) return null;

  const eqIndex = nameValue.indexOf("=");
  if (eqIndex === -1) return null;

  const name = decodeURIComponent(nameValue.slice(0, eqIndex).trim());
  const value = decodeURIComponent(nameValue.slice(eqIndex + 1).trim());

  // Check if this is a deletion cookie
  const lowerParts = parts.slice(1).map((p) => p.trim().toLowerCase());
  const deleted = lowerParts.some((p) => p === "max-age=0");

  return { name, value, deleted };
}

/**
 * Merge Set-Cookie headers from a response into a request's Cookie header.
 *
 * - New/updated cookies are added or overwritten
 * - Deleted cookies (Max-Age=0) are removed
 *
 * Returns the merged Cookie header string.
 */
export function mergeCookiesForInlineRedirect(
  requestCookieHeader: string | null,
  responseCookies: string[],
): string {
  const cookies = parseCookies(requestCookieHeader);

  for (const setCookieValue of responseCookies) {
    const parsed = parseSetCookie(setCookieValue);
    if (!parsed) continue;

    if (parsed.deleted) {
      delete cookies[parsed.name];
    } else {
      cookies[parsed.name] = parsed.value;
    }
  }

  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
