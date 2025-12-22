/**
 * Client-safe type-safe href function
 *
 * This is a compile-time only href that validates paths against registered routes.
 * No runtime route map lookup - just an identity function with TypeScript validation.
 *
 * @example
 * ```typescript
 * import { href } from "rsc-router/client";
 *
 * href("/blog/my-post");           // ✓ matches /blog/:slug
 * href("/shop/product/widget");    // ✓ matches /shop/product/:slug
 * href("/invalid");                // ✗ TypeScript error
 * ```
 */

import type { GetRegisteredRoutes } from "./types.js";

/**
 * Parse constraint values into a union type for paths
 * "a|b|c" → "a" | "b" | "c"
 */
type ParseConstraintPath<T extends string> =
  T extends `${infer First}|${infer Rest}`
    ? First | ParseConstraintPath<Rest>
    : T;

/**
 * Convert a route pattern to a template literal type
 *
 * Supports:
 * - Static: /about → "/about"
 * - Dynamic: /blog/:slug → `/blog/${string}`
 * - Optional: /:locale?/blog → "/blog" | `/${string}/blog`
 * - Constrained: /:locale(en|gb)/blog → "/en/blog" | "/gb/blog"
 * - Optional + Constrained: /:locale(en|gb)?/blog → "/blog" | "/en/blog" | "/gb/blog"
 *
 * @example
 * PatternToPath<"/blog/:slug"> = `/blog/${string}`
 * PatternToPath<"/:locale?/blog"> = "/blog" | `/${string}/blog`
 * PatternToPath<"/:locale(en|gb)/blog"> = "/en/blog" | "/gb/blog"
 * PatternToPath<"/:locale(en|gb)?/blog"> = "/blog" | "/en/blog" | "/gb/blog"
 */
export type PatternToPath<T extends string> =
  // Optional + constrained param in middle: /:param(a|b)?/rest
  T extends `${infer Before}:${infer _Name}(${infer Constraint})?/${infer After}`
    ? PatternToPath<`${Before}${After}`> | `${Before}${ParseConstraintPath<Constraint>}/${PatternToPath<After>}`
  // Optional + constrained param at end: /path/:param(a|b)?
  : T extends `${infer Before}:${infer _Name}(${infer Constraint})?`
    ? Before | `${Before}${ParseConstraintPath<Constraint>}`
  // Constrained param in middle: /:param(a|b)/rest
  : T extends `${infer Before}:${infer _Name}(${infer Constraint})/${infer After}`
    ? `${Before}${ParseConstraintPath<Constraint>}/${PatternToPath<After>}`
  // Constrained param at end: /path/:param(a|b)
  : T extends `${infer Before}:${infer _Name}(${infer Constraint})`
    ? `${Before}${ParseConstraintPath<Constraint>}`
  // Optional param in middle: /:param?/rest
  : T extends `${infer Before}:${infer _Param}?/${infer After}`
    ? PatternToPath<`${Before}${After}`> | `${Before}${string}/${PatternToPath<After>}`
  // Optional param at end: /path/:param?
  : T extends `${infer Before}:${infer _Param}?`
    ? Before | `${Before}${string}`
  // Required param in middle: /:param/rest
  : T extends `${infer Before}:${infer _Param}/${infer After}`
    ? `${Before}${string}/${PatternToPath<After>}`
  // Required param at end: /path/:param
  : T extends `${infer Before}:${infer _Param}`
    ? `${Before}${string}`
  // Static path
  : T;

/**
 * Allow optional query string (?...) and/or hash fragment (#...) suffix
 *
 * @example
 * WithSuffix<"/about"> = "/about" | "/about?..." | "/about#..." | "/about?...#..."
 */
type WithSuffix<T extends string> =
  | T
  | `${T}?${string}`
  | `${T}#${string}`
  | `${T}?${string}#${string}`;

/**
 * Union of all valid paths from registered routes
 *
 * Generated from RSCRouter.RegisteredRoutes via module augmentation.
 * Allows optional query strings and hash fragments.
 */
export type ValidPaths<TRoutes extends Record<string, string> = GetRegisteredRoutes> =
  WithSuffix<PatternToPath<TRoutes[keyof TRoutes]>>;

/**
 * Type-safe href function for client-side use
 *
 * This is an identity function - it returns the path unchanged.
 * The value is in TypeScript validation: invalid paths cause compile errors.
 *
 * Works with:
 * - Static paths: href("/about")
 * - Dynamic segments: href("/blog/my-post")
 * - Multiple segments: href("/shop/product/widget/reviews/123")
 *
 * Does NOT validate:
 * - Query strings (passed through as-is)
 * - Hash fragments (passed through as-is)
 *
 * @param path - A valid path matching one of the registered route patterns
 * @returns The path unchanged
 *
 * @example
 * ```typescript
 * // Valid paths (compile)
 * href("/blog/hello");                    // matches /blog/:slug
 * href("/shop/product/widget");           // matches /shop/product/:slug
 * href("/shop/product/widget/reviews");   // matches /shop/product/:slug/reviews
 *
 * // Query strings and hashes pass through (not validated)
 * href("/blog/hello?page=1");
 * href("/about#contact");
 *
 * // Invalid paths (TypeScript error)
 * href("/nonexistent");  // Error: not assignable to ValidPaths
 * ```
 */
export function href<T extends ValidPaths>(path: T): T {
  return path;
}
