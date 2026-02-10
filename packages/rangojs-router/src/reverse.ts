import type { ExtractParams } from "./types.js";

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
  ...infer Rest
]
  ? First & MergeRoutes<Rest>
  : {};

/**
 * Add key prefix to all entries in a route map
 * { "cart": "/cart" } with prefix "shop" -> { "shop.cart": "/shop/cart" }
 */
export type PrefixRouteKeys<
  T,
  Prefix extends string
> = Prefix extends ""
  ? T
  : { [K in keyof T as `${Prefix}.${K & string}`]: T[K] };

/**
 * Add path prefix to all patterns in a route map
 * { "cart": "/cart" } with prefix "/shop" -> { "cart": "/shop/cart" }
 */
export type PrefixRoutePatterns<
  T,
  PathPrefix extends string
> = {
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
  PathPrefix extends string = KeyPrefix extends "" ? "" : `/${KeyPrefix}`
> = PrefixRouteKeys<PrefixRoutePatterns<T, PathPrefix>, KeyPrefix>;

/**
 * Helper to safely extract route patterns from a routes object
 * Handles string values, { path, response } objects, and interface types (like RegisteredRoutes)
 */
type RoutePatternFor<TRoutes, TName extends keyof TRoutes> =
  TRoutes[TName] extends string ? TRoutes[TName]
  : TRoutes[TName] extends { readonly path: infer P extends string } ? P
  : string;

/**
 * Extract params type for a route
 */
export type ParamsFor<
  TRoutes,
  TName extends keyof TRoutes
> = ExtractParams<RoutePatternFor<TRoutes, TName>>;

/**
 * Check if an object type has any keys
 */
type IsEmptyObject<T> = keyof T extends never ? true : false;

/**
 * Type-safe href function signature
 *
 * Validates route names and params at compile time.
 * Use route names instead of raw paths for full type safety.
 *
 * @example
 * ```typescript
 * href("cart")                           // ✓ Validates route exists
 * href("product.detail", { id: "123" })  // ✓ Validates route + params
 * ```
 */
export type HrefFunction<TRoutes> = {
  /**
   * Route without params - validates route name exists
   */
  <TName extends keyof TRoutes & string>(
    name: IsEmptyObject<ExtractParams<RoutePatternFor<TRoutes, TName>>> extends true ? TName : never
  ): string;

  /**
   * Route with params - validates both route name and params
   */
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>
  ): string;
};

/**
 * Type-safe scoped href function signature for use with scopedHref<typeof patterns>()
 *
 * **Recommended: Use route names for type safety.**
 * Route names validate both the route exists and params are correct.
 * Path-based URLs (`/...`) are an escape hatch with no validation.
 *
 * @example
 * ```typescript
 * // RECOMMENDED: Use route names for type safety
 * href("blog.post", { slug: "hello" })  // ✓ Validates route + params
 * href("shop.cart")                      // ✓ Validates route exists
 *
 * // ESCAPE HATCH: Path-based URLs (no validation)
 * href("/about")                         // ⚠ No type checking
 * href("/typo/in/path")                  // ⚠ Won't catch errors
 * ```
 */
export type ScopedHrefFunction<TLocalRoutes> = {
  /**
   * Route without params - validates route name exists
   * @recommended Use this for type-safe URL generation
   */
  <TName extends keyof TLocalRoutes & string>(
    name: IsEmptyObject<ExtractParams<RoutePatternFor<TLocalRoutes, TName>>> extends true ? TName : never
  ): string;

  /**
   * Route with params - validates both route name and params
   * @recommended Use this for type-safe URL generation with parameters
   */
  <TName extends keyof TLocalRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TLocalRoutes, TName>>
  ): string;

  /**
   * Absolute route name (contains dot) - global lookup
   * Use for cross-module navigation: "shop.cart", "blog.post"
   */
  (name: `${string}.${string}`, params?: Record<string, string>): string;

  /**
   * Path-based URL - ESCAPE HATCH, no type validation
   * Prefer route names for type safety. Only use paths when necessary.
   */
  (name: `/${string}`, params?: Record<string, string>): string;
};

/**
 * Extract local routes type from UrlPatterns
 * Used with scopedHref() to get the routes type from patterns
 */
export type ExtractLocalRoutes<TPatterns> =
  TPatterns extends { readonly _routes?: infer TRoutes }
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
 * Get a locally-typed href function from ctx.href for composable modules.
 *
 * This is a type-only cast - ctx.href already resolves local names at runtime
 * based on the current route prefix. This helper just provides type safety
 * for local route names within a url module.
 *
 * @param href - The ctx.href function from HandlerContext
 * @returns The same href function, but typed for local routes
 *
 * @example
 * ```typescript
 * // urls/blog.tsx
 * export const blogPatterns = urls(({ path }) => [
 *   path("/", (ctx) => {
 *     // Get locally-typed href for this module's routes
 *     const href = scopedHref<typeof blogPatterns>(ctx.href);
 *
 *     href("index");              // ✓ Type-safe local route
 *     href("post", { slug: "x" }); // ✓ Type-safe with params
 *     href("shop.cart");          // ✓ Cross-module (absolute name)
 *
 *     return <BlogIndex />;
 *   }, { name: "index" }),
 *
 *   path("/:slug", BlogPost, { name: "post" }),
 * ]);
 * ```
 */
export function scopedHref<TPatterns>(
  href: ((...args: any[]) => string)
): ScopedHrefFunction<ExtractLocalRoutes<TPatterns>> {
  return href as ScopedHrefFunction<ExtractLocalRoutes<TPatterns>>;
}

/**
 * Create a type-safe href function for URL generation
 *
 * @param routeMap - Flattened route map with all registered routes
 * @returns Type-safe href function
 *
 * @example
 * ```typescript
 * // Given routes: { cart: "/shop/cart", detail: "/shop/product/:slug" }
 * const href = createHref(routeMap);
 * href("cart"); // "/shop/cart"
 * href("detail", { slug: "my-product" }); // "/shop/product/my-product"
 * ```
 */
export function createHref<TRoutes extends Record<string, string>>(
  routeMap: TRoutes
): HrefFunction<TRoutes & Record<string, string>> {
  return ((name: string, params?: Record<string, string>) => {
    const pattern = routeMap[name];
    if (!pattern) {
      throw new Error(`Unknown route: ${name}`);
    }

    if (!params) return pattern;

    // Replace :param placeholders with actual values
    return pattern.replace(/:([^/]+)/g, (_, key) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(`Missing param "${key}" for route "${name}"`);
      }
      return encodeURIComponent(value);
    });
  }) as HrefFunction<TRoutes>;
}
