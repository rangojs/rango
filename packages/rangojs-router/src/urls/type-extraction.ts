import type { JsonSerialize } from "../serialize.js";
import type {
  TypedRouteItem,
  TypedIncludeItem,
  TypedLayoutItem,
  TypedCacheItem,
  TypedTransitionItem,
} from "../route-types.js";
import type { LocalOnlyInclude, UnnamedRoute } from "./pattern-types.js";

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
 */
type ExtractRoutesFromItem<T> =
  // TypedRouteItem: extract name -> pattern (exclude unnamed routes)
  // When search schema is non-empty, value becomes { path, search } object
  T extends TypedRouteItem<infer TName, infer TPattern, any, infer TSearch>
    ? TName extends string
      ? // Widened-name guard (#642): some name-less call forms — notably the
        // 3-arg children-fn overload path(pattern, component, () => [...]) —
        // let TName infer to the bare `string` constraint instead of the
        // UnnamedRoute sentinel, because the children-fn argument structurally
        // satisfies the all-optional PathOptions<TName> union member. Mapping
        // over a bare `string` key would emit `{ [K in string]: TPattern }`, an
        // index signature that poisons the whole sibling map (Rango.Path
        // collapses to never). Treat an unresolved name as unnamed.
        string extends TName
        ? {}
        : TName extends UnnamedRoute
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
 */
type ExtractRoutesFromItems<T extends readonly any[]> = T extends readonly any[]
  ? UnionToIntersection<
      { [K in keyof T]: ExtractRoutesFromItem<T[K]> }[number]
    > extends infer R
    ? // Blast-radius guard: never let a single malformed item collapse the
      // whole map. A `never` intersection satisfies `extends Record<string,any>`
      // (never extends everything), so check it explicitly first and fall back
      // to `{}` rather than propagating `never`. See #642.
      [R] extends [never]
      ? {}
      : R extends Record<string, any>
        ? R
        : {}
    : {}
  : {};

/**
 * Main utility: extract route map from urls() callback return type
 * Uses mapped types for sibling processing (no sibling limit).
 */
export type ExtractRoutes<T extends readonly any[]> = ExtractRoutesFromItems<T>;

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
type ExtractResponsesFromItem<T> =
  T extends TypedRouteItem<infer TName, any, infer TData>
    ? TName extends string
      ? // Widened-name guard (#642), parallels ExtractRoutesFromItem. A name-less
        // children-fn path.json(pattern, handler, () => [...]) infers TName as
        // bare `string`; without this the response map picks up an index
        // signature { [K in string]: TData } that wipes named siblings.
        string extends TName
        ? {}
        : TName extends UnnamedRoute
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
type ExtractResponsesFromItems<T extends readonly any[]> =
  T extends readonly any[]
    ? UnionToIntersection<
        { [K in keyof T]: ExtractResponsesFromItem<T[K]> }[number]
      > extends infer R
      ? // Blast-radius guard (parallels ExtractRoutesFromItems). See #642.
        [R] extends [never]
        ? {}
        : R extends Record<string, unknown>
          ? R
          : {}
      : {}
    : {};

/**
 * Main utility: extract response data type map from urls() callback return type.
 * Parallel to ExtractRoutes.
 */
export type ExtractResponses<T extends readonly any[]> =
  ExtractResponsesFromItems<T>;

// ============================================================================
// Response Error (RFC 9457 problem+json) Type
// ============================================================================

/**
 * RFC 9457 (problem+json) error body returned by JSON response routes on a
 * non-2xx status. Sent verbatim as the response body (not wrapped) with
 * content-type `application/problem+json`.
 *
 * @example
 * ```typescript
 * const res = await fetch(url);
 * if (!res.ok) {
 *   const problem: ProblemDetails = await res.json();
 *   console.log(problem.code, problem.detail); // "NOT_FOUND", "Product not found"
 *   return;
 * }
 * const product = await res.json(); // bare value, no envelope
 * ```
 */
export interface ProblemDetails {
  /**
   * URI reference identifying the problem type. Omitted in this phase (per RFC
   * 9457 an absent `type` is treated as `"about:blank"` — no semantics beyond
   * the HTTP status); per-route problem-type URIs arrive with the
   * declared-errors map later.
   */
  type?: string;
  /** Short, human-readable summary (the HTTP status reason phrase). */
  title: string;
  /** The HTTP status code. */
  status: number;
  /** Human-readable explanation specific to this occurrence (the error message). */
  detail: string;
  /** Stable machine-readable error code (`RouterError.code`, else `"INTERNAL"`). */
  code: string;
  /** Stack trace, included in development only. */
  stack?: string;
}

// ============================================================================
// Response Type Consumer Utilities
// ============================================================================

/**
 * Extract the JSON response payload type for a named route from a UrlPatterns
 * instance. JSON response routes send the handler's return value verbatim
 * (bare), so this resolves to the wire value a consumer receives — no envelope.
 *
 * @example
 * ```typescript
 * const apiPatterns = urls(({ path }) => [
 *   path.json("/health", (ctx) => ({ status: "ok", timestamp: Date.now() }), { name: "health" }),
 * ]);
 *
 * type HealthData = RouteResponse<typeof apiPatterns, "health">;
 * // { status: string; timestamp: number }
 * ```
 *
 * The payload is the JSON wire shape (via `Rango.JsonSerialize`), matching
 * `Rango.PathResponse` and what `fetch().then(r => r.json())` actually yields —
 * e.g. a `Date` field resolves as `string`.
 */
export type RouteResponse<TPatterns, TName extends string> = TPatterns extends {
  readonly _responses?: infer R;
}
  ? TName extends keyof R
    ? JsonSerialize<Exclude<R[TName], Response>>
    : never
  : never;
