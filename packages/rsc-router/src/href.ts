import type { ExtractParams } from "./types.js";

/**
 * Sanitize prefix string by removing leading slash
 * "/shop" -> "shop", "blog" -> "blog", "" -> ""
 */
export type SanitizePrefix<T extends string> = T extends `/${infer P}` ? P : T;

/**
 * Helper type to merge multiple route definitions into a single accumulated type.
 * Use this to define your app's complete route map for type-safe router.href().
 *
 * @example
 * ```typescript
 * import { homeRoutes, blogRoutes, shopRoutes } from "./routes";
 *
 * type AppRoutes = MergeRoutes<[
 *   typeof homeRoutes,
 *   PrefixedRoutes<typeof blogRoutes, "blog">,
 *   PrefixedRoutes<typeof shopRoutes, "shop">,
 * ]>;
 *
 * export const router = createRSCRouter<AppEnv>() as RSCRouter<AppEnv, AppRoutes>;
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
 * Create a type-safe href function for URL generation
 *
 * @param routeMap - Flattened route map with all registered routes
 * @returns Type-safe href function
 *
 * @example
 * ```typescript
 * const href = createHref(mergedRouteMap);
 * href("shop.cart"); // "/shop/cart"
 * href("shop.products.detail", { slug: "my-product" }); // "/shop/product/my-product"
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
