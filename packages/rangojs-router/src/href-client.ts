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
import type { ResponseEnvelope } from "./urls.js";

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
    ?
        | PatternToPath<`${Before}${After}`>
        | `${Before}${ParseConstraintPath<Constraint>}/${PatternToPath<After>}`
    : // Optional + constrained param at end: /path/:param(a|b)?
      T extends `${infer Before}:${infer _Name}(${infer Constraint})?`
      ? Before | `${Before}${ParseConstraintPath<Constraint>}`
      : // Constrained param in middle: /:param(a|b)/rest
        T extends `${infer Before}:${infer _Name}(${infer Constraint})/${infer After}`
        ? `${Before}${ParseConstraintPath<Constraint>}/${PatternToPath<After>}`
        : // Constrained param at end: /path/:param(a|b)
          T extends `${infer Before}:${infer _Name}(${infer Constraint})`
          ? `${Before}${ParseConstraintPath<Constraint>}`
          : // Optional param in middle: /:param?/rest
            T extends `${infer Before}:${infer _Param}?/${infer After}`
            ?
                | PatternToPath<`${Before}${After}`>
                | `${Before}${string}/${PatternToPath<After>}`
            : // Optional param at end: /path/:param?
              T extends `${infer Before}:${infer _Param}?`
              ? Before | `${Before}${string}`
              : // Required param in middle: /:param/rest
                T extends `${infer Before}:${infer _Param}/${infer After}`
                ? `${Before}${string}/${PatternToPath<After>}`
                : // Required param at end: /path/:param
                  T extends `${infer Before}:${infer _Param}`
                  ? `${Before}${string}`
                  : // Static path
                    T;

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
 * Helper type to get pattern from routes, handling string values and { path, response } objects
 */
type RoutePattern<TRoutes, K extends keyof TRoutes> = TRoutes[K] extends string
  ? TRoutes[K]
  : TRoutes[K] extends { readonly path: infer P extends string }
    ? P
    : string;

/**
 * Reverse lookup: find route name where the pattern matches TPattern
 */
type NameForPattern<TPattern extends string, TRoutes = GetRegisteredRoutes> = {
  [K in keyof TRoutes]: RoutePattern<TRoutes, K> extends TPattern ? K : never;
}[keyof TRoutes];

/**
 * Look up the response data type for a route pattern from RegisteredRoutes.
 *
 * Works by reverse-looking up the route name for the given pattern,
 * then extracting the response type from the route entry.
 *
 * For static routes (no params), pattern === path:
 *   PathResponse<"/api/health"> → { status: string; timestamp: number }
 *
 * For dynamic routes, use the pattern:
 *   PathResponse<"/api/products/:id"> → Product
 */
export type PathResponse<
  TPattern extends string,
  TRoutes = GetRegisteredRoutes,
> = ResponseEnvelope<
  {
    [K in keyof TRoutes]: RoutePattern<TRoutes, K> extends TPattern
      ? TRoutes[K] extends { readonly response: infer R }
        ? Exclude<R, Response>
        : never
      : never;
  }[keyof TRoutes]
>;

/**
 * Strip trailing slash from a path (e.g., "/blog/" -> "/blog" | "/blog/")
 * Allows navigation to include() prefixes without requiring trailing slash
 */
type OptionalTrailingSlash<T extends string> = T extends `${infer Base}/`
  ? Base extends ""
    ? T
    : Base | T
  : T;

/**
 * Union of all valid paths from registered routes
 *
 * Generated from RSCRouter.RegisteredRoutes via module augmentation.
 * Allows optional query strings and hash fragments.
 */
export type ValidPaths<TRoutes = GetRegisteredRoutes> =
  keyof TRoutes extends never
    ? `/${string}` // Fallback when no routes are registered
    : WithSuffix<
        {
          [K in keyof TRoutes]: OptionalTrailingSlash<
            PatternToPath<RoutePattern<TRoutes, K>>
          >;
        }[keyof TRoutes]
      >;

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
    // Strip trailing slash from mount to avoid double-slash when joining
    const normalizedMount = mount.endsWith("/") ? mount.slice(0, -1) : mount;
    return normalizedMount + path;
  }
  // ValidPaths is built from template literals so T does extend string at
  // runtime, but the inference can fail past a certain route-union complexity
  // and TypeScript reports T as not assignable to string.
  return path as string;
}

/**
 * Props shape returned by href.json() etc. for spreading on <Link>.
 * Sets data-external to trigger hard navigation (skips RSC fetch).
 */
export interface ResponseHrefProps {
  to: string;
  "data-external": "";
}

type ResponseHrefFn = <T extends ValidPaths>(
  path: T,
  mount?: string,
) => ResponseHrefProps;

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
  export const md: ResponseHrefFn = createResponseHrefTag();
  export const image: ResponseHrefFn = createResponseHrefTag();
  export const stream: ResponseHrefFn = createResponseHrefTag();
  export const any: ResponseHrefFn = createResponseHrefTag();
}
