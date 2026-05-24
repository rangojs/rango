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
import type { JsonSerialize } from "./serialize.js";
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
 * Strip a query (`?…`) and/or hash (`#…`) suffix before matching, so a concrete
 * URL like `/api/health?ts=1` still resolves to its route's response. Removes
 * from the earliest of `?`/`#`: a `#` before the first `?` (the query is part of
 * a fragment, e.g. `/health#top?x=1`) is handled, as is a `/:` that only appears
 * inside the query (e.g. `/health?next=/:id`).
 */
type StripPathSuffix<T extends string> = T extends `${infer Base}?${string}`
  ? Base extends `${infer Frag}#${string}`
    ? Frag
    : Base
  : T extends `${infer Base}#${string}`
    ? Base
    : T;

/** Extract a route entry's response payload (or `never` for RSC routes). */
type ResponsePayloadOf<TRoutes, K extends keyof TRoutes> = TRoutes[K] extends {
  readonly response: infer R;
}
  ? Exclude<R, Response>
  : never;

/**
 * Look up the response payload for a route, keyed by either a route pattern
 * (`/api/products/:id`) or a concrete path (`/api/products/123`). The same type
 * serves a pattern lookup and a typed `fetch` wrapper that forwards a concrete
 * `Rango.Path`:
 *
 *   PathResponse<"/api/products/:id"> → Product   // by pattern
 *   PathResponse<"/api/products/123"> → Product   // by concrete path
 *
 * The query/hash suffix is stripped first; the stripped key is then treated as a
 * pattern when it contains a `/:param` segment and matched exactly (precise even
 * for nested dynamic routes), otherwise as a concrete path matched against each
 * route's `PatternToPath` template. Because those holes are `${string}`
 * (slash-greedy), a concrete path under a *nested* dynamic route can match several
 * patterns and union their responses — pattern lookups do not have this
 * looseness. RSC routes (no response) and unmatched keys resolve to `never`.
 */
type ResponsePayloadFor<
  TPath extends string,
  TRoutes = GetRegisteredRoutes,
> = ResponsePayloadForKey<StripPathSuffix<TPath>, TRoutes>;

type ResponsePayloadForKey<
  TKey extends string,
  TRoutes,
> = TKey extends `${string}/:${string}`
  ? {
      [K in keyof TRoutes]: RoutePattern<TRoutes, K> extends TKey
        ? ResponsePayloadOf<TRoutes, K>
        : never;
    }[keyof TRoutes]
  : {
      [K in keyof TRoutes]: TKey extends PatternToPath<RoutePattern<TRoutes, K>>
        ? ResponsePayloadOf<TRoutes, K>
        : never;
    }[keyof TRoutes];

/**
 * Public response type for a route, keyed by pattern or concrete path. The
 * payload is wrapped in `JsonSerialize` so it describes the JSON **wire** value a
 * consumer receives from `fetch().then(r => r.json())`, not the handler's raw
 * return type — e.g. a handler returning `{ createdAt: Date }` resolves here to
 * `ResponseEnvelope<{ createdAt: string }>`.
 */
export type PathResponse<
  TPath extends string,
  TRoutes = GetRegisteredRoutes,
> = ResponseEnvelope<JsonSerialize<ResponsePayloadFor<TPath, TRoutes>>>;

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
 * Generated from Rango.RegisteredRoutes via module augmentation.
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

// Module-scoped alias so the ambient `Rango.PathResponse` below can reference
// the module-level `PathResponse` without the global namespace shadowing the
// name when both are called `PathResponse`.
type GlobalPathResponse<
  TPattern extends string,
  TRoutes = GetRegisteredRoutes,
> = PathResponse<TPattern, TRoutes>;

/**
 * Ambient path types on the `Rango` namespace.
 *
 * These live on the same global namespace consumers already augment for
 * `Rango.Env` / `Rango.Vars`, so they are reachable with no import wherever the
 * router's types are in scope. They are the public, recommended surface for
 * typing anything that wraps `href()`. `ValidPaths` / `PathResponse` stay as the
 * internal building blocks behind them.
 */
declare global {
  namespace Rango {
    /**
     * Union of every valid route path accepted by `href()`.
     *
     * Type a wrapper's path parameter as `Rango.Path` so it shares `href()`'s
     * compile-time validation against the registered routes:
     *
     * ```ts
     * import { href } from "@rangojs/router/client";
     *
     * export const appHref = (path: Rango.Path) => href(path);
     * ```
     *
     * Resolves from `Rango.RegisteredRoutes` when augmented, otherwise the
     * auto-generated `Rango.GeneratedRouteMap`, otherwise a permissive
     * `/${string}` fallback.
     */
    type Path<TRoutes = GetRegisteredRoutes> = ValidPaths<TRoutes>;

    /**
     * Response payload for a route, looked up from the global route map by
     * either a route pattern (`/api/products/:id`) or a concrete path
     * (`/api/products/123`). Because it accepts a concrete `Rango.Path`, it
     * doubles as the return type of a typed `fetch` wrapper:
     *
     * ```ts
     * type Product = Rango.PathResponse<"/api/products/:id">; // by pattern
     * type Same = Rango.PathResponse<"/api/products/42">;     // by concrete path
     *
     * const get = async <T extends Rango.Path>(
     *   path: T,
     * ): Promise<Rango.PathResponse<T>> =>
     *   fetch(href(path)).then((r) => r.json());
     * ```
     *
     * The payload is the JSON **wire** shape (via `Rango.JsonSerialize`), not the
     * handler's raw return — a handler returning `{ createdAt: Date }` resolves
     * here to `ResponseEnvelope<{ createdAt: string }>`, matching what
     * `fetch().then(r => r.json())` actually yields.
     *
     * Only resolves once `Rango.RegisteredRoutes` carries response metadata (the
     * generated map has paths and search but no payloads). Pass an explicit route
     * map as the second argument to look up against a non-global map (rarely
     * needed in app code).
     */
    type PathResponse<
      TPath extends string,
      TRoutes = GetRegisteredRoutes,
    > = GlobalPathResponse<TPath, TRoutes>;
  }
}

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
