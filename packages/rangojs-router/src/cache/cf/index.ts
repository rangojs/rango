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
  type CFCacheDebug,
  type CFCacheReadDebugEvent,
  type KVNamespace,
} from "./cf-cache-store.js";

// Header constants for debugging and inspection
export {
  CACHE_STALE_AT_HEADER,
  CACHE_STATUS_HEADER,
  CACHE_REVALIDATING_AT_HEADER,
} from "./cf-cache-store.js";

// Default latency-budget values, exported so the CFCacheStoreOptions JSDoc
// {@link}s resolve and consumers can derive margins from the defaults.
export {
  EDGE_LOOKUP_TIMEOUT_MS,
  EDGE_READ_TIMEOUT_MS,
  KV_READ_TIMEOUT_MS,
} from "./cf-cache-store.js";

// Internal exports (re-exported for backwards compatibility, marked @internal in source)
export {
  type CacheStatus,
  MAX_REVALIDATION_INTERVAL,
} from "./cf-cache-store.js";
