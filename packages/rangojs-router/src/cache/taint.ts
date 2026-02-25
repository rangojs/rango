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
