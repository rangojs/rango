import type { RouteMap, RouteDefinition } from "./types";

/**
 * Extract all possible route patterns from a RouteMap
 * Converts nested structure to flat union of path strings
 *
 * @example
 * const routes = { home: "/", items: { detail: "/items/:id" } }
 * type Paths = ExtractRoutePaths<typeof routes>
 * // Result: "/" | "/items/:id"
 */
export type ExtractRoutePaths<T> = T extends string
  ? T
  : T extends RouteDefinition
  ? T["pattern"]
  : T extends RouteMap
  ? { [K in keyof T]: ExtractRoutePaths<T[K]> }[keyof T]
  : never;

/**
 * Build a path from a pattern and params
 * Replaces :param placeholders with actual values
 *
 * @example
 * buildPath("/items/:id", { id: "123" })
 * // Result: "/items/123"
 *
 * buildPath("/users/:userId/posts/:postId", { userId: "1", postId: "2" })
 * // Result: "/users/1/posts/2"
 */
export function buildPath(pattern: string, params?: Record<string, string>): string {
  if (!params) return pattern;

  let path = pattern;

  // Replace each :param with the corresponding value
  for (const [key, value] of Object.entries(params)) {
    const paramPattern = new RegExp(`:${key}(?=/|$)`, 'g');
    path = path.replace(paramPattern, encodeURIComponent(value));
  }

  // Check for any remaining unreplaced params
  const remainingParams = path.match(/:([^/]+)/g);
  if (remainingParams) {
    const missingParams = remainingParams.map(p => p.slice(1)).join(', ');
    throw new Error(`Missing required route params: ${missingParams}`);
  }

  return path;
}

/**
 * Join path segments, handling leading/trailing slashes
 *
 * @example
 * joinPaths("/base", "path")
 * // Result: "/base/path"
 *
 * joinPaths("/base/", "/path/")
 * // Result: "/base/path"
 */
export function joinPaths(...segments: string[]): string {
  return segments
    .map(s => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
    .replace(/^/, '/');
}
