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

// ============================================================================
// Constants
// ============================================================================

/** Header storing timestamp when entry becomes stale */
export const CACHE_STALE_AT_HEADER = "x-edge-cache-stale-at";

/** Header storing comma-separated cache tags (CF's purge-by-tag API uses this) */
export const CACHE_TAGS_HEADER = "Cache-Tag";

/** Header storing when tags were attached to this cached entry */
export const CACHE_TAGGED_AT_HEADER = "x-edge-cache-tagged-at";

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

/**
 * Minimal KV-like interface used by the built-in tag invalidation store.
 */
export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete?(key: string): Promise<void>;
}

/**
 * Distributed tag invalidation state store for CFCacheStore.
 *
 * Stores only invalidation timestamps, not reverse key indexes.
 * Cached entries remain in Cache API until naturally evicted, but reads
 * treat them as misses once their tag invalidation timestamp is newer than
 * the entry's taggedAt timestamp.
 */
export interface CFTagInvalidationStore {
  /**
   * Return the latest invalidation timestamp across the given tags.
   * Returns null when none of the tags have been invalidated.
   */
  getLatestInvalidation(tags: string[]): Promise<number | null>;

  /**
   * Mark a tag invalidated at the given timestamp.
   */
  revalidateTag(tag: string, invalidatedAt: number): Promise<void>;
}

export interface CFKVTagInvalidationStoreOptions {
  /**
   * Prefix for KV keys used to track invalidation state.
   * @default "__rango_tag__:"
   */
  prefix?: string;

  /**
   * Optional TTL for invalidation markers in seconds.
   * Leave undefined to keep the marker indefinitely.
   */
  ttl?: number;
}

/**
 * KV-backed implementation of CFTagInvalidationStore.
 */
export class CFKVTagInvalidationStore implements CFTagInvalidationStore {
  private readonly prefix: string;
  private readonly ttl?: number;

  constructor(
    private readonly kv: KVNamespaceLike,
    options?: CFKVTagInvalidationStoreOptions,
  ) {
    this.prefix = options?.prefix ?? "__rango_tag__:";
    this.ttl = options?.ttl;
  }

