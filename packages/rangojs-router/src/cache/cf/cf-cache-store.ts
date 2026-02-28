/// <reference path="../../vite/plugins/version.d.ts" />

// Extend CacheStorage with Cloudflare's default cache property
declare global {
  interface CacheStorage {
    readonly default: Cache;
  }
}

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
  CacheItemResult,
  CacheItemOptions,
} from "../types.js";
import {
  getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { VERSION } from "@rangojs/router:version";

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing comma-separated cache tags (CF's purge-by-tag API uses this) */
export const CACHE_TAGS_HEADER = "Cache-Tag";

/**
 * Maximum age in seconds for a revalidation lock before it expires.
 * After this period, a new revalidation attempt is allowed even if the
 * previous one hasn't completed (it may have failed silently).
 * @internal
 */
export const REVALIDATION_LOCK_TTL = 30;

// ============================================================================
// Types
// ============================================================================

/**
 * Cloudflare Workers ExecutionContext (subset we need)
 */
export interface ExecutionContext {
  waitUntil(promise: Promise<any>): void;
  passThroughOnException(): void;
}

export interface CFCacheStoreOptions<TEnv = unknown> {
  /**
   * Cache namespace. If not provided, uses caches.default (recommended).
   * Only set this if you need isolated cache storage.
   */
  namespace?: string;

  /**
   * Base URL for cache keys.
   *
   * If not provided, derives from request hostname via requestContext:
   * - Production domains → uses `https://{hostname}/`
   * - Dev/preview (localhost, workers.dev, pages.dev) → uses internal fallback URL
   */
  baseUrl?: string;

  /** Default cache options */
  defaults?: CacheDefaults;

  /**
   * Cloudflare ExecutionContext for non-blocking cache writes.
   * Pass the `ctx` from your worker's fetch handler.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx })
   * ```
   */
  ctx: ExecutionContext;

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
    defaultKey: string,
  ) => string | Promise<string>;

  /**
   * Callback invoked when revalidateTag() is called.
   * Runs asynchronously via waitUntil so it does not block the response.
   *
   * Use this to trigger global cache invalidation beyond the local colo,
   * e.g. calling Cloudflare's purge-by-tag API or updating a KV-based index.
   *
   * @example Using Cloudflare's Cache Purge API
   * ```typescript
   * onRevalidateTag: async (tags) => {
   *   await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`, {
   *     method: "POST",
   *     headers: { Authorization: `Bearer ${API_TOKEN}` },
   *     body: JSON.stringify({ tags }),
   *   });
   * }
   * ```
   */
  onRevalidateTag?: (tags: string[]) => Promise<void>;
}

// ============================================================================
// CFCacheStore Implementation
// ============================================================================

export class CFCacheStore<TEnv = unknown> implements SegmentCacheStore<TEnv> {
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly namespace?: string;
  private readonly baseUrl: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;
  private readonly onRevalidateTag?: (tags: string[]) => Promise<void>;

  constructor(options: CFCacheStoreOptions<TEnv>) {
    if (!options.ctx) {
      throw new Error(
        "[CFCacheStore] ExecutionContext (ctx) is required. " +
          "Pass the Cloudflare ExecutionContext from your worker's fetch handler: " +
          "new CFCacheStore({ ctx: env.ctx })",
      );
    }

    this.namespace = options.namespace;
    this.baseUrl = options.baseUrl ?? this.deriveBaseUrl();
    this.defaults = options.defaults;
    this.version = options.version ?? VERSION;
    this.keyGenerator = options.keyGenerator;
    this.onRevalidateTag = options.onRevalidateTag;
    this.waitUntil = (fn) => options.ctx.waitUntil(fn());
  }

  /**
   * Derive base URL from request hostname via requestContext.
   * Uses internal fallback for dev/preview environments and untrusted hostnames.
   * @internal
   */
  private deriveBaseUrl(): string {
    const fallback = "https://rsc-cache.internal.com/";

    const ctx = getRequestContext();
    if (!ctx?.request) {
      return fallback;
    }

    try {
      const url = new URL(ctx.request.url);
      const hostname = url.hostname;

      // Use fallback for dev/preview environments
      if (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname.endsWith(".workers.dev") ||
        hostname.endsWith(".pages.dev")
      ) {
        return fallback;
      }

      // Validate hostname: must be a valid domain (alphanumeric, hyphens, dots)
      // to prevent host header injection into cache keys
      if (!/^[a-zA-Z0-9.-]+$/.test(hostname) || hostname.length > 253) {
        return fallback;
      }

      // Use actual hostname for production
      return `https://${hostname}/`;
    } catch {
      return fallback;
    }
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
   * Check if a revalidation lock exists and is still fresh (< REVALIDATION_LOCK_TTL).
   * Returns true if another worker is already revalidating this key.
   * @internal
   */
  private async isRevalidating(cache: Cache, key: string): Promise<boolean> {
    try {
      const lockRes = await cache.match(
        this.keyToRequest(`__revalidation:${key}`),
      );
      if (!lockRes) return false;
      const timestamp = Number(await lockRes.text());
      if (Number.isNaN(timestamp)) return false;
      return Date.now() - timestamp < REVALIDATION_LOCK_TTL * 1000;
    } catch {
      return false;
    }
  }

  /**
   * Write a revalidation lock for the given key.
   * The lock auto-expires via Cache-Control max-age after REVALIDATION_LOCK_TTL
   * seconds, so failed revalidations don't permanently block retries.
   * @internal
   */
  private async markRevalidating(cache: Cache, key: string): Promise<void> {
    await cache.put(
      this.keyToRequest(`__revalidation:${key}`),
      new Response(String(Date.now()), {
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": `public, max-age=${REVALIDATION_LOCK_TTL}`,
        },
      }),
    );
  }

  /**
   * Get cached entry data by key.
   *
   * Handles SWR via a separate revalidation lock key:
   * - If fresh: returns data with shouldRevalidate: false
   * - If stale and lock exists (< 30s): another worker is revalidating, skip
   * - If stale and no lock (or lock expired): write lock, return shouldRevalidate: true
   *
   * The lock is a lightweight cache entry (`__revalidation:{key}`) with a short
   * TTL that auto-expires if the revalidation fails or takes too long.
   */
  async get(key: string): Promise<CacheGetResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return null;
      }

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const isStale = staleAt > 0 && Date.now() > staleAt;

      if (!isStale) {
        const data = (await response.json()) as CachedEntryData;
        return { data, shouldRevalidate: false };
      }

      // Stale: check if another worker is already revalidating
      if (await this.isRevalidating(cache, key)) {
        const data = (await response.json()) as CachedEntryData;
        return { data, shouldRevalidate: false };
      }

      // Claim revalidation by writing the lock
      await this.markRevalidating(cache, key);

      const data = (await response.json()) as CachedEntryData;
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
    swr?: number,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = swr ?? this.defaults?.swr ?? 0;
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${totalTtl}`,
        [CACHE_STALE_AT_HEADER]: String(staleAt),
      };
      if (data.tags?.length) {
        headers[CACHE_TAGS_HEADER] = data.tags.join(",");
      }

      const response = new Response(JSON.stringify(data), { headers });

      const lockRequest = this.keyToRequest(`__revalidation:${key}`);
      const putPromise = cache
        .put(request, response)
        .then(() => cache.delete(lockRequest));

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

  // ============================================================================
  // Document Cache Methods
  // ============================================================================

  /**
   * Get a cached Response by key (for document-level caching).
   * Returns the response and whether it should be revalidated (SWR).
   */
  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);
      const response = await cache.match(request);

      if (!response || response.status !== 200) {
        return null;
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const isStale = staleAt > 0 && Date.now() > staleAt;

      return {
        response,
        shouldRevalidate: isStale,
      };
    } catch (error) {
      console.error("[CFCacheStore] getResponse failed:", error);
      return null;
    }
  }

  /**
   * Store a Response with TTL and optional SWR window (for document-level caching).
   */
  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = swr ?? this.defaults?.swr ?? 0;
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      // Clone and add cache headers
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));
      if (tags?.length) {
        headers.set(CACHE_TAGS_HEADER, tags.join(","));
      }

      const toCache = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });

      const putPromise = cache.put(request, toCache);

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
      console.error("[CFCacheStore] putResponse failed:", error);
    }
  }

  // ============================================================================
  // Function Cache Methods (for "use cache" directive)
  // ============================================================================

  /**
   * Get a cached function result by key.
   * Follows the same revalidation lock pattern as get() for segment caching.
   */
  async getItem(key: string): Promise<CacheItemResult | null> {
    try {
      const cache = await this.getCache();
      const cacheKey = `fn:${key}`;
      const request = this.keyToRequest(cacheKey);
      const response = await cache.match(request);

      if (!response) return null;

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const isStale = staleAt > 0 && Date.now() > staleAt;

      const data = (await response.json()) as {
        value: string;
        handles?: Record<string, Record<string, unknown[]>>;
      };

      if (!isStale) {
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
        };
      }

      // Stale: check if another worker is already revalidating
      if (await this.isRevalidating(cache, cacheKey)) {
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
        };
      }

      // Claim revalidation by writing the lock
      await this.markRevalidating(cache, cacheKey);

      return {
        value: data.value,
        handles: data.handles,
        shouldRevalidate: true,
      };
    } catch (error) {
      console.error("[CFCacheStore] getItem failed:", error);
      return null;
    }
  }

  /**
   * Store a function result with TTL and optional SWR window.
   */
  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);

      const ttl = options?.ttl ?? this.defaults?.ttl ?? 900;
      const swrWindow = options?.swr ?? this.defaults?.swr ?? 0;
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const body = JSON.stringify({ value, handles: options?.handles });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${totalTtl}`,
        [CACHE_STALE_AT_HEADER]: String(staleAt),
      };
      if (options?.tags?.length) {
        headers[CACHE_TAGS_HEADER] = options.tags.join(",");
      }
      const response = new Response(body, { headers });

      const lockRequest = this.keyToRequest(`__revalidation:fn:${key}`);
      const putPromise = cache
        .put(request, response)
        .then(() => cache.delete(lockRequest));

      if (this.waitUntil) {
        this.waitUntil(async () => {
          await putPromise;
        });
      } else {
        await putPromise;
      }
    } catch (error) {
      console.error("[CFCacheStore] setItem failed:", error);
    }
  }

  /**
   * Invalidate cache entries tagged with the given tag.
   *
   * The CF Cache API has no built-in tag query/purge mechanism, so this
   * delegates to the `onRevalidateTag` callback provided in the store
   * options. The callback runs via waitUntil so it does not block the
   * response. Use it to call Cloudflare's purge-by-tag API, update a
   * KV-based index, or any custom invalidation logic.
   *
   * Tags are stored as `x-edge-cache-tags` headers on cached responses,
   * making them available for Cloudflare's Cache-Tag purge endpoint.
   */
  async revalidateTag(tag: string): Promise<void> {
    if (!this.onRevalidateTag) {
      console.warn(
        `[CFCacheStore] revalidateTag("${tag}") called but no onRevalidateTag ` +
          `callback is configured. Provide onRevalidateTag in CFCacheStoreOptions ` +
          `to handle tag-based cache invalidation (e.g., via Cloudflare's purge API).`,
      );
      return;
    }

    try {
      const callback = this.onRevalidateTag;
      if (this.waitUntil) {
        this.waitUntil(async () => {
          await callback([tag]);
        });
      } else {
        await callback([tag]);
      }
    } catch (error) {
      console.error("[CFCacheStore] revalidateTag failed:", error);
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
