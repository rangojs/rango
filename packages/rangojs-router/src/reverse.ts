import type { ExtractParams } from "./types.js";
import type { SearchSchema, ResolveSearchSchema } from "./search-params.js";
import { serializeSearchParams } from "./search-params.js";

/**
 * Sanitize prefix string by removing leading slash
 * "/shop" -> "shop", "blog" -> "blog", "" -> ""
 */
export type SanitizePrefix<T extends string> = T extends `/${infer P}` ? P : T;

/**
 * Helper type to merge multiple route definitions into a single accumulated type.
 * Note: When using createRouter, types accumulate automatically through the
 * builder chain, so this type is typically not needed.
 *
 * @example
 * ```typescript
 * // Manual type merging (rarely needed):
 * type AppRoutes = MergeRoutes<[
 *   typeof homeRoutes,
 *   PrefixRoutePatterns<typeof blogRoutes, "/blog">,
 * ]>;
 *
 * // Preferred: Let router accumulate types automatically
 * const router = createRouter<AppEnv>()
 *   .routes(homeRoutes).map(...)
 *   .routes("/blog", blogRoutes).map(...);
 * type AppRoutes = typeof router.routeMap;
 * ```
 */
export type MergeRoutes<T extends unknown[]> = T extends [
  infer First,
  ...infer Rest,
]
  ? First & MergeRoutes<Rest>
  : {};

/**
 * Add key prefix to all entries in a route map
 * { "cart": "/cart" } with prefix "shop" -> { "shop.cart": "/shop/cart" }
 */
export type PrefixRouteKeys<T, Prefix extends string> = Prefix extends ""
  ? T
  : { [K in keyof T as `${Prefix}.${K & string}`]: T[K] };

/**
 * Add path prefix to all patterns in a route map
 * { "cart": "/cart" } with prefix "/shop" -> { "cart": "/shop/cart" }
 */
export type PrefixRoutePatterns<T, PathPrefix extends string> = {
  [K in keyof T]: PathPrefix extends "" | "/"
    ? T[K]
    : T[K] extends "/"
      ? PathPrefix
      : T[K] extends string
        ? `${PathPrefix}${T[K]}`
        : T[K];
};

/**
 * Combined: prefix both keys and patterns
 * Used for module augmentation registration
 *
 * @example
 * ```typescript
 * // Given shopRoutes = { "index": "/", "cart": "/cart", "products.detail": "/product/:slug" }
 * // PrefixedRoutes<typeof shopRoutes, "shop"> produces:
 * // { "shop.index": "/shop", "shop.cart": "/shop/cart", "shop.products.detail": "/shop/product/:slug" }
 * ```
 */
export type PrefixedRoutes<
  T,
  KeyPrefix extends string,
  PathPrefix extends string = KeyPrefix extends "" ? "" : `/${KeyPrefix}`,
> = PrefixRouteKeys<PrefixRoutePatterns<T, PathPrefix>, KeyPrefix>;

/**
 * Helper to safely extract route patterns from a routes object
 * Handles string values, { path, response } objects, and interface types (like RegisteredRoutes)
 */
type RoutePatternFor<
  TRoutes,
  TName extends keyof TRoutes,
> = TRoutes[TName] extends string
  ? TRoutes[TName]
  : TRoutes[TName] extends { readonly path: infer P extends string }
    ? P
    : string;

/**
 * Extract params type for a route
 */
export type ParamsFor<TRoutes, TName extends keyof TRoutes> = ExtractParams<
  RoutePatternFor<TRoutes, TName>
>;

/**
 * Check if an object type has any keys
 */
type IsEmptyObject<T> = keyof T extends never ? true : false;

/**
 * Extract search schema from a route entry.
 * Returns {} if no search schema is defined.
 */
type ExtractSearchSchema<
  TRoutes,
  TName extends keyof TRoutes,
> = TRoutes[TName] extends { readonly search: infer S extends SearchSchema }
  ? S
  : {};

/**
 * Type-safe reverse function signature (Django-style URL reversal)
 *
 * Validates route names and params at compile time.
 * Use route names instead of raw paths for full type safety.
 *
 * @example
 * ```typescript
 * reverse("cart")                           // ✓ Validates route exists
 * reverse("product.detail", { id: "123" })  // ✓ Validates route + params
 * ```
 */
export type ReverseFunction<TRoutes> = {
  /**
   * Route without params - validates route name exists
   */
  <TName extends keyof TRoutes & string>(
    name: IsEmptyObject<
      ExtractParams<RoutePatternFor<TRoutes, TName>>
    > extends true
      ? TName
      : never,
  ): string;

  /**
   * Route with params - validates both route name and params
   */
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
  ): string;

  /**
   * Route with params and search - validates route name, params, and search
   */
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TRoutes, TName>>,
  ): string;

  /**
   * Dot-prefixed route without params - strictly local resolution
   */
  <TName extends keyof TRoutes & string>(
    name: IsEmptyObject<
      ExtractParams<RoutePatternFor<TRoutes, TName>>
    > extends true
      ? `.${TName}`
      : never,
  ): string;

  /**
   * Dot-prefixed route with params - strictly local resolution
   */
  <TName extends keyof TRoutes & string>(
    name: `.${TName}`,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
  ): string;

  /**
   * Dot-prefixed route with params and search - strictly local resolution
   */
  <TName extends keyof TRoutes & string>(
    name: `.${TName}`,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TRoutes, TName>>,
  ): string;
};

