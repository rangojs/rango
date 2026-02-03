import type { ExtractParams } from "./types.js";

/**
 * Sanitize prefix string by removing leading slash
 * "/shop" -> "shop", "blog" -> "blog", "" -> ""
 */
export type SanitizePrefix<T extends string> = T extends `/${infer P}` ? P : T;

/**
 * Helper type to merge multiple route definitions into a single accumulated type.
 * Note: When using createRSCRouter, types accumulate automatically through the
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
 * const router = createRSCRouter<AppEnv>()
 *   .routes(homeRoutes).map(...)
 *   .routes("/blog", blogRoutes).map(...);
 * type AppRoutes = typeof router.routeMap;
 * ```
 */
export type MergeRoutes<T extends Record<string, string>[]> = T extends [
  infer First extends Record<string, string>,
  ...infer Rest extends Record<string, string>[]
]
  ? First & MergeRoutes<Rest>
  : {};

/**
 * Add key prefix to all entries in a route map
 * { "cart": "/cart" } with prefix "shop" -> { "shop.cart": "/shop/cart" }
 */
export type PrefixRouteKeys<
  T extends Record<string, string>,
  Prefix extends string
> = Prefix extends ""
  ? T
  : { [K in keyof T as `${Prefix}.${K & string}`]: T[K] };

/**
 * Add path prefix to all patterns in a route map
 * { "cart": "/cart" } with prefix "/shop" -> { "cart": "/shop/cart" }
 */
export type PrefixRoutePatterns<
  T extends Record<string, string>,
  PathPrefix extends string
> = {
  [K in keyof T]: PathPrefix extends "" | "/"
    ? T[K]
    : T[K] extends "/"
      ? PathPrefix
      : `${PathPrefix}${T[K]}`;
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
  T extends Record<string, string>,
  KeyPrefix extends string,
  PathPrefix extends string = KeyPrefix extends "" ? "" : `/${KeyPrefix}`
> = PrefixRouteKeys<PrefixRoutePatterns<T, PathPrefix>, KeyPrefix>;

/**
 * Extract params type for a route
 */
export type ParamsFor<
  TRoutes extends Record<string, string>,
  TName extends keyof TRoutes
> = TRoutes[TName] extends string ? ExtractParams<TRoutes[TName]> : never;

/**
 * Check if an object type has any keys
 */
type IsEmptyObject<T> = keyof T extends never ? true : false;

/**
 * Type-safe href function signature
 * Provides overloads for routes with and without params
 */
export type HrefFunction<TRoutes extends Record<string, string>> = {
  // Overload 1: Routes without params - second arg optional
  <TName extends keyof TRoutes & string>(
    name: IsEmptyObject<ParamsFor<TRoutes, TName>> extends true ? TName : never
  ): string;

  // Overload 2: Routes with params - params required
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ParamsFor<TRoutes, TName>
  ): string;
};

/**
 * Type-safe scoped href function signature for use with useHref<typeof patterns>()
 * Accepts local route names (from the patterns), absolute names (with dot), or path-based URLs.
 *
 * @example
 * ```typescript
 * // In a component rendered by blog routes:
 * const href = useHref<typeof blogPatterns>();
 *
 * href("index")                    // Local name → resolved with current prefix
 * href("post", { slug: "hello" })  // Local name with params
 * href("shop.cart")                // Absolute name → global lookup
 * href("/about")                   // Path-based → used directly
 * ```
 */
export type ScopedHrefFunction<TLocalRoutes extends Record<string, string>> = {
  // Overload 1: Local routes without params
  <TName extends keyof TLocalRoutes & string>(
    name: IsEmptyObject<ParamsFor<TLocalRoutes, TName>> extends true ? TName : never
  ): string;

  // Overload 2: Local routes with params
  <TName extends keyof TLocalRoutes & string>(
    name: TName,
    params: ParamsFor<TLocalRoutes, TName>
  ): string;

  // Overload 3: Absolute name (contains dot) - global lookup
  (name: `${string}.${string}`, params?: Record<string, string>): string;

  // Overload 4: Path-based URL - used directly
  (name: `/${string}`, params?: Record<string, string>): string;
};

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
): HrefFunction<TRoutes> {
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
