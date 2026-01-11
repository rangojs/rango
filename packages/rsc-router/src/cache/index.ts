/**
 * Cache Store
 *
 * Server-side caching for RSC segments and loader data.
 */

// Generic cache store types (for future use with Response, Stream, etc.)
export type {
  CacheStore,
  CacheEntry,
  CacheValue,
  CacheValueType,
  CachePutOptions,
  CacheMetadata,
} from "./types.js";

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
  CACHE_STATUS_HEADER,
} from "./cf/index.js";

// Cache scope
export { CacheScope, createCacheScope } from "./cache-scope.js";
