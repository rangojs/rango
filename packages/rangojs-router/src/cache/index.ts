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
  CFEdgeKVCacheStore,
  CFKVTagInvalidationStore,
  type CFCacheStoreOptions,
  type CFEdgeKVCacheStoreOptions,
  type CFTagInvalidationStore,
  type CFKVTagInvalidationStoreOptions,
  type KVNamespaceLike,
  type KVNamespace,
  CACHE_STALE_AT_HEADER,
  CACHE_TAGS_HEADER,
  CACHE_TAGGED_AT_HEADER,
} from "./cf/index.js";

// Cache scope
export { CacheScope, createCacheScope } from "./cache-scope.js";

// Document-level cache middleware
export {
  createDocumentCacheMiddleware,
  type DocumentCacheOptions,
} from "./document-cache.js";
