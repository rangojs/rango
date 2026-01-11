/**
 * In-Memory Segment Cache Store
 *
 * Simple in-memory implementation of SegmentCacheStore.
 * Uses globalThis to survive HMR in development.
 */

import type { SegmentCacheStore, CachedEntryData, CacheDefaults, CacheGetResult } from "./types.js";

const CACHE_GLOBAL_KEY = "__rsc_router_segment_cache_store__";

/**
 * Options for MemorySegmentCacheStore
 */
export interface MemorySegmentCacheStoreOptions {
  /**
   * Default cache options for cache() boundaries.
   * When cache() is called without explicit ttl/swr,
   * these defaults are used.
   *
   * @example
   * ```typescript
   * const store = new MemorySegmentCacheStore({
   *   defaults: { ttl: 60, swr: 300 }
   * });
   * ```
   */
  defaults?: CacheDefaults;
}

/**
 * In-memory segment cache store.
 *
 * Suitable for development and single-instance deployments.
 * For production with multiple instances, use a distributed store
 * like Cloudflare KV or Redis.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const store = new MemorySegmentCacheStore();
 *
 * // With defaults for cache() boundaries
 * const store = new MemorySegmentCacheStore({
 *   defaults: { ttl: 60 }
 * });
 *
 * createRSCHandler({
 *   router,
 *   cache: { store }
 * })
 * ```
 */
export class MemorySegmentCacheStore implements SegmentCacheStore {
  private cache: Map<string, CachedEntryData>;
  readonly defaults?: CacheDefaults;

  constructor(options?: MemorySegmentCacheStoreOptions) {
    // Use globalThis to survive HMR in development
    this.cache =
      (globalThis as any)[CACHE_GLOBAL_KEY] ??
      ((globalThis as any)[CACHE_GLOBAL_KEY] = new Map<string, CachedEntryData>());
    this.defaults = options?.defaults;
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check expiration
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Memory store doesn't support SWR - never triggers revalidation
    return { data: cached, shouldRevalidate: false };
  }

  async set(key: string, data: CachedEntryData, ttl: number, _swr?: number): Promise<void> {
    // Note: Memory store doesn't implement SWR - entries just expire at TTL
    // For SWR support, use CFCacheStore or similar distributed cache
    const entry: CachedEntryData = {
      ...data,
      expiresAt: Date.now() + ttl * 1000,
    };
    this.cache.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.cache.delete(key);
  }

  async clear(): Promise<void> {
    this.cache.clear();
  }

  /**
   * Get cache statistics (for debugging)
   */
  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }
}
