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
export type { RouterContext, RevalidationContext, InterceptResult } from "./router/router-context.js";

// ============================================================================
// Match Pipeline (Internal)
// ============================================================================

/**
 * @internal
 * Route match context during pipeline processing.
 */
export type { MatchContext, MatchPipelineState } from "./router/match-context.js";

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

