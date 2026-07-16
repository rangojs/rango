/**
 * Match Middleware
 *
 * Async generator middleware for the match pipeline.
 * Each middleware transforms or enriches the segment stream.
 *
 * MIDDLEWARE OVERVIEW
 * ===================
 *
 * The pipeline consists of 5 middleware layers, each with a specific role:
 *
 * +-------------------------------------------------------------------------+
 * |                         MIDDLEWARE PIPELINE                             |
 * +-------------------------------------------------------------------------+
 * |                                                                         |
 * |  [1] CACHE LOOKUP (innermost)                                           |
 * |      Purpose: Check cache before resolving                              |
 * |      On hit:  Yield cached segments + fresh loaders                     |
 * |      On miss: Pass through to segment resolution                        |
 * |      Side effects: Sets cache hit, freshness, and SWR ownership         |
 * |                                                                         |
 * |  [2] SEGMENT RESOLUTION                                                 |
 * |      Purpose: Resolve segments when cache misses                        |
 * |      Skips if: state.cacheHit === true                                  |
 * |      Produces: All route segments (layouts, routes, loaders)            |
 * |      Two modes: Full (simple) vs Partial (with revalidation)            |
 * |                                                                         |
 * |  [3] INTERCEPT RESOLUTION                                               |
 * |      Purpose: Resolve intercept segments (modal slots)                  |
 * |      Triggers: When ctx.interceptResult exists                          |
 * |      Produces: Additional segments for named slots                      |
 * |      Updates: state.slots[slotName] with intercept segments             |
 * |                                                                         |
 * |  [4] CACHE STORE                                                        |
 * |      Purpose: Store segments in cache for future requests               |
 * |      Skips if: Cache hit, actions, or cache disabled                    |
 * |      Strategy: Direct cache if all components present                   |
 * |                Proactive cache if null components (via waitUntil)       |
 * |                                                                         |
 * |  [5] BACKGROUND REVALIDATION (outermost)                                |
 * |      Purpose: SWR - serve stale, revalidate in background               |
 * |      Triggers: When state.revalidationClaimed === true                  |
 * |      Action: Async resolution via waitUntil(), updates cache            |
 * |                                                                         |
 * +-------------------------------------------------------------------------+
 *
 *
 * MIDDLEWARE INTERACTION PATTERNS
 * ===============================
 *
 * Pattern 1: Producer Middleware (cache-lookup, segment-resolution)
 *   - Yields segments into the stream
 *   - Creates new data for downstream middleware
 *
 * Pattern 2: Transformer Middleware (intercept-resolution)
 *   - Passes through existing segments
 *   - Adds additional segments (intercepts)
 *
 * Pattern 3: Observer Middleware (cache-store, background-revalidation)
 *   - Passes through all segments unchanged
 *   - Triggers side effects based on state
 *
 *
 * STATE FLAGS
 * ===========
 *
 * The middleware communicate through MatchPipelineState:
 *
 *   state.cacheHit        - Set by cache-lookup, read by others to skip work
 *   state.revalidationClaimed - Set by cache-lookup, triggers bg-revalidation
 *   state.segments        - Accumulated segments from pipeline
 *   state.interceptSegments - Segments for intercept slots
 *   state.slots           - Named slot data for client
 */

export { withCacheLookup } from "./cache-lookup.js";
export { withSegmentResolution } from "./segment-resolution.js";
export { withInterceptResolution } from "./intercept-resolution.js";
export { withCacheStore } from "./cache-store.js";
export { withBackgroundRevalidation } from "./background-revalidation.js";
export type { GeneratorMiddleware } from "./cache-lookup.js";
