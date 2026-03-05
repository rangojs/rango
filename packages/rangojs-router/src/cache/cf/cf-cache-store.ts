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
  _getRequestContext,
  type RequestContext,
} from "../../server/request-context.js";
import { VERSION } from "@rangojs/router:version";
import {
  resolveTtl,
  resolveSwrWindow,
  DEFAULT_FUNCTION_TTL,
} from "../cache-policy.js";

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
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
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
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly namespace?: string;
  private readonly baseUrl: string;
  private readonly waitUntil?: (fn: () => Promise<void>) => void;
  private readonly version?: string;

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
    this.waitUntil = (fn) => options.ctx.waitUntil(fn());
  }

  /**
   * Derive base URL from request hostname via requestContext.
   * Uses internal fallback for dev/preview environments and untrusted hostnames.
   * @internal
   */
  private deriveBaseUrl(): string {
    const fallback = "https://rsc-cache.internal.com/";

    const ctx = _getRequestContext();
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
      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );

      const isStale = staleAt > 0 && Date.now() > staleAt;
      const isRevalidating =
        status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

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
        new Response(b1, { status: response.status, headers }),
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
    swr?: number,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
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
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = resolveSwrWindow(swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      // Clone and add cache headers
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));

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
   * Follows the same SWR pattern as get() for segment caching.
   */
  async getItem(key: string): Promise<CacheItemResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);
      const response = await cache.match(request);

      if (!response) return null;

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const status = response.headers.get(CACHE_STATUS_HEADER);
      const age = Number(response.headers.get("age") ?? "0");

      const isStale = staleAt > 0 && Date.now() > staleAt;
      const isRevalidating =
        status === "REVALIDATING" && age < MAX_REVALIDATION_INTERVAL;

      const data = (await response.json()) as {
        value: string;
        handles?: Record<string, Record<string, unknown[]>>;
      };

      if (!isStale || isRevalidating) {
        return {
          value: data.value,
          handles: data.handles,
          shouldRevalidate: false,
        };
      }

      // Stale and needs revalidation — mark REVALIDATING atomically
      const headers = new Headers(response.headers);
      headers.set(CACHE_STATUS_HEADER, "REVALIDATING");
      await cache.put(
        request,
        new Response(JSON.stringify(data), { status: 200, headers }),
      );

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

      const ttl = resolveTtl(options?.ttl, this.defaults, DEFAULT_FUNCTION_TTL);
      const swrWindow = resolveSwrWindow(options?.swr, this.defaults);
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;

      const body = JSON.stringify({ value, handles: options?.handles });
      const response = new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, max-age=${totalTtl}`,
          [CACHE_STALE_AT_HEADER]: String(staleAt),
          [CACHE_STATUS_HEADER]: "HIT",
        },
      });

      const putPromise = cache.put(request, response);

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
