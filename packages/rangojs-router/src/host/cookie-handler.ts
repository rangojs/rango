/**
 * Cookie Override Handler
 *
 * Manages cookie-based host override for development environments.
 */

import type { HostOverrideConfig } from "./types.js";
import { matchPattern, parseRequest } from "./pattern-matcher.js";
import {
  HostOverrideNotAllowedError,
  InvalidHostnameError,
  HostValidationError,
} from "./errors.js";

/**
 * Parse cookies from request
 */
export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(";");

  for (const pair of pairs) {
    const [key, value] = pair.trim().split("=");
    if (key && value) {
      cookies[key] = decodeURIComponent(value);
    }
  }

  return cookies;
}

/**
 * Get cookie value from request
 */
export function getCookie(request: Request, name: string): string | undefined {
  const cookies = parseCookies(request);
  return cookies[name];
}

/**
 * Create Set-Cookie header to delete a cookie
 */
export function createDeleteCookieHeader(name: string): string {
  return `${name}=; Max-Age=0; Path=/; Secure; HttpOnly`;
}

/**
 * Create error response with cookie deletion
 */
export function createCookieErrorResponse(
  cookieName: string,
  message: string,
): Response {
  return new Response(
    JSON.stringify({
      error: message,
      message: `The ${cookieName} cookie has been cleared`,
    }),
    {
      status: 400,
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": createDeleteCookieHeader(cookieName),
      },
    },
  );
}

/**
 * Check if current host is allowed to use override
 */
export function isHostAllowed(
  request: Request,
  allowedHosts: string[],
): boolean {
  const { hostname, pathname, parts } = parseRequest(request);

  for (const pattern of allowedHosts) {
    if (matchPattern(pattern, hostname, pathname, parts)) {
      return true;
    }
  }

  return false;
}

/**
 * Handle cookie override logic
 *
 * Returns overridden hostname if valid, original hostname if no override.
 * Throws errors for invalid overrides.
 */
export function handleCookieOverride(
  request: Request,
  config: HostOverrideConfig | undefined,
  context: any,
): string {
  if (!config) {
    const { hostname } = parseRequest(request);
    return hostname;
  }

  const { cookieName, allowedHosts, validate } = config;
  const cookieValue = getCookie(request, cookieName);
  const { hostname: originalHostname } = parseRequest(request);

  // No cookie - return original hostname
  if (!cookieValue) {
    return originalHostname;
  }

  // Check if current host is allowed
  const allowed = isHostAllowed(request, allowedHosts);

  // If not allowed, throw error
  if (!allowed) {
    throw new HostOverrideNotAllowedError(originalHostname, cookieName, {
      cause: { cookieValue, currentHost: originalHostname },
    });
  }

  // If allowed and has custom validation, run it
  if (validate) {
    try {
      const validatedHostname = validate(request, cookieValue, context);
      return validatedHostname;
    } catch (error) {
      // Wrap in HostValidationError
      const message = error instanceof Error ? error.message : String(error);
      throw new HostValidationError(message, error);
    }
  }

  // Default validation - verify it's a valid hostname using URL constructor
  try {
    // Try to construct a URL with the hostname to validate it
    const testUrl = new URL(`https://${cookieValue}`);

    // Ensure the hostname matches what we provided (URL constructor normalizes it)
    if (testUrl.hostname !== cookieValue) {
      throw new InvalidHostnameError(cookieValue, {
        cause: { original: cookieValue, normalized: testUrl.hostname },
      });
    }
  } catch (error) {
    // If URL constructor failed, throw InvalidHostnameError with cause
    if (error instanceof InvalidHostnameError) {
      throw error;
    }
    throw new InvalidHostnameError(cookieValue, { cause: error });
  }

  return cookieValue;
}
