/**
 * Segment Resolution Middleware
 *
 * Resolves route segments when cache misses. Skips if cache hit.
 *
 * FLOW DIAGRAM
 * ============
 *
 *   source (from cache-lookup)
 *         |
 *         v
 *   +---------------------------+
 *   | Iterate source first!    |  <-- CRITICAL: Must drain source
 *   | yield* source            |      to let cache-lookup run
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------+
 *   | state.cacheHit?     |──yes──> return (cache already yielded)
 *   +---------------------+
 *         | no
 *         v
 *   +---------------------+
 *   | isFullMatch?        |
 *   +---------------------+
 *         |
 *   +-----+-----+
 *   |           |
 *  yes          no
 *   |           |
 *   v           v
 * resolveAll  resolveAllWithRevalidation
 * Segments    Segments
 *   |           |
 *   |           | (compares with prev state)
 *   |           | (handles null components)
 *   |           |
 *   +-----------+
 *         |
 *         v
 *   +---------------------------+
 *   | Update state:             |
 *   |  - state.segments         |
 *   |  - state.matchedIds       |
 *   +---------------------------+
 *         |
 *         v
 *   yield all resolved segments
 *         |
 *         v
 *      next middleware
 *
 *
 * RESOLUTION MODES
 * ================
 *
 * Full Match (document request):
 *   - Uses resolveAllSegments()
 *   - No revalidation logic (nothing to compare against)
 *   - Simple resolution of all route entries
 *
 * Partial Match (navigation):
 *   - Uses resolveAllSegmentsWithRevalidation()
 *   - Compares current vs previous params/URL
 *   - Sets component = null for segments client already has
 *   - Respects custom revalidation rules
 *
 *
 * CRITICAL: SOURCE ITERATION
 * ==========================
 *
 * The middleware MUST iterate the source generator before checking cacheHit:
 *
 *   for await (const segment of source) { yield segment; }
 *
 * This is because:
 *   1. Generator middleware are lazy (don't execute until iterated)
 *   2. cache-lookup sets state.cacheHit during iteration
 *   3. Without draining source first, cache-lookup never runs
 *
 * Incorrect pattern:
 *   if (!state.cacheHit) { ... }  // cacheHit still false!
 *   yield* source;                // Too late, already resolved
 *
 * Correct pattern:
 *   yield* source;                // Let cache-lookup set cacheHit
 *   if (state.cacheHit) return;   // Now we can check
 */
import type { ResolvedSegment } from "../../types.js";
import type { MatchContext, MatchPipelineState } from "../match-context.js";
import { getRouterContext } from "../router-context.js";
import type { GeneratorMiddleware } from "./cache-lookup.js";

/**
 * Creates segment resolution middleware
 *
 * Only runs on cache miss (state.cacheHit === false).
 * Uses resolveAllSegmentsWithRevalidation from RouterContext to resolve segments.
 */
export function withSegmentResolution<TEnv>(
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState
): GeneratorMiddleware<ResolvedSegment> {
  return async function* (
    source: AsyncGenerator<ResolvedSegment>
  ): AsyncGenerator<ResolvedSegment> {
    const pipelineStart = performance.now();
    const ms = ctx.metricsStore;

    // IMPORTANT: Always iterate source first to give cache-lookup a chance
    // to run and set state.cacheHit. Without this, cache-lookup never executes!
    for await (const segment of source) {
      yield segment;
    }

    // If cache hit, segments were already yielded by cache lookup
    if (state.cacheHit) {
      if (ms) {
        ms.metrics.push({ label: "pipeline:segment-resolve", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
      }
      return;
    }

    const { resolveAllSegmentsWithRevalidation, resolveAllSegments } =
      getRouterContext<TEnv>();

    const Store = ctx.Store;

    if (ctx.isFullMatch) {
      // Full match (document request) - simple resolution without revalidation
      const segments = await Store.run(() =>
        resolveAllSegments(
          ctx.entries,
          ctx.routeKey,
          ctx.matched.params,
          ctx.handlerContext,
          ctx.loaderPromises
        )
      );

      // Update state with resolved segments
      state.segments = segments;
      state.matchedIds = segments.map((s: { id: string }) => s.id);

      // Yield all resolved segments
      for (const segment of segments) {
        yield segment;
      }
    } else {
      // Partial match (navigation) - resolution with revalidation logic
      const result = await Store.run(() =>
        resolveAllSegmentsWithRevalidation(
          ctx.entries,
          ctx.routeKey,
          ctx.matched.params,
          ctx.handlerContext,
          ctx.clientSegmentSet,
          ctx.prevParams,
          ctx.request,
          ctx.prevUrl,
          ctx.url,
          ctx.loaderPromises,
          ctx.actionContext,
          ctx.interceptResult,
          ctx.localRouteName,
          ctx.pathname
        )
      );

      // Update state with resolved segments
      state.segments = result.segments;
      state.matchedIds = result.matchedIds;

      // Yield all resolved segments
      for (const segment of result.segments) {
        yield segment;
      }
    }

    if (ms) {
      ms.metrics.push({ label: "pipeline:segment-resolve", duration: performance.now() - pipelineStart, startTime: pipelineStart - ms.requestStart });
    }
  };
}
