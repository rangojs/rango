/**
 * Taint symbol for request-scoped objects.
 *
 * Objects branded with NOCACHE_SYMBOL (ctx, env, req) are excluded from
 * "use cache" cache keys and trigger handle capture mode so that side
 * effects (breadcrumbs, metadata) are recorded and replayed on cache hit.
 */

export const NOCACHE_SYMBOL: unique symbol = Symbol.for("rango:nocache") as any;

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
 * Symbol stamped on tainted ctx during "use cache" function execution.
 * cookies(), headers(), ctx.set(), ctx.header(), etc. check this flag and
 * throw if present — reads would cache per-request data under a shared key,
 * and side effects would be lost on cache hit.
 */
export const INSIDE_CACHE_EXEC: unique symbol = Symbol.for(
  "rango:inside-cache-exec",
) as any;

/**
 * Throw if ctx is inside a "use cache" execution.
 * Call from side-effecting ctx methods (set, header, etc.) and cookie mutations.
 */
export function assertNotInsideCacheExec(
  ctx: unknown,
  methodName: string,
): void {
  if (
    ctx !== null &&
    ctx !== undefined &&
    typeof ctx === "object" &&
    (INSIDE_CACHE_EXEC as symbol) in (ctx as Record<symbol, unknown>)
  ) {
    throw new Error(
      `ctx.${methodName}() cannot be called inside a "use cache" function. ` +
        `Side effects on the request context are lost on cache hit because ` +
        `the function body is skipped. Extract the data fetch into a separate ` +
        `cached function and call ctx.${methodName}() outside it, or use the ` +
        `route-level cache() DSL which caches all segments (handler + children) ` +
        `together.`,
    );
  }
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
  return typeof value === "function" && (CACHED_FN_SYMBOL as symbol) in value;
}
