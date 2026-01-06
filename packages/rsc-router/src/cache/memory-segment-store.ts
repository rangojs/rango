/**
 * In-Memory Segment Cache Store
 *
 * Simple in-memory implementation of SegmentCacheStore.
 * Uses globalThis to survive HMR in development.
 */

import type { SegmentCacheStore, CachedEntryData } from "./types.js";

const CACHE_GLOBAL_KEY = "__rsc_router_segment_cache_store__";

/**
 * In-memory segment cache store.
 *
 * Suitable for development and single-instance deployments.
 * For production with multiple instances, use a distributed store
 * like Cloudflare KV or Redis.
 *
 * @example
 * ```typescript
 * const store = new MemorySegmentCacheStore();
 *
 * createRSCHandler({
 *   router,
 *   cache: { store, ttl: 60 }
 * })
 * ```
 */
export class MemorySegmentCacheStore implements SegmentCacheStore {
  private cache: Map<string, CachedEntryData>;

  constructor() {
    // Use globalThis to survive HMR in development
    this.cache =
      (globalThis as any)[CACHE_GLOBAL_KEY] ??
      ((globalThis as any)[CACHE_GLOBAL_KEY] = new Map<string, CachedEntryData>());
  }

  async get(key: string): Promise<CachedEntryData | null> {
    const cached = this.cache.get(key);

    if (!cached) {
      return null;
    }

    // Check expiration
    if (Date.now() > cached.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return cached;
  }

  async set(key: string, data: CachedEntryData, ttl: number): Promise<void> {
    // Update expiresAt based on TTL
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
