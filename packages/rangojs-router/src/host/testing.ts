/**
 * Testing Utilities for Host Router
 *
 * Helper functions for testing host routing.
 */

import { matchPattern } from "./pattern-matcher.js";

export interface CreateTestRequestOptions {
  host: string;
  path?: string;
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}

/**
 * Create a test request with specific host and cookies
 *
 * @example
 * ```ts
 * const request = createTestRequest({
 *   host: 'admin.example.com',
 *   path: '/dashboard',
 *   cookies: { 'x-requested-host': 'api.example.com' }
 * });
 * ```
 */
export function createTestRequest(options: CreateTestRequestOptions): Request {
  const {
    host,
    path = "/",
    method = "GET",
    cookies = {},
    headers = {},
  } = options;

  const url = `http://${host}${path}`;
  const requestHeaders = new Headers(headers);

  // Add cookies if provided
  if (Object.keys(cookies).length > 0) {
    const cookieString = Object.entries(cookies)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("; ");
    requestHeaders.set("cookie", cookieString);
  }

  return new Request(url, {
    method,
    headers: requestHeaders,
  });
}

/**
 * Test if a pattern matches a hostname
 *
 * @example
 * ```ts
 * expect(testPattern('admin.*', 'admin.example.com')).toBe(true);
 * expect(testPattern(['*', 'www.*'], 'example.com')).toBe(true);
 * ```
 */
export function testPattern(
  pattern: string | string[],
  hostname: string,
): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const parts = hostname.split(".");
  const pathname = "/";

  for (const p of patterns) {
    if (matchPattern(p, hostname, pathname, parts)) {
      return true;
    }
  }

  return false;
}
