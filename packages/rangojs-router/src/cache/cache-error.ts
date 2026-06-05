/**
 * Cache error reporting.
 *
 * Caches are best-effort: a read failure degrades to a miss (render fresh) and a
 * write failure degrades to a no-op - they MUST NOT throw up and fail the
 * request. But the failure must still be LOUD: it is logged to the console (so
 * it is visible even in a background waitUntil task or when no hook is wired)
 * AND routed through the router's onError callback (via the request context's
 * deduped _reportBackgroundError) so consumers can observe cache degradation in
 * their own telemetry.
 *
 * The one deliberate exception is the invalidation WRITE verb (updateTag ->
 * store.invalidateTags): a failed durable marker write is rejected so an awaited
 * updateTag() surfaces it (read-your-own-writes honesty). That is not a data
 * read/write and does not go through this helper's swallow-and-degrade path.
 */

import { _getRequestContext } from "../server/request-context.js";

export type CacheErrorCategory =
  /** A read failed (transient infra: KV/Cache API error). Degrade to a miss. */
  | "cache-read"
  /** A write failed. Degrade to a no-op (entry simply not cached). */
  | "cache-write"
  /** A delete/eviction failed. Best-effort. */
  | "cache-delete"
  /**
   * A STORED entry could not be parsed/deserialized (partial KV read, truncated
   * Cache API body, malformed envelope/RSC payload). The entry is faulty and is
   * evicted so subsequent reads do not keep failing on it. Distinct from
   * cache-read so consumers can tell corruption from a transient outage.
   */
  | "cache-corrupt"
  /** A tag-invalidation side effect failed (e.g. the eager CDN purge hook). */
  | "cache-invalidate";

/**
 * Report a non-fatal cache error loudly without failing the request: always logs
 * (label + error) and, when a request context is available, routes the error
 * through the router's onError callback. Never throws.
 */
export function reportCacheError(
  error: unknown,
  category: CacheErrorCategory,
  label: string,
): void {
  console.error(`${label}:`, error);
  try {
    _getRequestContext()?._reportBackgroundError?.(error, category);
  } catch {
    // Reporting must never itself break the cache path.
  }
}

/**
 * Run a best-effort async cache task (typically scheduled via waitUntil), catching
 * any rejection and routing it through reportCacheError so background cache work
 * (non-blocking L1 writes, KV persistence, L1 promotion) reports failures via
 * onError instead of throwing or silently swallowing. Never rejects.
 *
 * @example this.waitUntil(() => reportingAsync(() => cache.put(req, res), "cache-write", "[CFCacheStore] L1 write"))
 */
export async function reportingAsync(
  task: () => Promise<unknown>,
  category: CacheErrorCategory,
  label: string,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    reportCacheError(error, category, label);
  }
}
