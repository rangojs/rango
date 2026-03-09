import type { ExtractParams } from "../types.js";
import type {
  TypedRouteItem,
  TypedIncludeItem,
  TypedLayoutItem,
  TypedCacheItem,
  TypedTransitionItem,
} from "../route-types.js";
import type {
  LocalOnlyInclude,
  UnnamedRoute,
  UrlPatterns,
} from "./pattern-types.js";

// ============================================================================
// Route Type Extraction Utilities
// ============================================================================

/**
 * Prefix route names with a given prefix (e.g., "blog" + "post" = "blog.post")
 *
 * Filters out plain `string` index signatures to prevent dynamically-generated
 * routes from poisoning the route map. When TypeScript encounters very large
 * route sets (5000+ routes via Array.from), it may give up computing specific
 * types and fall back to Record<string, string>. Without filtering, PrefixRoutes
 * would map `string` to `${prefix}.${string}`, creating an index signature that
 * accepts ANY prefixed name and defeats type-safe route checking.
 *
 * Uses `string extends K` (conservative filter):
 * - Drops `string` keys (TypeScript fallback) -> prevents `[x: `site.${string}`]`
 * - Keeps template literal patterns like `item${number}` from Array.from loops,
 *   which are imprecise but still allow writing paths like `/shop/product/1`
 *
 * A more aggressive alternative (`{} extends Record<K, 1>`) would also drop
 * template literal patterns. We chose conservative because loop-generated routes
 * with `${number}` patterns still provide some value: they don't appear in
 * named-routes.gen.ts or IDE autocomplete, but they do let you manually write
 * valid paths without type errors.
 */
type PrefixRoutes<
  TRoutes extends Record<string, any>,
  TPrefix extends string,
> = TPrefix extends ""
  ? TRoutes
  : {
      [K in keyof TRoutes as K extends string
        ? string extends K
          ? never
          : `${TPrefix}.${K}`
        : never]: TRoutes[K];
    };

/**
 * Prefix route patterns with a URL prefix (e.g., "/blog" + "/:slug" = "/blog/:slug")
 */
type PrefixPatterns<
  TRoutes extends Record<string, any>,
  TUrlPrefix extends string,
> = {
  [K in keyof TRoutes]: TRoutes[K] extends string
    ? `${TUrlPrefix}${TRoutes[K]}`
    : TRoutes[K] extends {
          readonly path: infer P extends string;
          readonly search: infer S;
        }
      ? { readonly path: `${TUrlPrefix}${P}`; readonly search: S }
      : TRoutes[K];
};

/**
 * Depth counter for limiting recursion (max 40 levels)
 * Supports up to 40 sibling items at any level of a urls() call
 * Note: Higher values hit TypeScript's internal recursion limits
 */
type Depth = [
  never,
  0,
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  15,
  16,
  17,
  18,
  19,
  20,
  21,
  22,
  23,
  24,
  25,
  26,
  27,
  28,
  29,
  30,
  31,
  32,
  33,
  34,
  35,
  36,
  37,
  38,
  39,
];

/**
 * Force TypeScript to eagerly evaluate a type.
 * This helps with interface extension by creating a "concrete" object type.
 */
type Simplify<T> =
  T extends Record<string, string> ? { [K in keyof T]: T[K] } : T;

/**
 * Convert a union type to an intersection type.
 * Used to combine route maps from multiple siblings without recursive tuple processing.
 */
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (
  k: infer I,
) => void
  ? I
  : never;

/**
 * Extract routes from a single item (path, include, layout, cache with children)
 * D is the current depth level for nested layouts/caches
 */
type ExtractRoutesFromItem<T, D extends number = 40> = [D] extends [never]
  ? {} // Max depth reached, stop recursion
  : // TypedRouteItem: extract name -> pattern (exclude unnamed routes)
    // When search schema is non-empty, value becomes { path, search } object
    T extends TypedRouteItem<infer TName, infer TPattern, any, infer TSearch>
    ? TName extends string
      ? TName extends UnnamedRoute
        ? {} // Exclude unnamed routes from type map
        : {} extends TSearch
          ? { [K in TName]: TPattern }
          : {
              [K in TName]: {
                readonly path: TPattern;
                readonly search: TSearch;
              };
            }
      : {}
    : // TypedIncludeItem: extract prefixed routes (both name and URL prefix)
      T extends TypedIncludeItem<
          infer TRoutes,
          infer TNamePrefix,
          infer TUrlPrefix
        >
      ? TNamePrefix extends LocalOnlyInclude
        ? {}
        : TNamePrefix extends string
          ? TUrlPrefix extends string
            ? PrefixRoutes<PrefixPatterns<TRoutes, TUrlPrefix>, TNamePrefix>
            : PrefixRoutes<TRoutes, TNamePrefix>
          : TUrlPrefix extends string
            ? PrefixPatterns<TRoutes, TUrlPrefix>
            : TRoutes
      : // TypedLayoutItem: extract child routes from phantom type
        T extends TypedLayoutItem<infer TChildRoutes>
        ? TChildRoutes
        : // TypedCacheItem: extract child routes from phantom type
          T extends TypedCacheItem<infer TChildRoutes>
          ? TChildRoutes
          : // TypedTransitionItem: extract child routes from phantom type
            T extends TypedTransitionItem<infer TChildRoutes>
            ? TChildRoutes
            : // Fallback (won't extract routes)
              {};

