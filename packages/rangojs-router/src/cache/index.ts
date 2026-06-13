export type {
  SegmentCacheStore,
  CachedEntryData,
  CacheGetResult,
  CacheItemResult,
  CacheItemOptions,
  SerializedSegmentData,
  SegmentHandleData,
} from "./types.js";

export { MemorySegmentCacheStore } from "./memory-segment-store.js";

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

export { CacheScope, createCacheScope } from "./cache-scope.js";

export {
  createDocumentCacheMiddleware,
  type DocumentCacheOptions,
} from "./document-cache.js";

export type { CacheErrorCategory } from "./cache-error.js";
