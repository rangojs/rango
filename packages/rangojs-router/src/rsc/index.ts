/**
 * RSC Router - RSC Entry Point
 *
 * This module provides RSC utilities for server-side rendering,
 * server actions, loader fetching, and progressive enhancement.
 *
 * @example Basic usage
 * ```tsx
 * import { router } from "./router.js";
 *
 * // Use router.fetch to handle requests
 * export default { fetch: router.fetch };
 * ```
 */

// Re-export types
export type {
  RscPayload,
  ReactFormState,
  RSCDependencies,
  SSRRenderOptions,
  SSRModule,
  LoadSSRModule,
  CreateRSCHandlerOptions,
  HandlerCacheConfig,
  NonceProvider,
} from "./types.js";

// Re-export HandleStore types for consumers who need custom handling
export {
  createHandleStore,
  type HandleStore,
  type HandleData,
} from "../server/handle-store.js";

// Re-export request context utilities for server-side access to env/request/params
export {
  getRequestContext,
  requireRequestContext,
  setRequestContextParams,
} from "../server/request-context.js";

// Re-export cache store types and implementations
export type {
  SegmentCacheStore,
  CachedEntryData,
  CachedEntryResult,
  SegmentCacheProvider,
  SegmentHandleData,
} from "../cache/types.js";

export { MemorySegmentCacheStore } from "../cache/memory-segment-store.js";
export { CFCacheStore, type CFCacheStoreOptions } from "../cache/cf/index.js";