  async getLatestInvalidation(tags: string[]): Promise<number | null> {
    if (tags.length === 0) return null;

    const values = await Promise.all(
      tags.map((tag) => this.kv.get(this.keyFor(tag))),
    );

    let latest: number | null = null;
    for (const value of values) {
      if (!value) continue;
      const timestamp = Number(value);
      if (Number.isNaN(timestamp)) continue;
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
    return latest;
  }

  async revalidateTag(tag: string, invalidatedAt: number): Promise<void> {
    if (this.ttl !== undefined) {
      await this.kv.put(this.keyFor(tag), String(invalidatedAt), {
        expirationTtl: this.ttl,
      });
      return;
    }
    await this.kv.put(this.keyFor(tag), String(invalidatedAt));
  }

  private keyFor(tag: string): string {
    return `${this.prefix}${tag}`;
  }
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
   * e.g. calling Cloudflare's purge-by-tag API after updating a distributed
   * tag invalidation store.
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

  /**
   * Optional distributed tag invalidation state.
   *
   * When provided, CFCacheStore will store `taggedAt` metadata on tagged
   * entries and treat them as misses once a newer invalidation timestamp is
   * observed for any of their tags. This provides global lazy invalidation
   * across colos without requiring immediate Cache API key enumeration.
   */
  tagInvalidationStore?: CFTagInvalidationStore;
}

export interface CFEdgeKVCacheStoreOptions<TEnv = unknown> extends Omit<
  CFCacheStoreOptions<TEnv>,
  "tagInvalidationStore"
> {
  /**
   * KV namespace used as the shared backing store.
   */
  kv: KVNamespaceLike;

  /**
   * Prefix for data entries written into KV.
   * @default "__rango_data__:"
   */
  dataPrefix?: string;

  /**
   * Optional distributed tag invalidation state.
   * Defaults to a CFKVTagInvalidationStore using the same KV namespace.
   */
  tagInvalidationStore?: CFTagInvalidationStore;

  /**
   * Options for the default CFKVTagInvalidationStore created from `kv`.
   */
  tagInvalidationOptions?: CFKVTagInvalidationStoreOptions;
}

interface KVSegmentEntry {
  data: CachedEntryData;
  staleAt: number;
  expiresAt: number;
}

interface KVItemEntry {
  value: string;
  handles?: Record<string, Record<string, unknown[]>>;
  tags?: string[];
  taggedAt?: number;
  staleAt: number;
  expiresAt: number;
}

interface KVResponseEntry {
  bodyBase64: string;
  status: number;
  statusText: string;
  headers: [string, string][];
  tags?: string[];
  taggedAt?: number;
  staleAt: number;
  expiresAt: number;
}

function getTaggedAt(tags: string[] | undefined): number | undefined {
  return tags && tags.length > 0 ? Date.now() : undefined;
}

async function isGloballyInvalidated(
  tagInvalidationStore: CFTagInvalidationStore | undefined,
  tags: string[] | undefined,
  taggedAt: number | undefined,
): Promise<boolean> {
  if (
    !tagInvalidationStore ||
    !tags ||
    tags.length === 0 ||
    taggedAt === undefined
  ) {
    return false;
  }

  const latest = await tagInvalidationStore.getLatestInvalidation(tags);
  return latest !== null && latest > taggedAt;
}

function getTtlParts(
  ttl: number,
  swr: number | undefined,
): { staleAt: number; expiresAt: number } {
  const staleAt = Date.now() + ttl * 1000;
  const expiresAt = staleAt + (swr ?? 0) * 1000;
  return { staleAt, expiresAt };
}

function getRemainingTtlParts(
  staleAt: number,
  expiresAt: number,
): { ttl: number; swr: number } | null {
  const now = Date.now();
  if (expiresAt <= now) return null;
  const ttl = Math.max(0, Math.ceil((staleAt - now) / 1000));
  const swr = Math.max(
    0,
    Math.ceil((expiresAt - Math.max(now, staleAt)) / 1000),
  );
  return { ttl, swr };
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(value, "base64"));
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function serializeResponseEntry(
  response: Response,
  staleAt: number,
  expiresAt: number,
  tags?: string[],
  taggedAt?: number,
): Promise<KVResponseEntry> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });

  return {
    bodyBase64: encodeBase64(bytes),
    status: response.status,
    statusText: response.statusText,
    headers,
    tags,
    taggedAt,
    staleAt,
    expiresAt,
  };
}

