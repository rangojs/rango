/**
 * Taint symbol for request-scoped objects.
 *
 * Objects branded with NOCACHE_SYMBOL (ctx, env, req) are excluded from
 * "use cache" cache keys and trigger handle capture mode so that side
 * effects (breadcrumbs, metadata) are recorded and replayed on cache hit.
 */

export const NOCACHE_SYMBOL: unique symbol = Symbol.for(
  "rango:nocache",
) as any;

/**
 * Check if a value is tainted (request-scoped, should not be in cache key).
 */
export function isTainted(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    (NOCACHE_SYMBOL as symbol) in (value as Record<symbol, unknown>)
  );
}

/**
 * Brand symbol for functions wrapped by registerCachedFunction().
 * Used at runtime to detect when a "use cache" function is misused
 * (e.g., passed as middleware).
 */
export const CACHED_FN_SYMBOL: unique symbol = Symbol.for(
  "rango:cached-fn",
) as any;

/**
 * Check if a value is a "use cache" wrapped function.
 */
export function isCachedFunction(value: unknown): boolean {
  return (
    typeof value === "function" &&
    (CACHED_FN_SYMBOL as symbol) in value
  );
}
