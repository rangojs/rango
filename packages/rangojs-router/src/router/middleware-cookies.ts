/**
 * Cookie Utilities
 *
 * Parsing and serialization for HTTP cookies used by middleware context.
 */

import type { CookieOptions } from "./middleware-types.js";

/**
 * Parse cookies from Cookie header
 */
export function parseCookies(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [name, ...rest] = pair.trim().split("=");
    if (name) {
      const raw = rest.join("=");
      try {
        cookies[name] = decodeURIComponent(raw);
      } catch {
        // Malformed percent-encoded value (e.g. %zz) - fall back to raw value
        cookies[name] = raw;
      }
    }
  }

  return cookies;
}

/**
 * Serialize a cookie for Set-Cookie header
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (options.domain) cookie += `; Domain=${options.domain}`;
  if (options.path) cookie += `; Path=${options.path}`;
  if (options.maxAge !== undefined) cookie += `; Max-Age=${options.maxAge}`;
  if (options.expires) cookie += `; Expires=${options.expires.toUTCString()}`;
  if (options.httpOnly) cookie += "; HttpOnly";
  if (options.secure) cookie += "; Secure";
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;

  return cookie;
}
