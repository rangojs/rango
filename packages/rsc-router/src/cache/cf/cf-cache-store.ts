/**
 * Cloudflare Edge Cache Store
 *
 * Production cache store using Cloudflare's Cache API.
 * Uses response headers for staleness tracking (no JSON parsing needed).
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

export interface CacheGetResult {
  data: CachedEntryData;
  stale: boolean;
  /** Response object for body tee-ing when marking REVALIDATING */
  response: Response;
}

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
   * Returns null if not found or hard-expired
   */
  async get(key: string): Promise<CachedEntryData | null> {
    const result = await this.getWithMeta(key);
    return result?.data ?? null;
  }

  /**
   * Get cached entry with staleness metadata
   * Used internally for SWR logic
   */
  async getWithMeta(key: string): Promise<CacheGetResult | null> {
    try {
      const cache = await caches.open(this.namespace);
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return null;
      }

      // Check staleness from header (fast, no JSON parse needed)
      const staleAtStr = response.headers.get(CACHE_STALE_AT_HEADER);
      const staleAt = staleAtStr ? Number(staleAtStr) : 0;
      const stale = Date.now() > staleAt;

      // Parse JSON body for actual data
      const data = (await response.clone().json()) as CachedEntryData;

      return { data, stale, response };
    } catch (error) {
      // Log but don't throw - treat as cache miss
      console.error("[CFCacheStore] get failed:", error);
      return null;
    }
  }

  /**
   * Check if entry should be revalidated
   * Returns false if already revalidating (thundering herd prevention)
   */
  shouldRevalidate(response: Response): boolean {
    const status = response.headers.get(CACHE_STATUS_HEADER);
    const age = Number(response.headers.get("age") ?? "0");

    // Already revalidating and recent - skip
    if (status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL) {
      return false;
    }

    // Check if stale
    const staleAtStr = response.headers.get(CACHE_STALE_AT_HEADER);
    const staleAt = staleAtStr ? Number(staleAtStr) : 0;
    return Date.now() > staleAt;
  }

  /**
   * Mark entry as REVALIDATING to prevent thundering herd
   * Returns cloned body stream for reading data
   */
  async markRevalidating(key: string, response: Response): Promise<Response> {
    try {
      const [b1, b2] = response.body!.tee();
      const cache = await caches.open(this.namespace);

      // Clone headers and update status
      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");

      // Update cache with REVALIDATING status
      await cache.put(
        this.keyToRequest(key),
        new Response(b1, {
          status: response.status,
          headers,
        })
      );

      // Return new response with b2 for reading
      return new Response(b2, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      console.error("[CFCacheStore] markRevalidating failed:", error);
      // Return original response on error
      return response;
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
