/**
 * Cloudflare Edge Cache Store
 *
 * Production cache store using Cloudflare's Cache API.
 * Uses response headers for staleness tracking (no JSON parsing needed for stale check).
 *
 * Features:
 * - Extended TTL for SWR window (max-age = ttl + swr)
 * - Staleness via x-edge-cache-stale-at header
 * - REVALIDATING status for thundering herd prevention
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing cache status: HIT | REVALIDATING */
export const CACHE_STATUS_HEADER = "x-edge-cache-status";

/** Maximum age in seconds for REVALIDATING status before allowing new revalidation */
export const MAX_REVALIDATION_INTERVAL = 30;

// ============================================================================
// Types
// ============================================================================

export interface CFCacheStoreOptions {
  /** Cache namespace (default: 'rsc-segments') */
  namespace?: string;

  /** Base URL for cache keys (default: 'https://rsc-cache.internal.com/') */
  baseUrl?: string;

  /** Default cache options */
  defaults?: CacheDefaults;
}

export type CacheStatus = "HIT" | "REVALIDATING";

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore implements SegmentCacheStore {
  readonly defaults?: CacheDefaults;

  private readonly namespace: string;
  private readonly baseUrl: string;

  constructor(options: CFCacheStoreOptions = {}) {
    this.namespace = options.namespace ?? "rsc-segments";
    this.baseUrl = options.baseUrl ?? "https://rsc-cache.internal.com/";
    this.defaults = options.defaults;
  }

  /**
   * Get cached entry data by key
   * Returns { data, stale } or null if not found/hard-expired
   */
  async get(key: string): Promise<CacheGetResult | null> {
    try {
      const cache = await caches.open(this.namespace);
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return null;
      }

      // Check if already revalidating - if so, don't mark as stale again
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const age = Number(response.headers.get("age") ?? "0");
      const isRevalidating = status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

      // Check staleness from header (fast, no JSON parse needed)
      const staleAtStr = response.headers.get(CACHE_STALE_AT_HEADER);
      const staleAt = staleAtStr ? Number(staleAtStr) : 0;
      const isPastStaleTime = Date.now() > staleAt;

      // Stale = past stale time AND not already being revalidated
      const stale = isPastStaleTime && !isRevalidating;

      // Parse JSON body for actual data
      const data = (await response.json()) as CachedEntryData;

      return { data, stale };
    } catch (error) {
      // Log but don't throw - treat as cache miss
      console.error("[CFCacheStore] get failed:", error);
      return null;
    }
  }

  /**
   * Mark entry as REVALIDATING to prevent thundering herd
   * Fetches current entry and updates its status header
   */
  async markRevalidating(key: string): Promise<void> {
    try {
      const cache = await caches.open(this.namespace);
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return; // Entry no longer exists
      }

      // Clone headers and update status
      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");

      // Re-read body and store with updated status
      const body = await response.text();
      await cache.put(
        request,
        new Response(body, {
          status: response.status,
          headers,
        })
      );
    } catch (error) {
      console.error("[CFCacheStore] markRevalidating failed:", error);
    }
  }

  /**
   * Store entry data with TTL and optional SWR window
   */
  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number
  ): Promise<void> {
    try {
      const cache = await caches.open(this.namespace);
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const totalTtl = ttl + (swr ?? this.defaults?.swr ?? 0);
      const staleAt = Date.now() + ttl * 1000;

      const response = new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          [CACHE_STATUS_HEADER]: "HIT",
        },
      });

      await cache.put(request, response);
    } catch (error) {
      // Log but don't throw - cache write failure shouldn't fail request
      console.error("[CFCacheStore] set failed:", error);
    }
  }

  /**
   * Delete a cached entry
   */
  async delete(key: string): Promise<boolean> {
    try {
      const cache = await caches.open(this.namespace);
      return await cache.delete(this.keyToRequest(key));
    } catch (error) {
      console.error("[CFCacheStore] delete failed:", error);
      return false;
    }
  }

  /**
   * Convert string key to Request object for CF Cache API
   */
  private keyToRequest(key: string): Request {
    // URL-encode the key to handle special characters
    const encodedKey = encodeURIComponent(key);
    return new Request(`${this.baseUrl}${encodedKey}`, {
      method: "GET",
    });
  }
}
