/**
 * Internal Types - Implementation Details
 *
 * @internal
 * These types are for internal use only and should not be relied upon by consumers.
 * They may change without notice between versions.
 *
 * If you find yourself needing these types, please open an issue to discuss
 * adding them to the public API.
 */

// ============================================================================
// Segment Resolution (Internal)
// ============================================================================

/**
 * @internal
 * Internal representation of a resolved route segment.
 * Used during route matching and rendering pipeline.
 */
export type { ResolvedSegment, SegmentMetadata } from "./types.js";

/**
 * @internal
 * Internal match result from route resolution.
 */
export type { MatchResult, SlotState } from "./types.js";

// ============================================================================
// Intercept System (Internal)
// ============================================================================

/**
 * @internal
 * Context for intercept route selection.
 */
export type {
  InterceptSelectorContext,
  InterceptSegmentsState,
  InterceptWhenFn,
} from "./server/context.js";

// ============================================================================
// Browser State (Internal)
// ============================================================================

/**
 * @internal
 * RSC protocol payload structure.
 */
export type { RscPayload, ReactFormState } from "./rsc/types.js";

/**
 * @internal
 * Internal navigation store interface.
 */
export type {
  NavigationStore,
  NavigationBridge,
  RscMetadata,
  ActionResult,
  InflightAction,
  NavigationState,
  TrackedActionState,
  ActionStateListener,
  SegmentCache,
  SegmentState,
  NavigationUpdate,
} from "./browser/types.js";

// ============================================================================
// Handle System (Internal)
// ============================================================================

/**
 * @internal
 * Internal handle storage mechanism.
 */
export type { HandleStore, HandleData } from "./server/handle-store.js";

/**
 * @internal
 * Segment handle data in cache.
 */
export type { SegmentHandleData } from "./cache/types.js";

// ============================================================================
// Cache Internals
// ============================================================================

/**
 * @internal
 * Internal cache entry data structure.
 */
export type {
  CachedEntryData,
  CachedEntryResult,
  CacheGetResult,
  SerializedSegmentData,
  CacheDefaults,
} from "./cache/types.js";

// ============================================================================
// Router Context (Internal)
// ============================================================================

/**
 * @internal
 * Router context for AsyncLocalStorage.
 */
export type {
  RouterContext,
  RevalidationContext,
  InterceptResult,
} from "./router/router-context.js";

// ============================================================================
// Match Pipeline (Internal)
// ============================================================================

/**
 * @internal
 * Route match context during pipeline processing.
 */
export type {
  MatchContext,
  MatchPipelineState,
} from "./router/match-context.js";

/**
 * @internal
 * Pattern matching result.
 */
export type { RouteMatchResult } from "./router/pattern-matching.js";

// ============================================================================
// Server Context (Internal)
// ============================================================================

/**
 * @internal
 * Entry data during route traversal.
 */
export type {
  EntryData,
  InterceptEntry,
  MetricsStore,
  PerformanceMetric,
  EntryCacheConfig,
  EntryPropCommon,
  EntryPropDatas,
  LoaderEntry,
  EntryPropSegments,
} from "./server/context.js";

// ============================================================================
// Handler Context (Internal)
// ============================================================================

/**
 * @internal
 * Internal handler context with additional props for router internals.
 * Includes `_currentSegmentId` and `_responseType`.
 */
export type { InternalHandlerContext } from "./types.js";

// ============================================================================
// Rendering (Internal)
// ============================================================================

/**
 * @internal
 * Builds React element trees from route segments.
 */
export { renderSegments } from "./segment-system.js";

// ============================================================================
// Error Utilities (Internal)
// ============================================================================

/**
 * @internal
 * Error sanitization and network error utilities.
 */
export { sanitizeError, NetworkError, isNetworkError } from "./errors.js";

// ============================================================================
// Type Utilities (Internal)
// ============================================================================

/**
 * @internal
 * Scoped view of GeneratedRouteMap for Handler<"localName", ScopedRouteMap<"prefix">>.
 */
export type { ScopedRouteMap } from "./types.js";

/**
 * @internal
 * Type-level utilities for reverse URL generation.
 */
export type { MergeRoutes, SanitizePrefix } from "./reverse.js";

/**
 * @internal
 * Individual telemetry event types.
 */
export type {
  RequestStartEvent,
  RequestEndEvent,
  RequestErrorEvent,
  RequestTimeoutEvent,
  LoaderStartEvent,
  LoaderEndEvent,
  LoaderErrorEvent,
  HandlerErrorEvent,
  CacheDecisionEvent,
  RevalidationDecisionEvent,
} from "./router/telemetry.js";

// ============================================================================
// Pre-render / Static Handler Guards (Internal)
// ============================================================================

/**
 * @internal
 * Type guard for prerender handler definitions.
 */
export { isPrerenderHandler, isPassthroughHandler } from "./prerender.js";

/**
 * @internal
 * Type guard for static handler definitions.
 */
export { isStaticHandler } from "./static-handler.js";

// ============================================================================
// URL Pattern Internals
// ============================================================================

/**
 * @internal
 * Sentinel used to tag response-type route entries.
 */
export { RESPONSE_TYPE } from "./urls.js";

// ============================================================================
// Route Match Debug (Internal)
// ============================================================================

/**
 * @internal
 * Debug utilities for route matching performance analysis.
 */
export {
  enableMatchDebug,
  getMatchDebugStats,
} from "./router/pattern-matching.js";

// ============================================================================
// Debug Utilities (Internal)
// ============================================================================

/**
 * @internal
 * Debug utilities for manifest inspection and comparison.
 */
export {
  serializeManifest,
  compareManifests,
  formatManifestDiff,
  type SerializedEntry,
  type SerializedManifest,
} from "./debug.js";
