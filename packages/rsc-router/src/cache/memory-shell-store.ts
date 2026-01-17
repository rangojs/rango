/**
 * Memory Shell Cache Store
 *
 * In-memory implementation of ShellCacheStore with TTL and SWR support.
 * Suitable for development and single-instance deployments.
 */

import type {
  ShellCacheStore,
  ShellCacheEntry,
  ShellCacheResult,
  ShellCacheDefaults,
} from "./shell-cache-store.js";

/**
 * Internal cache entry with expiration tracking.
 */
interface CacheEntry {
  entry: ShellCacheEntry;
  /** Timestamp when entry expires (ms since epoch) */
  expiresAt: number;
  /** Timestamp when SWR window expires (ms since epoch) */
  swrExpiresAt: number;
}

/**
 * Configuration options for MemoryShellCacheStore.
 */
export interface MemoryShellCacheStoreOptions {
  /**
   * Default TTL/SWR options.
   * Used when not specified in set() calls.
   */
  defaults?: ShellCacheDefaults;
  /**
   * Maximum number of entries to cache.
   * When exceeded, oldest entries are evicted.
   * Default: 1000
   */
  maxEntries?: number;
}

/**
 * In-memory shell cache store with TTL and SWR support.
 *
 * @example Basic usage
 * ```typescript
 * const store = new MemoryShellCacheStore({
 *   defaults: { ttl: 60, swr: 300 }
 * });
 * ```
 *
 * @example With max entries limit
 * ```typescript
 * const store = new MemoryShellCacheStore({
 *   defaults: { ttl: 60 },
 *   maxEntries: 500
 * });
 * ```
 */
export class MemoryShellCacheStore implements ShellCacheStore {
  private cache = new Map<string, CacheEntry>();
  private maxEntries: number;
  readonly defaults: ShellCacheDefaults;

  constructor(options: MemoryShellCacheStoreOptions = {}) {
    this.defaults = {
      ttl: options.defaults?.ttl ?? 60,
      swr: options.defaults?.swr ?? 0,
    };
    this.maxEntries = options.maxEntries ?? 1000;
  }

  async get(key: string): Promise<ShellCacheResult | null> {
    const cached = this.cache.get(key);
    if (!cached) {
      return null;
    }

    const now = Date.now();

    // Check if completely expired (past SWR window)
    if (now >= cached.swrExpiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Determine if fresh or stale
    const status = now < cached.expiresAt ? "fresh" : "stale";

    return {
      entry: cached.entry,
      status,
    };
  }

  async set(
    key: string,
    entry: ShellCacheEntry,
    ttl: number,
    swr?: number
  ): Promise<void> {
    const now = Date.now();
    const ttlMs = ttl * 1000;
    const swrMs = (swr ?? 0) * 1000;

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      this.evictOldest();
    }

    this.cache.set(key, {
      entry: {
        ...entry,
        staleAt: entry.staleAt ?? now + ttlMs,
      },
      expiresAt: now + ttlMs,
      swrExpiresAt: now + ttlMs + swrMs,
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Get current cache size (for testing/debugging).
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Evict oldest entry from cache.
   */
  private evictOldest(): void {
    // Map maintains insertion order, so first entry is oldest
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.cache.delete(firstKey);
    }
  }

  /**
   * Remove expired entries (optional cleanup).
   * Can be called periodically to free memory.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now >= entry.swrExpiresAt) {
        this.cache.delete(key);
      }
    }
  }
}
