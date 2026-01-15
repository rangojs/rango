/**
 * Match Pipelines
 *
 * Composes middleware into pipelines for match operations.
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
  state: MatchPipelineState
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
    withCacheLookup(ctx, state)
  );

  // Start with empty source - cache lookup or segment resolution will produce segments
  return pipeline(empty());
}

/**
 * Create the full match pipeline (simpler, no revalidation)
 *
 * Used for document requests (initial page load) where we don't need
 * revalidation logic since there's no previous state to compare against.
 */
export function createMatchPipeline<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState
): AsyncGenerator<ResolvedSegment> {
  // For full match, we only need:
  // 1. Cache lookup
  // 2. Segment resolution (without revalidation)
  // 3. Intercept resolution
  // 4. Cache store

  // Note: Full match uses different resolution logic (resolveAllSegments instead of
  // resolveAllSegmentsWithRevalidation). This will be handled by the segment resolution
  // middleware checking ctx.isFullMatch or similar flag.

  const pipeline = compose<ResolvedSegment>(
    withCacheStore(ctx, state),
    withInterceptResolution(ctx, state),
    withSegmentResolution(ctx, state),
    withCacheLookup(ctx, state)
  );

  return pipeline(empty());
}
