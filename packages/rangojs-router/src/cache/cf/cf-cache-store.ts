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
 * Production cache store using Cloudflare's Cache API (L1) with optional
 * KV persistence (L2).
 *
 * L1 (Cache API): Per-colo, fast, ephemeral. Handles SWR atomically.
 * L2 (KV): Global, persistent, ~50ms reads. Auto-warms cold colos.
 *
 * Read flow:  L1 hit → serve | L1 miss → L2 hit → serve + promote to L1 | both miss → render
 * Write flow: L1 write + L2 write (both via waitUntil)
 *
 * Features:
 * - Extended TTL for SWR window (max-age = ttl + swr)
 * - Staleness via x-edge-cache-stale-at header
 * - Atomic REVALIDATING status for thundering herd prevention (L1 only)
 * - Non-blocking writes via waitUntil
 * - KV L2 for cross-colo cache persistence
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
 * Header stashing the route author's original Cache-Control on L1 document
 * entries. putResponse/promoteResponseToL1 overwrite Cache-Control with a long
 * `max-age` so the CF Cache API retains the entry across the whole SWR window;
 * getResponse restores this original value before serving so the client and any
 * upstream CDN see the author's intended directive, not the internal edge TTL.
 */
const CACHE_ORIG_CC_HEADER = "x-edge-cache-orig-cc";

/**
 * Maximum age in seconds for REVALIDATING status before allowing new revalidation.
 * After this period, a stale entry in REVALIDATING status will trigger revalidation again.
 * @internal
 */
export const MAX_REVALIDATION_INTERVAL = 30;

// ============================================================================
// Types
// ============================================================================

// Re-exported from the canonical home so cf-cache-store consumers keep
// importing `ExecutionContext` from this module without a second interface
// drifting over time.
export type { ExecutionContext } from "../../types/request-scope.js";
import type { ExecutionContext } from "../../types/request-scope.js";

/**
 * Minimal Cloudflare KV Namespace interface.
 * Avoids hard dependency on @cloudflare/workers-types.
 */
export interface KVNamespace {
  get(key: string, options?: { type?: string }): Promise<any>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * KV envelope for segment cache entries.
 * @internal
 */
interface KVSegmentEnvelope {
  /** Cached segment data */
  d: CachedEntryData;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
}

/**
 * KV envelope for function cache entries ("use cache").
 * @internal
 */
interface KVItemEnvelope {
  /** RSC-serialized return value */
  v: string;
  /** RSC-encoded handle data (see handle-snapshot.ts encodeHandles) */
  h?: string;
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
}

/**
 * KV envelope for document cache entries.
 * @internal
 */
interface KVResponseEnvelope {
  /** Response body as base64-encoded string (safe for binary payloads) */
  b: string;
  /** HTTP status code */
  st: number;
  /** HTTP status text */
  stx: string;
  /** Serialized headers as key-value pairs */
  hd: [string, string][];
  /** When entry becomes stale (ms epoch) */
  s: number;
  /** When entry hard-expires (ms epoch) */
  e: number;
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
   * Optional KV namespace for L2 cache persistence.
   *
   * When provided, KV acts as a global fallback behind the per-colo Cache API.
   * On L1 miss, KV is checked and hits are promoted back to L1.
   * On writes, data is persisted to both L1 and KV.
   *
   * @example
   * ```typescript
   * new CFCacheStore({ ctx: env.ctx, kv: env.CACHE_KV })
   * ```
   */
  kv?: KVNamespace;

