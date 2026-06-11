/**
 * Cache Store
 *
 * Server-side caching for RSC segments and loader data.
 *
 * Main exports for users:
 * - SegmentCacheStore - Interface for implementing custom cache stores
 * - MemorySegmentCacheStore - In-memory cache for development/testing
 * - CFCacheStore - Cloudflare edge cache store for production
 * - CacheScope / createCacheScope - Request-scoped cache provider
 */

// Segment cache store types and implementations
export type {
  SegmentCacheStore,
  SegmentCacheProvider,
  CachedEntryData,
  CachedEntryResult,
  CacheGetResult,
  SerializedSegmentData,
  SegmentHandleData,
  CacheConfig,
  CacheConfigOrFactory,
} from "./types.js";

export { MemorySegmentCacheStore } from "./memory-segment-store.js";

// Cloudflare cache store
export {
  CFCacheStore,
  type CFCacheStoreOptions,
  type CFCacheDebug,
  type CFCacheReadDebugEvent,
  type KVNamespace,
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  CACHE_REVALIDATING_AT_HEADER,
  EDGE_LOOKUP_TIMEOUT_MS,
  EDGE_READ_TIMEOUT_MS,
  KV_READ_TIMEOUT_MS,
} from "./cf/index.js";

// Cache scope
export { CacheScope, createCacheScope } from "./cache-scope.js";

// Document-level cache middleware
export {
  createDocumentCacheMiddleware,
  type DocumentCacheOptions,
} from "./document-cache.js";

// Cache error reporting. CacheErrorCategory is the discriminator surfaced to a
// router's onError callback as `metadata.category` for the `cache` phase, so
// consumers can branch on the failure kind (e.g. distinguish a transient
// cache-read outage from cache-corrupt self-heal).
export type { CacheErrorCategory } from "./cache-error.js";
