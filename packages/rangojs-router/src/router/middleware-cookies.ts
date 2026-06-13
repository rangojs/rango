import type { CookieOptions } from "./middleware-types.js";

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
        cookies[name] = raw;
      }
    }
  }

  return cookies;
}

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
