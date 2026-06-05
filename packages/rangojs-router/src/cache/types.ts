/**
 * Cache Store Types
 *
 * Generic caching interface supporting multiple value types.
 * Designed to be implemented by different backends:
 * - MemoryCacheStore (dev/testing)
 * - Cloudflare Cache API adapter
 * - Cloudflare KV adapter
 * - Redis adapter
 */

import type { ResolvedSegment } from "../types.js";
import type { RequestContext } from "../server/request-context.js";

// ============================================================================
// Segment Cache Store (low-level storage interface)
// ============================================================================

/**
 * Result from cache get() including data and revalidation status
 */
export interface CacheGetResult {
  /** The cached entry data */
  data: CachedEntryData;
  /**
   * Whether the caller should trigger background revalidation.
   * True when entry is stale AND not already being revalidated.
   * The store atomically marks the entry as REVALIDATING when returning true.
   */
  shouldRevalidate: boolean;
}

/**
 * Low-level segment cache store interface.
 *
 * Implementations handle the actual storage (memory, KV, Redis, etc.).
 * The store deals with serialized data - RSC serialization is handled
 * by the cache provider layer.
 *
 * @typeParam TEnv - Platform bindings type (e.g., Cloudflare env)
 */
export interface SegmentCacheStore<TEnv = unknown> {
  /**
   * Default cache options for this store.
   * Used by cache() boundaries when ttl/swr are not explicitly specified.
   */
  readonly defaults?: CacheDefaults;

  /**
   * Custom key generator applied to all cache operations using this store.
   * Receives the full RequestContext and the default-generated key.
   * Return value becomes the final cache key (unless route overrides with `key` option).
   *
   * Resolution priority:
   * 1. Route-level `key` function (full override)
   * 2. Store-level `keyGenerator` (modifies default key)
   * 3. Default key generation (prefix:pathname:params)
   *
   * @example Using headers for cache segmentation
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const segment = ctx.request.headers.get('x-user-segment') || 'default';
   *   return `${segment}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using env bindings (Cloudflare)
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const region = ctx.env.REGION || 'us';
   *   return `${region}:${defaultKey}`;
   * }
   * ```
   *
   * @example Using cookies for locale
   * ```typescript
   * keyGenerator: (ctx, defaultKey) => {
   *   const locale = cookies().get('locale')?.value || 'en';
   *   return `${locale}:${defaultKey}`;
   * }
   * ```
   */
  readonly keyGenerator?: (
    ctx: RequestContext<TEnv>,
    defaultKey: string,
  ) => string | Promise<string>;

  /**
   * Get cached entry data by key
   * @returns Cache result with data and staleness, or null if not found/expired
   */
  get(key: string): Promise<CacheGetResult | null>;

  /**
   * Store entry data with TTL
   * @param key - Cache key
   * @param data - Serialized entry data
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   */
  set(
    key: string,
    data: CachedEntryData,
    ttl: number,
    swr?: number,
  ): Promise<void>;

  /**
   * Delete a cached entry
   * @returns true if deleted, false if not found
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached entries (optional, for testing)
   */
  clear?(): Promise<void>;

  // ============================================================================
  // Document Cache Methods (optional)
  // ============================================================================
  // These methods are for caching full HTTP responses (document-level caching).
  // Stores that support response caching should implement these methods.

  /**
   * Get a cached Response by key.
   * Returns the response and whether it should be revalidated (SWR).
   */
  getResponse?(
    key: string,
  ): Promise<{ response: Response; shouldRevalidate: boolean } | null>;

  /**
   * Store a Response with TTL and optional SWR window.
   * @param key - Cache key
   * @param response - Response to cache (will be cloned)
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   * @param tags - Optional cache tags for invalidation
   */
  putResponse?(
    key: string,
    response: Response,
    ttl: number,
    swr?: number,
    tags?: string[],
  ): Promise<void>;

  // ============================================================================
  // Function Cache Methods (optional, for "use cache" directive)
  // ============================================================================
  // These methods cache individual function/component return values.
  // Stores that support "use cache" should implement these methods.

  /**
   * Get a cached function result by key.
   * Returns the serialized value, optional handle data, and staleness flag.
   */
  getItem?(key: string): Promise<CacheItemResult | null>;

  /**
   * Store a function result with TTL and optional SWR window.
   * @param key - Cache key (format: use-cache:{functionId}:{serializedArgs})
   * @param value - RSC-serialized return value
   * @param options - TTL, SWR, handle data, and tags
   */
  setItem?(
    key: string,
    value: string,
    options?: CacheItemOptions,
  ): Promise<void>;

  // ============================================================================
  // Tag-based Invalidation (optional)
  // ============================================================================

  /**
   * Invalidate every cache entry (segment, response, item) tagged with any of
   * `tags`. Store-level primitive that the public updateTag()/revalidateTag()
   * APIs delegate to. Receives ALL of one invalidation call's tags at once so
   * stores can batch their work (e.g. a single CDN purge request rather than
   * one per tag). Stores that do not support tags simply omit this method.
   * @param tags - The cache tags to invalidate
   */
  invalidateTags?(tags: string[]): Promise<void>;
}

/**
 * Result from getItem() for function-level caching ("use cache").
 */
