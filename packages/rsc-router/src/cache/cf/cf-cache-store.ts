/// <reference path="../../vite/version.d.ts" />
/**
 * Cloudflare Edge Cache Store
 *
 * Production cache store using Cloudflare's Cache API.
 * Handles SWR atomically - get() checks staleness and marks REVALIDATING in one operation.
 *
 * Features:
 * - Extended TTL for SWR window (max-age = ttl + swr)
 * - Staleness via x-edge-cache-stale-at header
 * - Atomic REVALIDATING status for thundering herd prevention
 * - Non-blocking writes via waitUntil
 */

import type {
  SegmentCacheStore,
  CachedEntryData,
  CacheDefaults,
  CacheGetResult,
} from "../types.js";
import type { RequestContext } from "../../server/request-context.js";
import { VERSION } from "rsc-router:version";

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing cache status: HIT | REVALIDATING */
export const CACHE_STATUS_HEADER = "x-edge-cache-status";

/**
 * Maximum age in seconds for REVALIDATING status before allowing new revalidation.
 * After this period, a stale entry in REVALIDATING status will trigger revalidation again.
 * @internal
 */
export const MAX_REVALIDATION_INTERVAL = 30;

// ============================================================================
// Types
// ============================================================================

export interface CFCacheStoreOptions<TEnv = unknown> {
  /**
   * Cache namespace. If not provided, uses caches.default (recommended).
   * Only set this if you need isolated cache storage.
   */
  namespace?: string;

  /** Base URL for cache keys (default: 'https://rsc-cache.internal.com/') */
  baseUrl?: string;

  /** Default cache options */
  defaults?: CacheDefaults;

  /**
   * waitUntil function from request's ExecutionContext.
   * Used for non-blocking cache writes.
   */
  waitUntil?: (fn: () => Promise<void>) => void;

  /**
   * Cache version string override. When this changes, all cached entries are
   * effectively invalidated (new keys won't match old entries).
   *
   * Defaults to the auto-generated VERSION from `rsc-router:version` virtual module.
   * Only set this if you need a custom versioning strategy.
   */
  version?: string;

  /**
   * Custom key generator applied to all cache operations.
   * Receives the full RequestContext (including env) and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * @example Using headers for user segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings for multi-region
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale-aware caching
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = ctx.cookie('locale') || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string
  ) => string | Promise<string>;
}

/**
 * Cache status values for the x-edge-cache-status header.
 * @internal
 */
export type CacheStatus = "HIT" | "REVALIDATING";

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string
  ) => string | Promise<string>;

  private readonly namespace?: string;
  private readonly baseUrl: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;

  constructor(options: CFCacheStoreOptions<TEnv> = {}) {
    this.namespace = options.namespace;
    this.baseUrl = options.baseUrl ?? "https://rsc-cache.internal.com/";
    this.defaults = options.defaults;
    this.waitUntil = options.waitUntil;
    this.version = options.version ?? VERSION;
    this.keyGenerator = options.keyGenerator;
  }

  /**
   * Get the cache instance - uses caches.default unless namespace is specified.
   * @internal
   */
  private getCache(): Cache | Promise<Cache> {
    if (this.namespace) {
      return caches.open(this.namespace);
    }
    return caches.default;
  }

  /**
   * Get cached entry data by key.
   *
   * Handles SWR atomically:
   * - If stale and not already revalidating, marks as REVALIDATING and returns shouldRevalidate: true
   * - If already REVALIDATING (and recent), returns shouldRevalidate: false
   * - If fresh, returns shouldRevalidate: false
   *
   * The atomic mark prevents thundering herd - only first request triggers revalidation.
   */
  async get(key: string): Promise<CacheGetResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return null;
      }

      // Read status headers
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const age = Number(response.headers.get("age") ?? "0");
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) ?? "0");

      const isStale = staleAt > 0 && Date.now() > staleAt;
      const isRevalidating = status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

      // Case 1: Fresh or already being revalidated - just return data
      if (!isStale || isRevalidating) {
        const data = (await response.json()) as CachedEntryData;
        return { data, shouldRevalidate: false };
      }

      // Case 2: Stale and needs revalidation - atomically mark REVALIDATING
      const [b1, b2] = response.body!.tee();

      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");

      // Blocking write - must complete before returning to prevent race
      await cache.put(
        request,
        new Response(b1, { status: response.status, headers })
      );

      const data = (await new Response(b2).json()) as CachedEntryData;
      return { data, shouldRevalidate: true };
    } catch (error) {
      console.error("[CFCacheStore] get failed:", error);
      return null;
    }
  }

  /**
   * Store entry data with TTL and optional SWR window.
   * Uses waitUntil for non-blocking write when available.
   */
  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = swr ?? this.defaults?.swr ?? 0;
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const response = new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          [CACHE_STATUS_HEADER]: "HIT",
        },
      });

      const putPromise = cache.put(request, response);

      if (this.waitUntil) {
        // Non-blocking write
        this.waitUntil(async () => {
          await putPromise;
        });
      } else {
        // Blocking fallback
        await putPromise;
      }
    } catch (error) {
      console.error("[CFCacheStore] set failed:", error);
    }
  }

  /**
   * Delete a cached entry
   */
  async delete(key: string): Promise<boolean> {
    try {
      const cache = await this.getCache();
      return await cache.delete(this.keyToRequest(key));
    } catch (error) {
      console.error("[CFCacheStore] delete failed:", error);
      return false;
    }
  }

  /**
   * Convert string key to Request object for CF Cache API.
   * Includes version in URL if specified (for cache invalidation on code changes).
   * @internal
   */
  private keyToRequest(key: string): Request {
    const encodedKey = encodeURIComponent(key);
    // Include version in URL path to invalidate cache when version changes
    const versionPath = this.version ? `v/${this.version}/` : "";
    return new Request(`${this.baseUrl}${versionPath}${encodedKey}`, {
      method: "GET",
    });
  }
}