  /**
   * Cache version string override. When this changes, all cached entries are
   * effectively invalidated (new keys won't match old entries).
   *
   * Defaults to the auto-generated VERSION from the `@rangojs/router:version` virtual module.
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
  private readonly kv?: KVNamespace;

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
    this.kv = options.kv;
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

  // ============================================================================
  // Segment Cache Methods
  // ============================================================================

  /**
   * Get cached entry data by key.
   *
   * Handles SWR atomically:
   * - If stale and not already revalidating, marks as REVALIDATING and returns shouldRevalidate: true
   * - If already REVALIDATING (and recent), returns shouldRevalidate: false
   * - If fresh, returns shouldRevalidate: false
   *
   * On L1 miss, falls back to KV (L2) if configured.
   * KV hits are promoted to L1 in the background.
   */
  async get(key: string): Promise<CacheGetResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(key);
      const response = await cache.match(request);

      if (!response) {
        return this.kvGetSegment(key);
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
   * When KV is configured, also persists to L2.
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

      const body = JSON.stringify(data);
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
        // Non-blocking write
        this.waitUntil(async () => {
          await putPromise;
        });
      } else {
        // Blocking fallback
        await putPromise;
      }

      // L2: persist to KV
      this.kvSetSegment(key, data, staleAt, totalTtl, swrWindow);
    } catch (error) {
      console.error("[CFCacheStore] set failed:", error);
    }
  }

  /**
   * Delete a cached entry from L1 and L2.
   */
  async delete(key: string): Promise<boolean> {
    try {
      const cache = await this.getCache();
      const result = await cache.delete(this.keyToRequest(key));

      // L2: delete from KV
      if (this.kv && this.waitUntil) {
        const kvKey = this.toKVKey(key);
        this.waitUntil(async () => {
          try {
            await this.kv!.delete(kvKey);
          } catch {
            // KV delete failures are non-critical
          }
        });
      }

      return result;
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
   * Falls back to KV (L2) on L1 miss.
   */
  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);
      const response = await cache.match(request);

      if (!response || response.status !== 200) {
        return this.kvGetResponse(key);
      }

      // Check staleness
      const staleAt = Number(response.headers.get(CACHE_STALE_AT_HEADER) || 0);
      const isStale = staleAt > 0 && Date.now() > staleAt;

      return {
        response: this.toClientResponse(response),
        shouldRevalidate: isStale,
      };
    } catch (error) {
      console.error("[CFCacheStore] getResponse failed:", error);
      return null;
    }
  }

  /**
   * Strip internal edge headers and restore the author's Cache-Control before a
   * cached document Response is served to a client. L1 entries carry the
   * internal staleness/status headers and a rewritten Cache-Control; none of
   * those should reach the browser or an upstream CDN.
   */
  private toClientResponse(response: Response): Response {
    const headers = new Headers(response.headers);
    const originalCacheControl = headers.get(CACHE_ORIG_CC_HEADER);
    if (originalCacheControl !== null) {
      headers.set("Cache-Control", originalCacheControl);
    } else {
      headers.delete("Cache-Control");
    }
    headers.delete(CACHE_ORIG_CC_HEADER);
    headers.delete(CACHE_STALE_AT_HEADER);
    headers.delete(CACHE_STATUS_HEADER);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * Store a Response with TTL and optional SWR window (for document-level caching).
   * When KV is configured, also persists to L2.
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

      // Clone body for potential KV write before consuming it for L1
      const [l1Body, kvBody] = this.kv
        ? response.body
          ? response.body.tee()
          : [null, null]
        : [response.body, null];

      // Clone and add cache headers. The author's Cache-Control is stashed and
      // replaced with a long max-age so the CF Cache API holds the entry across
      // the SWR window; getResponse restores the original before serving.
      const headers = new Headers(response.headers);
      const originalCacheControl = response.headers.get("Cache-Control");
      if (originalCacheControl !== null) {
        headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
      }
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));

      const toCache = new Response(l1Body, {
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

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`doc:${key}`);
        const headersArray: [string, string][] = [];
        response.headers.forEach((v, k) => headersArray.push([k, v]));
        // Read body as ArrayBuffer and encode to base64 to preserve binary payloads
        const bodyBuf = kvBody
          ? await new Response(kvBody).arrayBuffer()
          : new ArrayBuffer(0);
        const bodyBase64 = bufferToBase64(bodyBuf);

        this.waitUntil(async () => {
          try {
            const envelope: KVResponseEnvelope = {
              b: bodyBase64,
              st: response.status,
              stx: response.statusText,
              hd: headersArray,
              s: staleAt,
              e: staleAt + swrWindow * 1000,
            };
            await this.kv!.put(kvKey, JSON.stringify(envelope), {
              expirationTtl: totalTtl,
            });
          } catch (error) {
            console.error("[CFCacheStore] KV putResponse failed:", error);
          }
        });
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
   * Falls back to KV (L2) on L1 miss.
   */
  async getItem(key: string): Promise<CacheItemResult | null> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`fn:${key}`);
      const response = await cache.match(request);

      if (!response) return this.kvGetItem(key);

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
        handles?: string;
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
   * When KV is configured, also persists to L2.
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

      // L2: persist to KV (KV requires expirationTtl >= 60s)
      if (this.kv && this.waitUntil && totalTtl >= 60) {
        const kvKey = this.toKVKey(`fn:${key}`);
        this.waitUntil(async () => {
          try {
            const envelope: KVItemEnvelope = {
              v: value,
              h: options?.handles,
              s: staleAt,
              e: staleAt + swrWindow * 1000,
            };
            await this.kv!.put(kvKey, JSON.stringify(envelope), {
              expirationTtl: totalTtl,
            });
          } catch (error) {
            console.error("[CFCacheStore] KV setItem failed:", error);
          }
        });
      }
    } catch (error) {
      console.error("[CFCacheStore] setItem failed:", error);
    }
  }

  // ============================================================================
  // Key Helpers
  // ============================================================================

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

  /**
   * Convert string key to KV key string.
   * Uses same version prefix as Cache API for consistent invalidation.
   * @internal
   */
  private toKVKey(key: string): string {
    const versionPath = this.version ? `v/${this.version}/` : "";
    return `${versionPath}${key}`;
  }

  // ============================================================================
  // KV L2 Helpers
  // ============================================================================

  /**
   * KV fallback for segment cache reads.
   * Returns null if KV is not configured, entry is missing, or expired.
   * Promotes hits to L1 via waitUntil.
   * @internal
   */
  private async kvGetSegment(key: string): Promise<CacheGetResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(key);
      const raw = await this.kv.get(kvKey, { type: "json" });
      if (!raw) return null;

      const envelope = raw as KVSegmentEnvelope;
      const now = Date.now();

      // Hard-expired — treat as miss
      if (now > envelope.e) return null;

      const shouldRevalidate = now > envelope.s;

      // Promote to L1 in background
      this.promoteSegmentToL1(key, envelope);

      return { data: envelope.d, shouldRevalidate };
    } catch (error) {
      console.error("[CFCacheStore] KV get failed:", error);
      return null;
    }
  }

  /**
   * Write segment data to KV.
   * @internal
   */
  private kvSetSegment(
    key: string,
    data: CachedEntryData,
    staleAt: number,
    totalTtl: number,
    swrWindow: number,
  ): void {
    // KV requires expirationTtl >= 60s. Skip write for short-lived entries.
    if (!this.kv || !this.waitUntil || totalTtl < 60) return;

    const kvKey = this.toKVKey(key);
    const expiresAt = staleAt + swrWindow * 1000;

    this.waitUntil(async () => {
      try {
        const envelope: KVSegmentEnvelope = {
          d: data,
          s: staleAt,
          e: expiresAt,
        };
        await this.kv!.put(kvKey, JSON.stringify(envelope), {
          expirationTtl: totalTtl,
        });
      } catch (error) {
        console.error("[CFCacheStore] KV set failed:", error);
      }
    });
  }

  /**
   * Promote segment data from KV to L1 Cache API.
   * @internal
   */
  private promoteSegmentToL1(key: string, envelope: KVSegmentEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(key);

        const response = new Response(JSON.stringify(envelope.d), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${remainingTtl}`,
            [CACHE_STALE_AT_HEADER]: String(envelope.s),
            [CACHE_STATUS_HEADER]: "HIT",
          },
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 promote failed:", error);
      }
    });
  }

  /**
   * KV fallback for function cache reads.
   * @internal
   */
  private async kvGetItem(key: string): Promise<CacheItemResult | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`fn:${key}`);
      const raw = await this.kv.get(kvKey, { type: "json" });
      if (!raw) return null;

      const envelope = raw as KVItemEnvelope;
      const now = Date.now();

      if (now > envelope.e) return null;

      const shouldRevalidate = now > envelope.s;

      // Promote to L1
      this.promoteItemToL1(key, envelope);

      return {
        value: envelope.v,
        handles: envelope.h,
        shouldRevalidate,
      };
    } catch (error) {
      console.error("[CFCacheStore] KV getItem failed:", error);
      return null;
    }
  }

  /**
   * Promote function cache data from KV to L1.
   * @internal
   */
  private promoteItemToL1(key: string, envelope: KVItemEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(`fn:${key}`);

        const body = JSON.stringify({ value: envelope.v, handles: envelope.h });
        const response = new Response(body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${remainingTtl}`,
            [CACHE_STALE_AT_HEADER]: String(envelope.s),
            [CACHE_STATUS_HEADER]: "HIT",
          },
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 item promote failed:", error);
      }
    });
  }

  /**
   * KV fallback for document cache reads.
   * @internal
   */
  private async kvGetResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    if (!this.kv) return null;

    try {
      const kvKey = this.toKVKey(`doc:${key}`);
      const raw = await this.kv.get(kvKey, { type: "json" });
      if (!raw) return null;

      const envelope = raw as KVResponseEnvelope;
      const now = Date.now();

      if (now > envelope.e) return null;

      const shouldRevalidate = now > envelope.s;

      // Reconstruct Response (decode base64 → binary)
      const headers = new Headers(envelope.hd);
      const bodyBuffer = base64ToBuffer(envelope.b);
      const response = new Response(bodyBuffer, {
        status: envelope.st,
        statusText: envelope.stx,
        headers,
      });

      // Promote to L1
      this.promoteResponseToL1(key, envelope);

      return { response, shouldRevalidate };
    } catch (error) {
      console.error("[CFCacheStore] KV getResponse failed:", error);
      return null;
    }
  }

  /**
   * Promote document cache data from KV to L1.
   * @internal
   */
  private promoteResponseToL1(key: string, envelope: KVResponseEnvelope): void {
    if (!this.waitUntil) return;

    this.waitUntil(async () => {
      try {
        const now = Date.now();
        const remainingTtl = Math.max(1, Math.floor((envelope.e - now) / 1000));
        const cache = await this.getCache();
        const request = this.keyToRequest(`doc:${key}`);

        const headers = new Headers(envelope.hd);
        const originalCacheControl = headers.get("Cache-Control");
        if (originalCacheControl !== null) {
          headers.set(CACHE_ORIG_CC_HEADER, originalCacheControl);
        }
        headers.set("Cache-Control", `public, max-age=${remainingTtl}`);
        headers.set(CACHE_STALE_AT_HEADER, String(envelope.s));

        const bodyBuffer = base64ToBuffer(envelope.b);
        const response = new Response(bodyBuffer, {
          status: envelope.st,
          statusText: envelope.stx,
          headers,
        });

        await cache.put(request, response);
      } catch (error) {
        console.error("[CFCacheStore] L1 response promote failed:", error);
      }
    });
  }
}

// ============================================================================
// Base64 Helpers (binary-safe response body encoding for KV)
// ============================================================================

/** Encode ArrayBuffer to base64 string. */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/** Decode base64 string to ArrayBuffer. */
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
