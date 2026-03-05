/**
 * Match Pipelines
 *
 * Composes async generator middleware into pipelines for route matching.
 * The pipeline transforms navigation requests into resolved UI segments.
 *
 * PIPELINE ARCHITECTURE OVERVIEW
 * ==============================
 *
 * The router uses a pipeline of async generator middleware to process requests.
 * Each middleware can:
 *   1. Produce segments (yield)
 *   2. Transform segments from upstream
 *   3. Observe segments without modifying them
 *   4. Trigger side effects (caching, background revalidation)
 *
 * REQUEST FLOW DIAGRAM
 * ====================
 *
 *   Navigation Request
 *         |
 *         v
 *   +------------------+
 *   | Create Context   |  MatchContext: routes, params, client state
 *   +------------------+
 *         |
 *         v
 *   +------------------+
 *   | Select Pipeline  |  Full (document) vs Partial (navigation)
 *   +------------------+
 *         |
 *         v
 *   ==================== PIPELINE EXECUTION ====================
 *   |                                                          |
 *   |  empty() ─────> [1] ─────> [2] ─────> [3] ─────> [4] ───>|───> segments
 *   |    |            |          |          |          |       |
 *   |    |    cache   |  segment |intercept | cache   | bg     |
 *   |    |   lookup   | resolve  | resolve  | store   | reval  |
 *   |                                                          |
 *   ============================================================
 *         |
 *         v
 *   +------------------+
 *   | Collect Result   |  Filter segments, build MatchResult
 *   +------------------+
 *         |
 *         v
 *   RSC Stream Response
 *
 *
 * MIDDLEWARE EXECUTION ORDER
 * ==========================
 *
 * Middleware compose in reverse order (rightmost = innermost, runs first):
 *
 *   compose(A, B, C)(source)  =>  source -> C -> B -> A -> output
 *
 * For the partial match pipeline:
 *
 *   compose(
 *     withBackgroundRevalidation,  // [5] Outermost - triggers SWR
 *     withCacheStore,              // [4] Stores segments in cache
 *     withInterceptResolution,     // [3] Resolves intercept segments
 *     withSegmentResolution,       // [2] Resolves on cache miss
 *     withCacheLookup              // [1] Innermost - checks cache first
 *   )
 *
 * Execution flow for cache MISS:
 *
 *   empty() yields nothing
 *     -> [1] cache-lookup: no cache, passes through
 *     -> [2] segment-resolution: resolves segments, yields them
 *     -> [3] intercept-resolution: resolves intercepts, yields them
 *     -> [4] cache-store: observes all, stores in cache
 *     -> [5] bg-revalidation: no-op (wasn't stale)
 *     -> output: all segments
 *
 * Execution flow for cache HIT (stale):
 *
 *   empty() yields nothing
 *     -> [1] cache-lookup: HIT! yields cached segments + fresh loaders
 *     -> [2] segment-resolution: sees cacheHit=true, skips
 *     -> [3] intercept-resolution: extracts intercepts from cache
 *     -> [4] cache-store: sees cacheHit=true, skips
 *     -> [5] bg-revalidation: triggers waitUntil() to revalidate
 *     -> output: cached segments + fresh loader data
 *
 *
 * PIPELINE VARIANT
 * ================
 *
 * createMatchPartialPipeline handles both full (document) and partial
 * (navigation) requests. The middleware steps adapt based on ctx.isFullMatch:
 * - cache-lookup/store work for both
 * - background-revalidation is a no-op for full matches (no stale state)
 * - intercept-resolution is a no-op for full matches (no previous navigation)
 */
import type { ResolvedSegment } from "../types.js";
import type { MatchContext, MatchPipelineState } from "./match-context.js";
import type { GeneratorMiddleware } from "./match-middleware/index.js";
import {
  withBackgroundRevalidation,
  withCacheLookup,
  withCacheStore,
  withInterceptResolution,
  withSegmentResolution,
} from "./match-middleware/index.js";

/**
 * Compose multiple async generator middleware into a single middleware
 *
 * Middleware are applied in reverse order (rightmost runs first, innermost).
 * For the pipeline:
 *   compose(A, B, C)(source)
 *
 * The flow is: source -> C -> B -> A -> output
 * Where C is the innermost (runs first on input) and A is outermost (runs last).
 */
export function compose<T>(
  ...middleware: GeneratorMiddleware<T>[]
): GeneratorMiddleware<T> {
  if (middleware.length === 0) {
    return (source) => source;
  }
  if (middleware.length === 1) {
    return middleware[0];
  }
  return (source) => {
    // Apply middleware in reverse order (rightmost first)
    return middleware.reduceRight((prev, fn) => fn(prev), source);
  };
}

/**
 * Create an empty async generator (source for pipeline)
 */
export async function* empty<T>(): AsyncGenerator<T> {
  // Yields nothing - used as the initial source for the pipeline
}

/**
 * Create the match partial pipeline
 *
 * Pipeline order (innermost to outermost):
 * 1. cache-lookup    - Check cache first, yield cached segments if hit
 * 2. segment-resolution - Resolve segments if cache miss
 * 3. intercept-resolution - Resolve intercept segments
 * 4. cache-store     - Store segments in cache
 * 5. background-revalidation - Trigger SWR if cache was stale
 *
 * Data flow:
 * - empty() produces no segments
 * - cache-lookup either yields cached segments OR passes through to segment-resolution
 * - segment-resolution resolves fresh segments on cache miss
 * - intercept-resolution adds intercept segments
 * - cache-store observes and caches segments
 * - background-revalidation triggers SWR revalidation if needed
 */
export function createMatchPartialPipeline<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): AsyncGenerator<ResolvedSegment> {
  // Build the middleware chain
  const pipeline = compose<ResolvedSegment>(
    // Outermost - observes segments and triggers background revalidation
    withBackgroundRevalidation(ctx, state),
    // Observes and stores segments in cache
    withCacheStore(ctx, state),
    // Adds intercept segments after main segments
    withInterceptResolution(ctx, state),
    // Resolves segments on cache miss
    withSegmentResolution(ctx, state),
    // Innermost - checks cache first
    withCacheLookup(ctx, state),
  );

  // Start with empty source - cache lookup or segment resolution will produce segments
  return pipeline(empty());
}
