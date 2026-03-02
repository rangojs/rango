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

// Generic cache store types (reserved for future extensibility)
// These types support caching arbitrary values like Response, Stream, etc.
// Currently unused - segment caching uses SegmentCacheStore directly.
export type {
  CacheStore,
  CacheEntry,
  CacheValue,
  CacheValueType,
  CachePutOptions,
  CacheMetadata,
} from "./types.js";

// Generic memory cache (reserved for future extensibility)
export { MemoryCacheStore } from "./memory-store.js";

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
  CACHE_STALE_AT_HEADER,
  CACHE_TAGS_HEADER,
} from "./cf/index.js";

// Cache scope
export { CacheScope, createCacheScope } from "./cache-scope.js";

// Document-level cache middleware
export {
  createDocumentCacheMiddleware,
  type DocumentCacheOptions,
} from "./document-cache.js";
