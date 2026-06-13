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
    return middleware.reduceRight((prev, fn) => fn(prev), source);
  };
}

export async function* empty<T>(): AsyncGenerator<T> {}

export function createMatchPartialPipeline<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): AsyncGenerator<ResolvedSegment> {
  const pipeline = compose<ResolvedSegment>(
    withBackgroundRevalidation(ctx, state),
    withCacheStore(ctx, state),
    withInterceptResolution(ctx, state),
    withSegmentResolution(ctx, state),
    withCacheLookup(ctx, state),
  );

  return pipeline(empty());
}
