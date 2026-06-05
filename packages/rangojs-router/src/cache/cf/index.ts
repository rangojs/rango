/**
 * Cloudflare Cache Store Exports
 *
 * Main export:
 * - CFCacheStore - Production cache store using Cloudflare's Cache API
 *
 * Header constants (for inspection/debugging):
 * - CACHE_STALE_AT_HEADER - Header containing staleness timestamp
 * - CACHE_STATUS_HEADER - Header containing HIT/REVALIDATING status
 */

// Public API
export {
  CFCacheStore,
  type CFCacheStoreOptions,
  type KVNamespace,
} from "./cf-cache-store.js";

// Header constants for debugging and inspection. The tag headers
// (x-edge-cache-tags / x-edge-cache-tagged-at) are intentionally NOT re-exported:
// they are an internal encoding detail of the store's tag-invalidation check, not
// a consumer-inspectable contract.
export {
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
} from "./cf-cache-store.js";

// Internal exports (re-exported for backwards compatibility, marked @internal in source)
export {
  type CacheStatus,
  MAX_REVALIDATION_INTERVAL,
} from "./cf-cache-store.js";
