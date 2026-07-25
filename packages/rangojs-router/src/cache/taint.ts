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
 * Symbol stamped on tainted ctx objects PASSED AS ARGUMENTS to a "use cache"
 * function during its execution. ctx.set(), ctx.header(), etc. check this
 * flag and throw if present — those side effects are lost on cache hit.
 *
 * Argument objects only. Ambient access (cookies()/headers() and ctx methods
 * reached via getRequestContext()) is guarded by the AsyncLocalStorage scope
 * in cache-exec-scope.ts instead: stamping the SHARED RequestContext made
 * every parallel read on the request throw for the cached body's whole
 * execution window (a 2s cached fetch poisoned a sibling loader's cookies()).
 *
 * The value is a numeric reference count, not a boolean. Multiple concurrent
 * cached functions sharing the same ctx each increment on entry and decrement
 * on exit. Guards fire when count > 0.
 */
export const INSIDE_CACHE_EXEC: unique symbol = Symbol.for(
  "rango:inside-cache-exec",
) as any;

/**
 * Increment the INSIDE_CACHE_EXEC ref count on an object.
 */
export function stampCacheExec(obj: object): void {
  const current = (obj as any)[INSIDE_CACHE_EXEC] ?? 0;
  (obj as any)[INSIDE_CACHE_EXEC] = current + 1;
}

/**
 * Decrement the INSIDE_CACHE_EXEC ref count on an object.
 * Deletes the symbol when the count reaches zero so the `in` check
 * used by guards no longer fires.
 */
export function unstampCacheExec(obj: object): void {
  const current = (obj as any)[INSIDE_CACHE_EXEC] ?? 0;
  if (current <= 1) {
    delete (obj as any)[INSIDE_CACHE_EXEC];
  } else {
    (obj as any)[INSIDE_CACHE_EXEC] = current - 1;
  }
}

/**
 * Probe for the AsyncLocalStorage-based "use cache" execution scope.
 * Registered by cache-exec-scope.ts at module init; the default ("never
 * inside") keeps this module free of node:async_hooks — taint.ts is reachable
 * from browser-bundled DSL helpers. Covers AMBIENT ctx access inside a cached
 * body (getRequestContext().set(...)) chain-scoped, where the object stamp
 * below only covers ctx objects explicitly passed as arguments.
 */
let cacheExecScopeProbe: () => boolean = () => false;

export function _setCacheExecScopeProbe(probe: () => boolean): void {
  cacheExecScopeProbe = probe;
}

/**
 * Throw if ctx is inside a "use cache" execution.
 * Call from side-effecting ctx methods (set, header, etc.) and cookie mutations.
 */
export function assertNotInsideCacheExec(
  ctx: unknown,
  methodName: string,
): void {
  const argStamped =
    ctx !== null &&
    ctx !== undefined &&
    typeof ctx === "object" &&
    (INSIDE_CACHE_EXEC as symbol) in (ctx as Record<symbol, unknown>);
  if (argStamped || cacheExecScopeProbe()) {
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
 * Symbol stamped on ctx when resolving handlers inside a cache() DSL boundary.
 * Separate from INSIDE_CACHE_EXEC ("use cache") because cache() allows
 * ctx.set() (children are also cached) but blocks response-level side effects
 * (headers, cookies, status) which are lost on cache hit.
 */
export const INSIDE_CACHE_SCOPE: unique symbol = Symbol.for(
  "rango:inside-cache-scope",
) as any;

/**
 * Mark ctx as inside a cache() scope. Must be paired with unstampCacheScope.
 */
export function stampCacheScope(obj: object): void {
  const current = (obj as any)[INSIDE_CACHE_SCOPE] ?? 0;
  (obj as any)[INSIDE_CACHE_SCOPE] = current + 1;
}

/**
 * Remove cache() scope mark.
 */
export function unstampCacheScope(obj: object): void {
  const current = (obj as any)[INSIDE_CACHE_SCOPE] ?? 0;
  if (current <= 1) {
    delete (obj as any)[INSIDE_CACHE_SCOPE];
  } else {
    (obj as any)[INSIDE_CACHE_SCOPE] = current - 1;
  }
}

/**
 * Throw if ctx is inside a cache() DSL boundary.
 * Call from response-level side effects (header, setCookie, setStatus, etc.)
 * which are lost on cache hit because the handler body is skipped.
 * ctx.set() is allowed inside cache() — children are also cached and can
 * read the value.
 */
export function assertNotInsideCacheScope(
  ctx: unknown,
  methodName: string,
): void {
  if (
    ctx !== null &&
    ctx !== undefined &&
    typeof ctx === "object" &&
    (INSIDE_CACHE_SCOPE as symbol) in (ctx as Record<symbol, unknown>)
  ) {
    throw new Error(
      `ctx.${methodName}() cannot be called inside a cache() boundary. ` +
        `On cache hit the handler is skipped, so this side effect would be lost. ` +
        `Move ctx.${methodName}() to a middleware or layout outside the cache() scope.`,
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
