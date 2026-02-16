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
 * Extract search schema from a route entry.
 * Returns {} if no search schema is defined.
 */
type ExtractSearchSchema<TRoutes, TName extends keyof TRoutes> =
  TRoutes[TName] extends { readonly search: infer S extends SearchSchema }
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
    name: IsEmptyObject<ExtractParams<RoutePatternFor<TRoutes, TName>>> extends true ? TName : never
  ): string;

  /**
   * Route with params - validates both route name and params
   */
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>
  ): string;

  /**
   * Route with params and search - validates route name, params, and search
   */
  <TName extends keyof TRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TRoutes, TName>>
  ): string;
};

/**
 * Type-safe scoped reverse function that validates all route names and params.
 *
 * When used via HandlerContext or scopedReverse(), local routes are merged with
 * global RegisteredRoutes so all names are fully type-checked.
 *
 * @example
 * ```typescript
 * reverse("cart")                           // ✓ Validates local route
 * reverse("blog.post", { slug: "hello" })   // ✓ Validates global route + params
 * reverse("typo")                           // ✗ Compile error
 * ```
 */
export type ScopedReverseFunction<TLocalRoutes> = {
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
   * Route with params and search - validates route name, params, and search
   */
  <TName extends keyof TLocalRoutes & string>(
    name: TName,
    params: ExtractParams<RoutePatternFor<TLocalRoutes, TName>>,
    search: ResolveSearchSchema<ExtractSearchSchema<TLocalRoutes, TName>>
  ): string;
};

/**
 * Extract local routes type from UrlPatterns
 * Used with scopedReverse() to get the routes type from patterns
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
 * Get a locally-typed reverse function from ctx.reverse for composable modules.
 *
 * This is a type-only cast - ctx.reverse already resolves local names at runtime
 * based on the current route prefix. This helper just provides type safety
 * for local route names within a url module.
 *
 * @param reverse - The ctx.reverse function from HandlerContext
 * @returns The same reverse function, but typed for local routes
 *
 * @example
 * ```typescript
 * // urls/blog.tsx
 * export const blogPatterns = urls(({ path }) => [
 *   path("/", (ctx) => {
 *     // Get locally-typed reverse for this module's routes
 *     const reverse = scopedReverse<typeof blogPatterns>(ctx.reverse);
 *
 *     reverse("index");              // ✓ Type-safe local route
 *     reverse("post", { slug: "x" }); // ✓ Type-safe with params
 *     reverse("shop.cart");          // ✓ Type-safe global route
 *
 *     return <BlogIndex />;
 *   }, { name: "index" }),
 *
 *   path("/:slug", BlogPost, { name: "post" }),
 * ]);
 * ```
 */
export function scopedReverse<TPatterns>(
  reverse: ((...args: any[]) => string)
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

function resolveRoutePattern(entry: RouteMapEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return typeof entry === "string" ? entry : entry.path;
}

export function createReverse<TRoutes extends Record<string, string>>(
  routeMap: TRoutes,
  getFallbackMap?: () => Record<string, RouteMapEntry> | undefined,
): ReverseFunction<TRoutes & Record<string, string>> {
  return ((name: string, params?: Record<string, string>, search?: Record<string, unknown>) => {
    let pattern = resolveRoutePattern(routeMap[name] as unknown as RouteMapEntry);
    if (!pattern) {
      // Try the static route names from the generated file (O(1) fallback)
      const fallback = getFallbackMap?.();
      if (fallback) {
        pattern = resolveRoutePattern(fallback[name]);
      }
    }
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