/**
 * Extract routes from an array of items using mapped types.
 * Uses UnionToIntersection to combine routes without recursive tuple processing,
 * removing the sibling limit that was caused by TypeScript recursion limits.
 * D is passed to ExtractRoutesFromItem for nested depth tracking.
 */
type ExtractRoutesFromItems<
  T extends readonly any[],
  D extends number = 40,
> = T extends readonly any[]
  ? UnionToIntersection<
      { [K in keyof T]: ExtractRoutesFromItem<T[K], D> }[number]
    > extends infer R
    ? R extends Record<string, any>
      ? R
      : {}
    : {}
  : {};

/**
 * Main utility: extract route map from urls() callback return type
 * Uses mapped types for sibling processing (no sibling limit).
 * Uses Simplify to force eager evaluation for interface extension compatibility.
 */
export type ExtractRoutes<T extends readonly any[]> = ExtractRoutesFromItems<
  T,
  40
>;

// ============================================================================
// Response Type Extraction Utilities
// ============================================================================

/**
 * Prefix keys of a Record<string, unknown> with a dot-separated prefix.
 * Used for response type maps through include().
 * Same index signature filter as PrefixRoutes (see comment there).
 */
type PrefixKeys<
  T extends Record<string, unknown>,
  TPrefix extends string,
> = TPrefix extends ""
  ? T
  : {
      [K in keyof T as K extends string
        ? string extends K
          ? never
          : `${TPrefix}.${K}`
        : never]: T[K];
    };

/**
 * Extract response data types from a single item.
 * Parallel to ExtractRoutesFromItem but extracts name -> TData mapping.
 */
type ExtractResponsesFromItem<T, D extends number = 40> = [D] extends [never]
  ? {}
  : T extends TypedRouteItem<infer TName, any, infer TData>
    ? TName extends string
      ? TName extends UnnamedRoute
        ? {}
        : { [K in TName]: TData }
      : {}
    : T extends TypedIncludeItem<any, infer TNamePrefix, any, infer TResponses>
      ? TNamePrefix extends LocalOnlyInclude
        ? {}
        : TNamePrefix extends string
          ? TResponses extends Record<string, unknown>
            ? PrefixKeys<TResponses, TNamePrefix>
            : {}
          : TResponses extends Record<string, unknown>
            ? TResponses
            : {}
      : T extends TypedLayoutItem<any, infer TChildResponses>
        ? TChildResponses extends Record<string, unknown>
          ? TChildResponses
          : {}
        : T extends TypedCacheItem<any, infer TChildResponses>
          ? TChildResponses extends Record<string, unknown>
            ? TChildResponses
            : {}
          : T extends TypedTransitionItem<any, infer TChildResponses>
            ? TChildResponses extends Record<string, unknown>
              ? TChildResponses
              : {}
            : {};

/**
 * Extract responses from an array of items using mapped types.
 * Parallel to ExtractRoutesFromItems.
 */
type ExtractResponsesFromItems<
  T extends readonly any[],
  D extends number = 40,
> = T extends readonly any[]
  ? UnionToIntersection<
      { [K in keyof T]: ExtractResponsesFromItem<T[K], D> }[number]
    > extends infer R
    ? R extends Record<string, unknown>
      ? R
      : {}
    : {}
  : {};

/**
 * Main utility: extract response data type map from urls() callback return type.
 * Parallel to ExtractRoutes.
 */
export type ExtractResponses<T extends readonly any[]> =
  ExtractResponsesFromItems<T, 40>;

// ============================================================================
// Type Utilities for path()
// ============================================================================

/**
 * Extract route names from a UrlPatterns result
 * Used for type-safe href() generation
 */
export type ExtractRouteNames<T extends UrlPatterns<any>> =
  T extends UrlPatterns<infer _TEnv>
    ? string // For now, will be refined with full implementation
    : never;

/**
 * Extract params for a specific route name
 */
export type ExtractPathParams<
  T extends UrlPatterns<any>,
  K extends string,
> = ExtractParams<string>; // Will be refined with pattern tracking

// ============================================================================
// Response Envelope Types
// ============================================================================

/**
 * Error shape returned in the `{ error }` side of a JSON response envelope.
 */
export interface ResponseError {
  message: string;
  code?: string;
  type?: string;
  stack?: string;
}

/**
 * Discriminated union envelope for JSON response routes.
 * Consumers check `result.error` to discriminate between success and failure.
 *
 * @example
 * ```typescript
 * const result: ResponseEnvelope<Product> = await fetch(url).then(r => r.json());
 * if (result.error) {
 *   console.log(result.error.message, result.error.code);
 *   return;
 * }
 * result.data.name // fully typed
 * ```
 */
export type ResponseEnvelope<T> =
  | { data: T; error?: undefined }
  | { data?: undefined; error: ResponseError };

// ============================================================================
// Response Type Consumer Utilities
// ============================================================================

/**
 * Extract the response data type for a named route from a UrlPatterns instance.
 * Wraps in ResponseEnvelope since JSON response routes return enveloped data.
 *
 * @example
 * ```typescript
 * const apiPatterns = urls(({ path }) => [
 *   path.json("/health", (ctx) => ({ status: "ok", timestamp: Date.now() }), { name: "health" }),
 * ]);
 *
 * type HealthData = RouteResponse<typeof apiPatterns, "health">;
 * // ResponseEnvelope<{ status: string; timestamp: number }>
 * ```
 */
export type RouteResponse<TPatterns, TName extends string> = TPatterns extends {
  readonly _responses?: infer R;
}
  ? TName extends keyof R
    ? ResponseEnvelope<Exclude<R[TName], Response>>
    : never
  : never;