/**
 * Type-safe scoped reverse function with separate local and global namespaces.
 *
 * - `.name` — local resolution within the current include() scope
 * - `name` — global resolution against the named-routes definition
 *
 * @example
 * ```typescript
 * reverse(".article", { slug: "hello" })     // ✓ Local route (resolves with mount prefix)
 * reverse(".index")                           // ✓ Local route (no params)
 * reverse("magazine.index")                   // ✓ Global route (fully qualified)
 * reverse("blog.post", { slug: "hello" })     // ✓ Global route + params
 * reverse(".typo")                            // ✗ Compile error (not in local routes)
 * reverse("typo")                             // ✗ Compile error (not in global routes)
 * ```
 */
export type ScopedReverseFunction<
  TLocalRoutes,
  TGlobalRoutes = TLocalRoutes,
> = {
  /**
   * Global route without params
   */
  <TName extends keyof TGlobalRoutes & string>(
    name: IsEmptyObject<
      ExtractParams<RoutePatternFor<TGlobalRoutes, TName>>
    > extends true
      ? TName
      : never,
  ): string;

  /**
   * Global route with params
   */
  <TName extends keyof TGlobalRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TGlobalRoutes, TName>>,
  ): string;

  /**
   * Global route with params and search
   */
  <TName extends keyof TGlobalRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TGlobalRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TGlobalRoutes, TName>>,
  ): string;

  /**
   * Dot-prefixed local route without params
   */
  <TName extends keyof TLocalRoutes & string>(
    name: IsEmptyObject<
      ExtractParams<RoutePatternFor<TLocalRoutes, TName>>
    > extends true
      ? `.${TName}`
      : never,
  ): string;

  /**
   * Dot-prefixed local route with params
   */
  <TName extends keyof TLocalRoutes & string>(
    name: `.${TName}`,
    params: ExtractParams<RoutePatternFor<TLocalRoutes, TName>>,
  ): string;

  /**
   * Dot-prefixed local route with params and search
   */
  <TName extends keyof TLocalRoutes & string>(
    name: `.${TName}`,
    params: ExtractParams<RoutePatternFor<TLocalRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TLocalRoutes, TName>>,
  ): string;
};

/**
 * Extract local routes type from UrlPatterns
 * Used with scopedReverse() to get the routes type from patterns
 */
export type ExtractLocalRoutes<TPatterns> = TPatterns extends {
  readonly _routes?: infer TRoutes;
}
  ? TRoutes
  : TPatterns extends Record<string, string>
    ? TPatterns
    : Record<string, string>;

/**
 * Extract the response data type for a named route from a UrlPatterns instance.
 * Re-exported from urls.ts for consumer convenience.
 */
export type { RouteResponse } from "./urls.js";

/**
 * Get a locally-typed reverse function from ctx.reverse for composable modules.
 *
 * This is a type-only cast - ctx.reverse already resolves names at runtime.
 * Provides type safety: `.name` validates against local routes,
 * `name` validates against global named-routes.
 *
 * @param reverse - The ctx.reverse function from HandlerContext
 * @returns The same reverse function, typed with local + global routes
 *
 * @example
 * ```typescript
 * // urls/blog.tsx
 * export const blogPatterns = urls(({ path }) => [
 *   path("/", (ctx) => {
 *     const reverse = scopedReverse<typeof blogPatterns>(ctx.reverse);
 *
 *     reverse(".index");              // ✓ Local route
 *     reverse(".post", { slug: "x" }); // ✓ Local with params
 *     reverse("shop.cart");           // ✓ Global route
 *
 *     return <BlogIndex />;
 *   }, { name: "index" }),
 *
 *   path("/:slug", BlogPost, { name: "post" }),
 * ]);
 * ```
 */
export function scopedReverse<TPatterns>(
  reverse: (...args: any[]) => string,
): ScopedReverseFunction<ExtractLocalRoutes<TPatterns>> {
  return reverse as ScopedReverseFunction<ExtractLocalRoutes<TPatterns>>;
}

/**
 * Create a type-safe reverse function for URL generation
 *
 * @param routeMap - Flattened route map with all registered routes
 * @returns Type-safe reverse function
 *
 * @example
 * ```typescript
 * // Given routes: { cart: "/shop/cart", detail: "/shop/product/:slug" }
 * const reverse = createReverse(routeMap);
 * reverse("cart"); // "/shop/cart"
 * reverse("detail", { slug: "my-product" }); // "/shop/product/my-product"
 * ```
 */
type RouteMapEntry = string | { path: string; search?: Record<string, string> };

function resolveRoutePattern(
  entry: RouteMapEntry | undefined,
): string | undefined {
  if (!entry) return undefined;
  return typeof entry === "string" ? entry : entry.path;
}

export function createReverse<TRoutes extends Record<string, string>>(
  routeMap: TRoutes,
): ReverseFunction<TRoutes & Record<string, string>> {
  return ((
    name: string,
    params?: Record<string, string>,
    search?: Record<string, unknown>,
  ) => {
    const pattern = resolveRoutePattern(
      routeMap[name] as unknown as RouteMapEntry,
    );
    if (!pattern) {
      // During build-time discovery, lazy includes haven't resolved yet.
      // Return a placeholder instead of crashing the build.
      if ((globalThis as any).__rscRouterDiscoveryActive) {
        return `/__unresolved_reverse/${name}`;
      }
      throw new Error(`Unknown route: ${name}`);
    }

    let result = pattern;
    if (params) {
      // Replace :param placeholders with actual values
      result = result.replace(/:([^/]+)/g, (_: string, key: string) => {
        const value = params[key];
        if (value === undefined) {
          throw new Error(`Missing param "${key}" for route "${name}"`);
        }
        return encodeURIComponent(value);
      });
    }

    // Append search params as query string
    if (search) {
      const qs = serializeSearchParams(search);
      if (qs) {
        result += `?${qs}`;
      }
    }

    return result;
  }) as ReverseFunction<TRoutes>;
}
