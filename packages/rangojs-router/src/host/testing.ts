/**
 * Testing Utilities for Host Router
 *
 * Helper functions for testing host routing.
 */

import { matchPattern, parseRequest } from "./pattern-matcher.js";

export interface CreateTestRequestOptions {
  host: string;
  path?: string;
  method?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}

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

function matchPatterns(
  pattern: string | string[],
  hostname: string,
  pathname: string,
  parts: string[],
): boolean {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  return patterns.some((p) => matchPattern(p, hostname, pathname, parts));
}

/**
 * Test if a pattern matches a hostname (and, for path-based patterns, a pathname).
 *
 * `pathname` defaults to `"/"`, so a host-only pattern works with two args. Pass
 * the third arg to test a path-based pattern (`**.workers.dev/admin`,
 * `localhost/shop`) — without it those patterns can never match.
 *
 * @example
 * ```ts
 * expect(testPattern("admin.*", "admin.example.com")).toBe(true);
 * expect(testPattern(["*", "www.*"], "example.com")).toBe(true);
 * expect(testPattern("**.workers.dev/admin", "foo.workers.dev", "/admin")).toBe(true);
 * ```
 */
export function testPattern(
  pattern: string | string[],
  hostname: string,
  pathname: string = "/",
): boolean {
  return matchPatterns(pattern, hostname, pathname, hostname.split("."));
}

/**
 * Test if a pattern matches a `Request` — the hostname AND pathname are taken
 * from the request URL (via the same `parseRequest` the host router uses), so a
 * path-based pattern is tested against a real request without splitting the URL
 * by hand.
 *
 * @example
 * ```ts
 * const req = new Request("https://foo.workers.dev/admin");
 * expect(matchesHost("**.workers.dev/admin", req)).toBe(true);
 * ```
 */
export function matchesHost(
  pattern: string | string[],
  request: Request,
): boolean {
  const { hostname, pathname, parts } = parseRequest(request);
  return matchPatterns(pattern, hostname, pathname, parts);
}
