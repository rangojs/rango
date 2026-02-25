/**
 * Search parameter schema types and runtime utilities.
 *
 * Provides a lightweight schema system for typed query parameters.
 * When a route defines a `search` schema, ctx.search provides a typed
 * object with parsed values. ctx.searchParams always remains a standard
 * URLSearchParams instance.
 */

// ============================================================================
// Schema Types
// ============================================================================

/** Supported scalar types for search params (append ? for optional). */
export type SearchSchemaValue =
  | "string"
  | "number"
  | "boolean"
  | "string?"
  | "number?"
  | "boolean?";

/** A search schema maps param names to their type descriptors. */
export type SearchSchema = Record<string, SearchSchemaValue>;

// ============================================================================
// Type-Level Schema Resolution
// ============================================================================

/** Strip trailing `?` from a schema value to get the base type. */
type BaseType<T extends string> = T extends `${infer B}?` ? B : T;

/** Map a base type string to its TypeScript type. */
type ResolveBaseType<T extends string> = T extends "string"
  ? string
  : T extends "number"
    ? number
    : T extends "boolean"
      ? boolean
      : never;

/** Keys whose schema value does NOT end with `?`. */
type RequiredKeys<T extends SearchSchema> = {
  [K in keyof T]: T[K] extends `${string}?` ? never : K;
}[keyof T];

/** Keys whose schema value ends with `?`. */
type OptionalKeys<T extends SearchSchema> = {
  [K in keyof T]: T[K] extends `${string}?` ? K : never;
}[keyof T];

/** Flatten an intersection type into a single object type. */
type Simplify<T> = { [K in keyof T]: T[K] };

/**
 * Resolve a SearchSchema to its typed object.
 *
 * @example
 * type S = { q: "string"; page: "number?"; sort: "string?" };
 * type R = ResolveSearchSchema<S>;
 * // { q: string; page?: number; sort?: string }
 */
export type ResolveSearchSchema<T extends SearchSchema> = Simplify<
  {
    [K in RequiredKeys<T> & string]: ResolveBaseType<BaseType<T[K]>>;
  } & {
    [K in OptionalKeys<T> & string]?: ResolveBaseType<BaseType<T[K]>>;
  }
>;

// ============================================================================
// Route-Level Type Extraction
// ============================================================================

/** Resolve the global route map from RegisteredRoutes or GeneratedRouteMap. */
type GlobalRouteMap = keyof RSCRouter.RegisteredRoutes extends never
  ? keyof RSCRouter.GeneratedRouteMap extends never
    ? Record<string, string>
    : RSCRouter.GeneratedRouteMap
  : RSCRouter.RegisteredRoutes;

/**
 * Extract the resolved search params type for a named route.
 * Looks up the search schema from the route map and resolves it.
 *
 * @example
 * ```typescript
 * // Given: path("/search", handler, { name: "search", search: { q: "string", page: "number?" } })
 * type Params = RouteSearchParams<"search">;
 * // { q: string; page?: number }
 * ```
 */
export type RouteSearchParams<TName extends string, TRouteMap = never> = [
  TRouteMap,
] extends [never]
  ? ExtractAndResolveSearch<GlobalRouteMap, TName>
  : ExtractAndResolveSearch<TRouteMap, TName>;

type ExtractAndResolveSearch<TRouteMap, TName> = TName extends keyof TRouteMap
  ? TRouteMap[TName] extends { readonly search: infer S extends SearchSchema }
    ? ResolveSearchSchema<S>
    : {}
  : {};

/**
 * Extract the route params type for a named route.
 * Looks up the path pattern from the route map and extracts params.
 *
 * @example
 * ```typescript
 * // Given: path("/blog/:slug", handler, { name: "blogPost" })
 * type Params = RouteParams<"blogPost">;
 * // { slug: string }
 * ```
 */
export type RouteParams<TName extends string, TRouteMap = never> = [
  TRouteMap,
] extends [never]
  ? ExtractRouteParamsFromMap<GlobalRouteMap, TName>
  : ExtractRouteParamsFromMap<TRouteMap, TName>;

type ExtractRouteParamsFromMap<TRouteMap, TName> = TName extends keyof TRouteMap
  ? TRouteMap[TName] extends string
    ? ExtractParamsFromPattern<TRouteMap[TName]>
    : TRouteMap[TName] extends { readonly path: infer P extends string }
      ? ExtractParamsFromPattern<P>
      : {}
  : {};

/** Minimal inline param extraction (avoids importing from types.ts to prevent circular deps). */
type ExtractParamsFromPattern<T extends string> =
  T extends `${string}:${infer Param}/${infer Rest}`
    ? Param extends `${infer Name}?`
      ? { [K in Name]?: string } & ExtractParamsFromPattern<`/${Rest}`>
      : Param extends `${infer Name}(${string})`
        ? { [K in Name]: string } & ExtractParamsFromPattern<`/${Rest}`>
        : { [K in Param]: string } & ExtractParamsFromPattern<`/${Rest}`>
    : T extends `${string}:${infer Param}`
      ? Param extends `${infer Name}?`
        ? { [K in Name]?: string }
        : Param extends `${infer Name}(${string})`
          ? { [K in Name]: string }
          : { [K in Param]: string }
      : {};

// ============================================================================
// Runtime Parser
// ============================================================================

/**
 * Parse URLSearchParams into a typed object using the given schema.
 *
 * - `"string"` / `"string?"` - kept as-is
 * - `"number"` / `"number?"` - coerced via `Number()`; NaN treated as missing
 * - `"boolean"` / `"boolean?"` - `"true"` / `"1"` -> true, `"false"` / `"0"` / `""` -> false
 *
 * Missing required params are set to their zero value (empty string / 0 / false).
 */
export function parseSearchParams<T extends SearchSchema>(
  searchParams: URLSearchParams,
  schema: T,
): ResolveSearchSchema<T> {
  const result: Record<string, unknown> = {};

  for (const [key, descriptor] of Object.entries(schema)) {
    const isOptional = descriptor.endsWith("?");
    const baseType = isOptional ? descriptor.slice(0, -1) : descriptor;
    const raw = searchParams.get(key);

    if (raw === null) {
      if (!isOptional) {
        // Required param missing: use zero value
        if (baseType === "string") result[key] = "";
        else if (baseType === "number") result[key] = 0;
        else if (baseType === "boolean") result[key] = false;
      }
      // Optional params are omitted (undefined)
      continue;
    }

    if (baseType === "string") {
      result[key] = raw;
    } else if (baseType === "number") {
      const num = Number(raw);
      if (Number.isNaN(num)) {
        if (!isOptional) result[key] = 0;
      } else {
        result[key] = num;
      }
    } else if (baseType === "boolean") {
      result[key] = raw === "true" || raw === "1";
    }
  }

  return result as ResolveSearchSchema<T>;
}

// ============================================================================
// Runtime Serializer
// ============================================================================

/**
 * Serialize a typed search params object to a query string (without leading `?`).
 * Skips `undefined` and `null` values.
 */
export function serializeSearchParams(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    parts.push(
      `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    );
  }
  return parts.join("&");
}
