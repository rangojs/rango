/**
 * SWR Read-Through Engine
 *
 * Generic read-through cache with stale-while-revalidate support
 * for item-level caching (getItem/setItem).
 *
 * Flow:
 * 1. Lookup cached item by key
 * 2. Fresh hit → deserialize, return
 * 3. Stale hit → deserialize, return, revalidate in background
 * 4. Miss → execute, cache write (blocking when no waitUntil), return
 */

import type { CacheItemResult, CacheItemOptions } from "./types.js";
import { runBackground } from "./background-task.js";
import { reportCacheError } from "./cache-error.js";
import type { CacheErrorReporter } from "./cache-error.js";

// The host carries both the optional waitUntil (for background scheduling) and
// the CacheErrorReporter seam (for routing degradation errors through onError).
// loader-cache.ts passes the request context, which provides both.
type WaitUntilHost = {
  waitUntil?: (fn: () => Promise<void>) => void;
} & CacheErrorReporter;

export interface ReadThroughItemConfig<T> {
  /** Retrieve a cached item by key */
  getItem: (key: string) => Promise<CacheItemResult | null>;
  /** Store a serialized item by key */
  setItem: (
    key: string,
    value: string,
    options?: CacheItemOptions,
  ) => Promise<void>;
  /** Cache key */
  key: string;
  /** Execute the underlying function/loader on miss or revalidation */
  execute: () => Promise<T>;
  /**
   * Optional wrapper applied to execute() ONLY on the background
   * stale-revalidation path (not the foreground miss, where the caller's context
   * is already established). Used to re-establish the request-context ALS, which
   * a detached waitUntil task loses on workerd. Defaults to calling execute()
   * directly.
   */
  wrapBackground?: (run: () => Promise<T>) => Promise<T>;
  /** Serialize result for storage. Return null to skip caching. */
  serialize: (data: T) => Promise<string | null>;
  /** Deserialize cached value back to the original type */
  deserialize: (value: string) => Promise<T>;
  /** Options passed to setItem on cache write */
  storeOptions: CacheItemOptions;
  /** Called on fresh cache hit (before returning data) */
  onHit?: (cached: CacheItemResult) => void;
  /** Called on stale cache hit (before scheduling background revalidation) */
  onStale?: (cached: CacheItemResult) => void;
  /** Called on cache miss (before executing) */
  onMiss?: () => void;
  /** Called after successful cache write */
  onCached?: () => void;
  /** Host with optional waitUntil for background tasks */
  host?: WaitUntilHost | null;
}

/**
 * Read-through cache with SWR support for item-level caching.
 *
 * On fresh hit: returns deserialized cached data.
 * On stale hit: returns stale data, schedules background revalidation.
 * On miss: executes, writes to cache (blocking when no waitUntil), returns.
 */
export async function readThroughItem<T>(
  config: ReadThroughItemConfig<T>,
): Promise<T> {
  const {
    getItem,
    setItem,
    key,
    execute,
    serialize,
    deserialize,
    storeOptions,
    onHit,
    onStale,
    onMiss,
    onCached,
    host,
    wrapBackground,
  } = config;

  // Cache lookup. An infra read failure (getItem) is reported by the store
  // itself, so here we just degrade to a miss. A deserialize failure is a
  // corrupt/truncated stored entry, which this layer owns: report it LOUD as
  // cache-corrupt, then fall through to a fresh execution (the miss-path write
  // self-heals the bad entry).
  let cached: CacheItemResult | null = null;
  try {
    cached = await getItem(key);
  } catch {
    cached = null;
  }

  if (cached) {
    try {
      const data = await deserialize(cached.value);

      if (!cached.shouldRevalidate) {
        onHit?.(cached);
        return data;
      }

      // Stale hit — return stale data, revalidate in background
      onStale?.(cached);
      runBackground(
        host,
        async () => {
          try {
            // Re-establish the caller's context (request-context ALS) for the
            // detached background execution; the foreground miss below calls
            // execute() directly since its context is already established.
            const fresh = await (wrapBackground
              ? wrapBackground(execute)
              : execute());
            const serialized = await serialize(fresh);
            if (serialized !== null) {
              await setItem(key, serialized, storeOptions);
              onCached?.();
            }
          } catch (error) {
            reportCacheError(
              error,
              "stale-revalidation",
              "[read-through] background revalidation",
              host ?? undefined,
            );
          }
        },
        true,
      );
      return data;
    } catch (error) {
      reportCacheError(
        error,
        "cache-corrupt",
        "[read-through] deserialize stored entry",
        host ?? undefined,
      );
      // fall through to fresh execution
    }
  }

  // Cache miss
  onMiss?.();
  const data = await execute();

  // Non-blocking cache write (blocks when no waitUntil)
  await runBackground(
    host,
    async () => {
      try {
        const serialized = await serialize(data);
        if (serialized !== null) {
          await setItem(key, serialized, storeOptions);
          onCached?.();
        }
      } catch (error) {
        reportCacheError(
          error,
          "cache-write",
          "[read-through] cache write",
          host ?? undefined,
        );
      }
    },
    true,
  );

  return data;
}
