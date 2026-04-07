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

interface WaitUntilHost {
  waitUntil?: (fn: () => Promise<void>) => void;
}

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
  } = config;

  // Cache lookup
  try {
    const cached = await getItem(key);

    if (cached) {
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
            const fresh = await execute();
            const serialized = await serialize(fresh);
            if (serialized !== null) {
              await setItem(key, serialized, storeOptions);
            }
          } catch {
            // Background revalidation failed silently
          }
        },
        true,
      );
      return data;
    }
  } catch {
    // Cache lookup failed, fall through to fresh execution
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
      } catch {
        // Cache write failed silently
      }
    },
    true,
  );

  return data;
}
