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

// ============================================================================
// Segment Cache Store (low-level storage interface)
// ============================================================================

/**
 * Low-level segment cache store interface.
 *
 * Implementations handle the actual storage (memory, KV, Redis, etc.).
 * The store deals with serialized data - RSC serialization is handled
 * by the cache provider layer.
 */
export interface SegmentCacheStore {
  /**
   * Default cache options for this store.
   * Used by cache() boundaries when ttl/swr are not explicitly specified.
   */
  readonly defaults?: CacheDefaults;

  /**
   * Get cached entry data by key
   * @returns Raw cached data or null if not found/expired
   */
  get(key: string): Promise<CachedEntryData | null>;

  /**
   * Store entry data with TTL
   * @param key - Cache key
   * @param data - Serialized entry data
   * @param ttl - Time-to-live in seconds
   * @param swr - Optional stale-while-revalidate window in seconds
   */
  set(key: string, data: CachedEntryData, ttl: number, swr?: number): Promise<void>;

  /**
   * Delete a cached entry
   * @returns true if deleted, false if not found
   */
  delete(key: string): Promise<boolean>;

  /**
   * Clear all cached entries (optional, for testing)
   */
  clear?(): Promise<void>;
}

/**
 * Serialized segment data stored in cache
 * Note: loading is preserved to ensure consistent tree structure between cached and fresh renders
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
  metadata: Omit<ResolvedSegment, "component" | "layout" | "loading" | "loaderData" | "loaderDataPromise">;
}

/**
 * Raw data stored in cache for an entry
 */
export interface CachedEntryData {
  /** Serialized segments for this entry */
  segments: SerializedSegmentData[];
  /** Handle data keyed by segment ID */
  handles: Record<string, SegmentHandleData>;
  /** Expiration timestamp (ms since epoch) */
  expiresAt: number;
}

// ============================================================================
// Cache Configuration
// ============================================================================

/**
 * Default cache options applied to all cache() boundaries.
 * Individual cache() calls can override any of these values.
 */
export interface CacheDefaults {
  /** Default time-to-live in seconds */
  ttl?: number;
  /** Default stale-while-revalidate window in seconds */
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
 * @deprecated Use CachedEntryResult instead
 */
export interface CachedSegmentResult {
  segment: ResolvedSegment;
  handles: SegmentHandleData;
}

/**
 * Segment cache provider interface
 *
 * Used by router to check/store segment cache during matching.
 * Accessed via request context - if not present, caching is disabled.
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
    loaderPromises: Map<string, Promise<any>>
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

/**
 * Supported cache value types
 */
export type CacheValue =
  | ReadableStream<Uint8Array>
  | Response
  | ArrayBuffer
  | string
  | object; // JSON-serializable

/**
 * Cache entry returned by match()
 */
export interface CacheEntry<T = CacheValue> {
  /** The cached value */
  value: T;
  /** Optional metadata stored with the entry */
  metadata?: CacheMetadata;
}

/**
 * Original value type for reconstruction
 */
export type CacheValueType =
  | "stream"
  | "response"
  | "arraybuffer"
  | "string"
  | "object";

/**
 * Metadata associated with a cache entry
 */
export interface CacheMetadata {
  /** Timestamp when entry expires (ms since epoch) */
  expiresAt?: number;
  /** Tags for bulk invalidation */
  tags?: string[];
  /** Original value type for reconstruction on read */
  valueType?: CacheValueType;
  /** Response headers (preserved when caching Response) */
  responseHeaders?: Record<string, string>;
  /** Response status (preserved when caching Response) */
  responseStatus?: number;
  /** Custom metadata */
  [key: string]: unknown;
}

/**
 * Options for put()
 */
export interface CachePutOptions {
  /** Time-to-live in seconds */
  ttl?: number;
  /** Metadata to store with entry */
  metadata?: Omit<CacheMetadata, "expiresAt">;
}

/**
 * Cache store interface
 *
 * Implementations must handle:
 * - Stream values (clone before storing, streams can only be read once)
 * - Promise values (await before storing)
 * - Expiration/TTL
 */
export interface CacheStore {
  /**
   * Retrieve a cached entry by key
   *
   * @param key - Cache key
   * @returns The cached entry or undefined if not found/expired
   */
  match<T = CacheValue>(key: string): Promise<CacheEntry<T> | undefined>;

  /**
   * Store a value in the cache
   *
   * @param key - Cache key
   * @param value - Value to cache (stream, response, string, object, etc.)
   * @param options - TTL, metadata, etc.
   */
  put<T extends CacheValue>(
    key: string,
    value: T,
    options?: CachePutOptions
  ): Promise<void>;

  /**
   * Delete a cached entry
   *
   * @param key - Cache key
   * @returns true if entry was deleted, false if not found
   */
  delete(key: string): Promise<boolean>;
}
