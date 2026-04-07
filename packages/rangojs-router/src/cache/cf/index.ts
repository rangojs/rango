/**
 * Cloudflare Cache Store Exports
 *
 * Main export:
 * - CFCacheStore - Production cache store using Cloudflare's Cache API
 *
 * Header constants (for inspection/debugging):
 * - CACHE_STALE_AT_HEADER - Header containing staleness timestamp
 * - CACHE_TAGS_HEADER - Header containing comma-separated cache tags
 */

// Public API
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
} from "./cf-cache-store.js";

// Header constants for debugging and inspection
export {
  CACHE_STALE_AT_HEADER,
  CACHE_TAGS_HEADER,
  CACHE_TAGGED_AT_HEADER,
  REVALIDATION_LOCK_TTL,
} from "./cf-cache-store.js";
