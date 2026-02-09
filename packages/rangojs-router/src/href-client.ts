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
 * Helper type to get pattern from routes, handling both Record and interface types
 */
type RoutePattern<TRoutes, K extends keyof TRoutes> =
  TRoutes[K] extends string ? TRoutes[K] : string;

/**
 * Strip trailing slash from a path (e.g., "/blog/" -> "/blog" | "/blog/")
 * Allows navigation to include() prefixes without requiring trailing slash
 */
type OptionalTrailingSlash<T extends string> =
  T extends `${infer Base}/` ? (Base extends "" ? T : Base | T) : T;

/**
 * Union of all valid paths from registered routes
 *
 * Generated from RSCRouter.RegisteredRoutes via module augmentation.
 * Allows optional query strings and hash fragments.
 */
export type ValidPaths<TRoutes = GetRegisteredRoutes> =
  keyof TRoutes extends never
    ? `/${string}` // Fallback when no routes are registered
    : WithSuffix<{
        [K in keyof TRoutes]: OptionalTrailingSlash<PatternToPath<RoutePattern<TRoutes, K>>>
      }[keyof TRoutes]>;

/**
 * Type-safe href function for client-side use
 *
 * Without mount: identity function, validates absolute paths at compile time.
 * With mount: prepends mount path, for use with useMount() inside include() scopes.
 *
 * @param path - A valid path matching one of the registered route patterns
 * @param mount - Optional mount prefix from useMount() for include-scoped paths
 * @returns The resolved path
 *
 * @example
 * ```typescript
 * // Absolute paths (type-safe)
 * href("/blog/hello");           // "/blog/hello"
 * href("/shop/product/widget");  // "/shop/product/widget"
 *
 * // With mount (inside an include)
 * const mount = useMount();      // "/articles"
 * href("/", mount);              // "/articles/"
 * href("/my-post", mount);       // "/articles/my-post"
 *
 * // Query strings and hashes pass through
 * href("/blog/hello?page=1");
 * href("/about#contact");
 * ```
 */
export function href<T extends ValidPaths>(path: T, mount?: string): string {
  if (mount && mount !== "/") {
    return mount + path;
  }
  return path;
}

/**
 * Props shape returned by href.json() etc. for spreading on <Link>.
 * Sets data-external to trigger hard navigation (skips RSC fetch).
 */
export interface ResponseHrefProps {
  to: string;
  "data-external": "";
}

type ResponseHrefFn = <T extends ValidPaths>(path: T, mount?: string) => ResponseHrefProps;

function createResponseHrefTag(): ResponseHrefFn {
  return (path, mount) => ({
    to: href(path, mount),
    "data-external": "" as const,
  });
}

export namespace href {
  export const json: ResponseHrefFn = createResponseHrefTag();
  export const text: ResponseHrefFn = createResponseHrefTag();
  export const html: ResponseHrefFn = createResponseHrefTag();
  export const xml: ResponseHrefFn = createResponseHrefTag();
  export const image: ResponseHrefFn = createResponseHrefTag();
  export const stream: ResponseHrefFn = createResponseHrefTag();
  export const any: ResponseHrefFn = createResponseHrefTag();
}
