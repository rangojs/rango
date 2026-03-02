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
export { CFCacheStore, type CFCacheStoreOptions } from "./cf-cache-store.js";

// Header constants for debugging and inspection
export {
  CACHE_STALE_AT_HEADER,
  CACHE_TAGS_HEADER,
  REVALIDATION_LOCK_TTL,
} from "./cf-cache-store.js";

// Deprecated exports (kept for backwards compatibility)
export {
  /** @deprecated Renamed to REVALIDATION_LOCK_TTL */
  MAX_REVALIDATION_INTERVAL,
  /** @deprecated No longer used */
  CACHE_STATUS_HEADER,
  /** @deprecated No longer used */
  type CacheStatus,
} from "./cf-cache-store.js";