function deserializeResponseEntry(entry: KVResponseEntry): Response {
  const bytes = decodeBase64(entry.bodyBase64);
  return new Response(new Blob([bytes.buffer as ArrayBuffer]), {
    status: entry.status,
    statusText: entry.statusText,
    headers: new Headers(entry.headers),
  });
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
  private readonly tagInvalidationStore?: CFTagInvalidationStore;

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
    this.tagInvalidationStore = options.tagInvalidationStore;
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

      const data = (await response.json()) as CachedEntryData;
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          data.tags,
          data.taggedAt,
        )
      ) {
        await cache.delete(request).catch(() => false);
        return null;
      }

      const staleAt = Number(
        response.headers.get(CACHE_STALE_AT_HEADER) ?? "0",
      );
      const isStale = staleAt > 0 && Date.now() > staleAt;

      if (!isStale) {
        return { data, shouldRevalidate: false };
      }

      // Stale: check if another worker is already revalidating
      if (await this.isRevalidating(cache, key)) {
        return { data, shouldRevalidate: false };
      }

      // Claim revalidation by writing the lock
      await this.markRevalidating(cache, key);

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
      const taggedAt = data.taggedAt ?? getTaggedAt(data.tags);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${totalTtl}`,
        [CACHE_STALE_AT_HEADER]: String(staleAt),
      };
      const payload: CachedEntryData =
        taggedAt !== undefined ? { ...data, taggedAt } : data;
      if (data.tags?.length) {
        headers[CACHE_TAGS_HEADER] = data.tags.join(",");
      }
      if (taggedAt !== undefined) {
        headers[CACHE_TAGGED_AT_HEADER] = String(taggedAt);
      }

      const response = new Response(JSON.stringify(payload), { headers });

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
      const tagsHeader = response.headers.get(CACHE_TAGS_HEADER);
      const taggedAt = Number(
        response.headers.get(CACHE_TAGGED_AT_HEADER) ?? "",
      );
      const tags = tagsHeader
        ? tagsHeader
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        : undefined;
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          tags,
          Number.isNaN(taggedAt) ? undefined : taggedAt,
        )
      ) {
        await cache.delete(request).catch(() => false);
        return null;
      }

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
    taggedAt?: number,
  ): Promise<void> {
    try {
      const cache = await this.getCache();
      const request = this.keyToRequest(`doc:${key}`);

      // Extended TTL covers SWR window
      const swrWindow = swr ?? this.defaults?.swr ?? 0;
      const totalTtl = ttl + swrWindow;
      const staleAt = Date.now() + ttl * 1000;
      taggedAt ??= getTaggedAt(tags);

      // Clone and add cache headers
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", `public, max-age=${totalTtl}`);
      headers.set(CACHE_STALE_AT_HEADER, String(staleAt));
      if (tags?.length) {
        headers.set(CACHE_TAGS_HEADER, tags.join(","));
      }
      if (taggedAt !== undefined) {
        headers.set(CACHE_TAGGED_AT_HEADER, String(taggedAt));
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
        tags?: string[];
        taggedAt?: number;
      };
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          data.tags,
          data.taggedAt,
        )
      ) {
        await cache.delete(request).catch(() => false);
        return null;
      }

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
      const taggedAt =
        (options as CacheItemOptions & { taggedAt?: number })?.taggedAt ??
        getTaggedAt(options?.tags);

      const body = JSON.stringify({
        value,
        handles: options?.handles,
        tags: options?.tags,
        taggedAt,
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${totalTtl}`,
        [CACHE_STALE_AT_HEADER]: String(staleAt),
      };
      if (options?.tags?.length) {
        headers[CACHE_TAGS_HEADER] = options.tags.join(",");
      }
      if (taggedAt !== undefined) {
        headers[CACHE_TAGGED_AT_HEADER] = String(taggedAt);
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
    if (!this.onRevalidateTag && !this.tagInvalidationStore) {
      console.warn(
        `[CFCacheStore] revalidateTag("${tag}") called but no invalidation handler ` +
          `is configured. Provide tagInvalidationStore and/or onRevalidateTag in ` +
          `CFCacheStoreOptions to handle global tag invalidation.`,
      );
      return;
    }

    try {
      const invalidatedAt = Date.now();
      const callback = this.onRevalidateTag;
      const invalidationStore = this.tagInvalidationStore;
      const runInvalidation = async () => {
        if (invalidationStore) {
          await invalidationStore.revalidateTag(tag, invalidatedAt);
        }
        if (callback) {
          await callback([tag]);
        }
      };
      if (this.waitUntil) {
        this.waitUntil(async () => {
          await runInvalidation();
        });
      } else {
        await runInvalidation();
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

/**
 * Hybrid Cloudflare cache store with Cache API as L1 and KV as L2.
 *
 * Read path:
 * 1. Cache API lookup
 * 2. KV fallback on miss
 * 3. Repopulate edge from KV hit
 *
 * Global tag invalidation uses the same distributed invalidation state as
 * CFCacheStore, defaulting to a CFKVTagInvalidationStore over the same KV
 * namespace.
 */
export class CFEdgeKVCacheStore<
  TEnv = unknown,
> implements SegmentCacheStore<TEnv> {
  readonly defaults?: CacheDefaults;
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  private readonly edgeStore: CFCacheStore<TEnv>;
  private readonly kv: KVNamespaceLike;
  private readonly dataPrefix: string;
  private readonly version?: string;
  private readonly tagInvalidationStore: CFTagInvalidationStore;

  constructor(options: CFEdgeKVCacheStoreOptions<TEnv>) {
    this.defaults = options.defaults;
    this.keyGenerator = options.keyGenerator;
    this.kv = options.kv;
    this.dataPrefix = options.dataPrefix ?? "__rango_data__:";
    this.version = options.version ?? VERSION;
    this.tagInvalidationStore =
      options.tagInvalidationStore ??
      new CFKVTagInvalidationStore(options.kv, options.tagInvalidationOptions);

    this.edgeStore = new CFCacheStore<TEnv>({
      namespace: options.namespace,
      baseUrl: options.baseUrl,
      defaults: options.defaults,
      ctx: options.ctx,
      version: options.version,
      keyGenerator: options.keyGenerator,
      onRevalidateTag: options.onRevalidateTag,
      tagInvalidationStore: this.tagInvalidationStore,
    });
  }

  async get(key: string): Promise<CacheGetResult | null> {
    const edgeHit = await this.edgeStore.get(key);
    if (edgeHit) return edgeHit;

    try {
      const entry = await this.readKV<KVSegmentEntry>("seg", key);
      if (!entry) return null;
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          entry.data.tags,
          entry.data.taggedAt,
        )
      ) {
        await this.deleteKV("seg", key);
        return null;
      }
      if (Date.now() > entry.expiresAt) {
        await this.deleteKV("seg", key);
        return null;
      }

      const ttlParts = getRemainingTtlParts(entry.staleAt, entry.expiresAt);
      if (ttlParts) {
        await this.edgeStore.set(key, entry.data, ttlParts.ttl, ttlParts.swr);
      }

      return {
        data: entry.data,
        shouldRevalidate: Date.now() > entry.staleAt,
      };
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] get failed:", error);
      return null;
    }
  }

  async set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void> {
    try {
      const tags = data.tags;
      const taggedAt = getTaggedAt(tags);
      const withTaggedAt: CachedEntryData =
        taggedAt !== undefined ? { ...data, taggedAt } : data;
      const payload: KVSegmentEntry = {
        data: withTaggedAt,
        ...getTtlParts(ttl, swr),
      };
      await Promise.all([
        this.edgeStore.set(key, withTaggedAt, ttl, swr),
        this.writeKV("seg", key, payload, ttl + (swr ?? 0)),
      ]);
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] set failed:", error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const deleted = await this.edgeStore.delete(key);
      await this.deleteKV("seg", key);
      return deleted;
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] delete failed:", error);
      return false;
    }
  }

  async getResponse(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null> {
    const edgeHit = await this.edgeStore.getResponse?.(key);
    if (edgeHit) return edgeHit;

    try {
      const entry = await this.readKV<KVResponseEntry>("doc", key);
      if (!entry) return null;
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          entry.tags,
          entry.taggedAt,
        )
      ) {
        await this.deleteKV("doc", key);
        return null;
      }
      if (Date.now() > entry.expiresAt) {
        await this.deleteKV("doc", key);
        return null;
      }

      const response = deserializeResponseEntry(entry);
      const ttlParts = getRemainingTtlParts(entry.staleAt, entry.expiresAt);
      if (ttlParts && this.edgeStore.putResponse) {
        await this.edgeStore.putResponse(
          key,
          response.clone(),
          ttlParts.ttl,
          ttlParts.swr,
          entry.tags,
          entry.taggedAt,
        );
      }

      return {
        response,
        shouldRevalidate: Date.now() > entry.staleAt,
      };
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] getResponse failed:", error);
      return null;
    }
  }

  async putResponse(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void> {
    try {
      const { staleAt, expiresAt } = getTtlParts(ttl, swr);
      const taggedAt = getTaggedAt(tags);
      const edgeClone = response.clone();
      const payload = await serializeResponseEntry(
        response,
        staleAt,
        expiresAt,
        tags,
        taggedAt,
      );
      await Promise.all([
        this.edgeStore.putResponse?.(key, edgeClone, ttl, swr, tags, taggedAt),
        this.writeKV("doc", key, payload, ttl + (swr ?? 0)),
      ]);
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] putResponse failed:", error);
    }
  }

  async getItem(key: string): Promise<CacheItemResult | null> {
    const edgeHit = await this.edgeStore.getItem?.(key);
    if (edgeHit) return edgeHit;

    try {
      const entry = await this.readKV<KVItemEntry>("fn", key);
      if (!entry) return null;
      if (
        await isGloballyInvalidated(
          this.tagInvalidationStore,
          entry.tags,
          entry.taggedAt,
        )
      ) {
        await this.deleteKV("fn", key);
        return null;
      }
      if (Date.now() > entry.expiresAt) {
        await this.deleteKV("fn", key);
        return null;
      }

      const ttlParts = getRemainingTtlParts(entry.staleAt, entry.expiresAt);
      if (ttlParts && this.edgeStore.setItem) {
        await this.edgeStore.setItem(key, entry.value, {
          handles: entry.handles as CacheItemOptions["handles"],
          ttl: ttlParts.ttl,
          swr: ttlParts.swr,
          tags: entry.tags,
          taggedAt: entry.taggedAt,
        } as CacheItemOptions);
      }

      return {
        value: entry.value,
        handles: entry.handles as CacheItemResult["handles"],
        shouldRevalidate: Date.now() > entry.staleAt,
      };
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] getItem failed:", error);
      return null;
    }
  }

  async setItem(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void> {
    try {
      const ttl = options?.ttl ?? this.defaults?.ttl ?? 900;
      const swr = options?.swr ?? this.defaults?.swr ?? 0;
      const tags = options?.tags;
      const taggedAt = getTaggedAt(tags);
      const payload: KVItemEntry = {
        value,
        handles: options?.handles as KVItemEntry["handles"],
        tags,
        taggedAt,
        ...getTtlParts(ttl, swr),
      };
      await Promise.all([
        this.edgeStore.setItem?.(key, value, {
          ...options,
          taggedAt,
        } as CacheItemOptions),
        this.writeKV("fn", key, payload, ttl + swr),
      ]);
    } catch (error) {
      console.error("[CFEdgeKVCacheStore] setItem failed:", error);
    }
  }

  async revalidateTag(tag: string): Promise<void> {
    await this.edgeStore.revalidateTag(tag);
  }

  private async readKV<T>(
    kind: "seg" | "doc" | "fn",
    key: string,
  ): Promise<T | null> {
    const raw = await this.kv.get(this.kvKey(kind, key));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  }

  private async writeKV(
    kind: "seg" | "doc" | "fn",
    key: string,
    value: unknown,
    ttl: number,
  ): Promise<void> {
    await this.kv.put(this.kvKey(kind, key), JSON.stringify(value), {
      expirationTtl: Math.max(1, Math.ceil(ttl)),
    });
  }

  private async deleteKV(
    kind: "seg" | "doc" | "fn",
    key: string,
  ): Promise<void> {
    await this.kv.delete?.(this.kvKey(kind, key));
  }

  private kvKey(kind: "seg" | "doc" | "fn", key: string): string {
    const versionPrefix = this.version ? `v/${this.version}/` : "";
    return `${this.dataPrefix}${versionPrefix}${kind}:${key}`;
  }
}