export interface CacheItemResult {
  /** RSC-serialized return value */
  value: string;
  /** Handle data captured during execution (breadcrumbs, metadata, etc.) */
  handles?: Record<string, SegmentHandleData>;
  /** Whether the entry is stale and should be revalidated */
  shouldRevalidate: boolean;
  /**
   * The entry's cache tags (including runtime cacheTag() tags), surfaced on read
   * so a "use cache" HIT can still contribute its tags to the request-scoped tag
   * set used by document-level caching. On a hit the cached function is not
   * re-run, so its runtime tags are only available here, not from re-execution.
   */
  tags?: string[];
}

/**
 * Options for setItem() for function-level caching ("use cache").
 */
export interface CacheItemOptions {
  /** Handle data to store alongside the value */
  handles?: Record<string, SegmentHandleData>;
  /** Time-to-live in seconds */
  ttl?: number;
  /** Stale-while-revalidate window in seconds */
  swr?: number;
  /** Cache tags for invalidation */
  tags?: string[];
}

/**
 * Serialized segment data stored in cache
 * Note: loading is preserved to ensure consistent tree structure between cached and fresh renders
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface SerializedSegmentData {
  /** RSC-encoded component string */
  encoded: string;
  /** RSC-encoded layout string (if present) */
  encodedLayout?: string;
  /** RSC-encoded loading skeleton string (if present), or "null" for explicit null */
  encodedLoading?: string;
  /** RSC-encoded loaderData (if present) */
  encodedLoaderData?: string;
  /** RSC-encoded loaderDataPromise (if present) */
  encodedLoaderDataPromise?: string;
  /** Segment metadata (everything except component, layout, loading, and loader data) */
  metadata: Omit<
    ResolvedSegment,
    "component" | "layout" | "loading" | "loaderData" | "loaderDataPromise"
  >;
}

/**
 * Raw data stored in cache for an entry
 *
 * @internal This type is an implementation detail and may change without notice.
 */
export interface CachedEntryData {
  /** Serialized segments for this entry */
  segments: SerializedSegmentData[];
  /** Handle data keyed by segment ID */
  handles: Record<string, SegmentHandleData>;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
  /** Cache tags for invalidation */
  tags?: string[];
  /** Timestamp (ms since epoch) when tags were attached, for distributed invalidation */
  taggedAt?: number;
}

// ============================================================================
// Cache Configuration
// ============================================================================

/**
 * Default cache options applied to all cache() boundaries.
 * Individual cache() calls can override any of these values.
 *
 * @example
 * ```ts
 * const store = new CFCacheStore({
 *   defaults: { ttl: 60, swr: 300 }
 * });
 * ```
 */
export interface CacheDefaults {
  /**
   * Default time-to-live in seconds.
   * After TTL expires, cached entry is considered stale.
   */
  ttl?: number;
  /**
   * Default stale-while-revalidate window in seconds.
   * During SWR window, stale content is served while revalidating in background.
   */
  swr?: number;
}

/**
 * Cache configuration for RSC handler
 */
export interface CacheConfig {
  /** Cache store implementation (includes defaults) */
  store: SegmentCacheStore;
  /** Enable/disable caching (default: true) */
  enabled?: boolean;
}

/**
 * Cache configuration - can be static or a function receiving env
 */
export type CacheConfigOrFactory<TEnv> =
  | CacheConfig
  | ((env: TEnv) => CacheConfig);

// ============================================================================
// Segment Cache Provider (request-level interface)
// ============================================================================

/**
 * Handle data for a single segment
 * Structure: { handleName: [values...] }
 */
export type SegmentHandleData = Record<string, unknown[]>;

/**
 * Result from cache get() including segments and their handle data
 * Each entry can produce multiple segments (main + parallels)
 */
export interface CachedEntryResult {
  /** All segments for this entry (main segment + parallels) */
  segments: ResolvedSegment[];
  /** Handle data keyed by segment ID */
  handles: Record<string, SegmentHandleData>;
}

/**
 * Segment cache provider interface
 *
 * Used by router to check/store segment cache during matching.
 * Accessed via request context - if not present, caching is disabled.
 *
 * @internal Not currently implemented - CacheScope is used directly.
 * Reserved for future extensibility.
 */
export interface SegmentCacheProvider {
  /** Whether caching is enabled for this request */
  readonly enabled: boolean;

  /**
   * Get cached segments and restore handles/loaders.
   *
   * Combines cache get with handle replay and loader data restoration.
   * Returns tuple of [segments, segmentIds] if cache hit, null if miss or disabled.
   *
   * @param cacheKey - Cache key to look up
   * @param params - Route params for cache key generation
   * @param loaderPromises - Map to restore loader data into
   * @returns Tuple of [segments, segmentIds] or null if miss
   */
  restore(
    cacheKey: string,
    params: Record<string, string>,
    loaderPromises: Map<string, Promise<any>>,
  ): Promise<[ResolvedSegment[], string[]] | null>;

  /**
   * Cache entry with automatic handle collection (non-blocking).
   *
   * Schedules caching via waitUntil - handles are collected after they settle.
   * Validates segments have actual components before caching.
   *
   * @param cacheKey - The cache key to store under
   * @param segments - All resolved segments for this entry
   */
  cacheEntry(cacheKey: string, segments: ResolvedSegment[]): void;
}
