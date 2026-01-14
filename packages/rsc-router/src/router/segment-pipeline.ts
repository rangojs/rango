/**
 * Segment Pipeline - Async Generator Model
 *
 * This module demonstrates an alternative approach to segment resolution
 * using async generators as a middleware-like pipeline.
 *
 * EXPERIMENTAL: This is a proof-of-concept for discussion.
 * The current router uses direct function calls which is more explicit
 * but harder to compose. This model shows how generators could enable:
 *
 * 1. Streaming segment resolution (yield segments as they're ready)
 * 2. Middleware-style composition (wrap/intercept/transform)
 * 3. Cleaner separation of concerns (each phase is a generator)
 * 4. Better testability (generators can be tested in isolation)
 *
 * The tradeoff is more indirection and complexity in understanding
 * the flow. The current direct approach may be clearer for this use case.
 */

import type { ResolvedSegment, HandlerContext } from "../types";
import type { EntryData } from "../server/context";
import type { ActionContext, RouteMatch, InterceptResult } from "./types";

/**
 * Context passed through the segment pipeline
 */
export interface PipelineContext<TEnv = any> {
  // Request info
  request: Request;
  url: URL;
  pathname: string;
  prevUrl: URL;

  // Route info
  matched: RouteMatch;
  entries: EntryData[];

  // Client state
  clientSegmentSet: Set<string>;
  prevParams: Record<string, string>;

  // Handler context
  handlerContext: HandlerContext<any, TEnv>;
  actionContext?: ActionContext;

  // Intercept info
  interceptResult: InterceptResult | null;

  // Mutable state
  loaderPromises: Map<string, Promise<any>>;

  // Control flags
  isAction: boolean;
  isCacheHit: boolean;
  stale: boolean;
}

/**
 * A segment middleware is an async generator that yields segments
 * and can transform or filter the pipeline context
 */
export type SegmentMiddleware<TEnv = any> = (
  ctx: PipelineContext<TEnv>,
  next: () => AsyncGenerator<ResolvedSegment>
) => AsyncGenerator<ResolvedSegment>;

/**
 * Pipeline stage that yields segments
 */
export type SegmentStage<TEnv = any> = (
  ctx: PipelineContext<TEnv>
) => AsyncGenerator<ResolvedSegment>;

/**
 * Compose multiple middleware into a single pipeline
 *
 * @example
 * ```typescript
 * const pipeline = composePipeline(
 *   loggingMiddleware,
 *   cachingMiddleware,
 *   revalidationMiddleware,
 *   segmentResolver
 * );
 *
 * for await (const segment of pipeline(ctx)) {
 *   // Handle each segment as it's yielded
 * }
 * ```
 */
export function composePipeline<TEnv>(
  ...stages: (SegmentMiddleware<TEnv> | SegmentStage<TEnv>)[]
): SegmentStage<TEnv> {
  return function* pipeline(ctx: PipelineContext<TEnv>) {
    // Build the middleware chain from right to left
    let current: () => AsyncGenerator<ResolvedSegment> = async function* () {
      // Empty terminal - no more stages
    };

    for (let i = stages.length - 1; i >= 0; i--) {
      const stage = stages[i];
      const next = current;

      // Check if this is middleware (takes next) or a terminal stage
      if (stage.length === 2) {
        // Middleware - wrap with next
        const middleware = stage as SegmentMiddleware<TEnv>;
        current = () => middleware(ctx, next);
      } else {
        // Terminal stage - just call it
        const terminal = stage as SegmentStage<TEnv>;
        current = () => terminal(ctx);
      }
    }

    yield* current();
  } as SegmentStage<TEnv>;
}

// ============================================================================
// Example Middleware Implementations
// ============================================================================

/**
 * Logging middleware - logs segments as they pass through
 */
export async function* loggingMiddleware<TEnv>(
  ctx: PipelineContext<TEnv>,
  next: () => AsyncGenerator<ResolvedSegment>
): AsyncGenerator<ResolvedSegment> {
  console.log(`[Pipeline] Starting segment resolution for ${ctx.pathname}`);
  let count = 0;

  for await (const segment of next()) {
    count++;
    console.log(`[Pipeline] Yielding segment ${count}: ${segment.id}`);
    yield segment;
  }

  console.log(`[Pipeline] Completed with ${count} segments`);
}

/**
 * Revalidation middleware - filters out segments that don't need revalidation
 *
 * This middleware checks each segment against the client's existing segments
 * and skips yielding segments that haven't changed.
 */
export async function* revalidationMiddleware<TEnv>(
  ctx: PipelineContext<TEnv>,
  next: () => AsyncGenerator<ResolvedSegment>
): AsyncGenerator<ResolvedSegment> {
  const { clientSegmentSet } = ctx;

  for await (const segment of next()) {
    // Always yield loader segments - they carry data
    if (segment.type === "loader") {
      yield segment;
      continue;
    }

    // If client doesn't have this segment, yield it
    if (!clientSegmentSet.has(segment.id)) {
      yield segment;
      continue;
    }

    // Client has segment - check if it needs revalidation
    // (In real implementation, this would call evaluateRevalidation)
    const needsRevalidation = segment.component !== null;

    if (needsRevalidation) {
      yield segment;
    } else {
      // Skip segment - client already has it and it doesn't need update
      console.log(`[Pipeline] Skipping segment ${segment.id} (no revalidation needed)`);
    }
  }
}

/**
 * Caching middleware - intercepts segment resolution for cache hits
 *
 * If cache hit, yields cached segments instead of calling next().
 * If cache miss, passes through to next() and optionally caches results.
 */
export function createCachingMiddleware<TEnv>(
  lookupCache: (
    pathname: string,
    params: Record<string, string>
  ) => Promise<ResolvedSegment[] | null>,
  storeCache: (
    pathname: string,
    params: Record<string, string>,
    segments: ResolvedSegment[]
  ) => Promise<void>
): SegmentMiddleware<TEnv> {
  return async function* cachingMiddleware(
    ctx: PipelineContext<TEnv>,
    next: () => AsyncGenerator<ResolvedSegment>
  ): AsyncGenerator<ResolvedSegment> {
    const { pathname, matched, isAction } = ctx;

    // Skip cache for actions
    if (isAction) {
      yield* next();
      return;
    }

    // Try cache lookup
    const cached = await lookupCache(pathname, matched.params);

    if (cached) {
      console.log(`[Pipeline] Cache HIT for ${pathname}`);
      ctx.isCacheHit = true;

      // Yield cached segments
      for (const segment of cached) {
        yield segment;
      }
      return;
    }

    // Cache miss - resolve and optionally cache
    console.log(`[Pipeline] Cache MISS for ${pathname}`);
    const segments: ResolvedSegment[] = [];

    for await (const segment of next()) {
      segments.push(segment);
      yield segment;
    }

    // Store in cache (non-blocking)
    storeCache(pathname, matched.params, segments).catch((err) =>
      console.error(`[Pipeline] Cache store failed:`, err)
    );
  };
}

/**
 * Intercept middleware - handles intercept routes
 *
 * If an intercept is active, this middleware:
 * 1. Yields the regular route segments
 * 2. Then yields the intercept segments in the appropriate slot
 */
export async function* interceptMiddleware<TEnv>(
  ctx: PipelineContext<TEnv>,
  next: () => AsyncGenerator<ResolvedSegment>,
  resolveIntercept: (
    intercept: InterceptResult,
    ctx: PipelineContext<TEnv>
  ) => AsyncGenerator<ResolvedSegment>
): AsyncGenerator<ResolvedSegment> {
  // First, yield regular segments
  for await (const segment of next()) {
    yield segment;
  }

  // Then, handle intercept if active
  if (ctx.interceptResult) {
    console.log(
      `[Pipeline] Resolving intercept for slot "${ctx.interceptResult.intercept.slotName}"`
    );

    for await (const segment of resolveIntercept(ctx.interceptResult, ctx)) {
      yield segment;
    }
  }
}

// ============================================================================
// Example Terminal Stage (Segment Resolver)
// ============================================================================

/**
 * Terminal stage that resolves segments from entries
 *
 * This is the "bottom" of the pipeline that actually creates segments.
 * In a real implementation, this would call the entry handlers.
 */
export async function* resolveSegmentsStage<TEnv>(
  ctx: PipelineContext<TEnv>
): AsyncGenerator<ResolvedSegment> {
  const { entries, matched, handlerContext } = ctx;

  for (const entry of entries) {
    // In real implementation, this would:
    // 1. Check entry type (layout, route, parallel)
    // 2. Call the handler
    // 3. Resolve loaders
    // 4. Create ResolvedSegment

    // Placeholder - yield a mock segment
    yield {
      id: entry.shortCode,
      type: entry.type as any,
      component: null, // Would be resolved component
      loading: undefined,
      error: undefined,
      params: matched.params,
      routeKey: matched.routeKey,
    };
  }
}

// ============================================================================
// Usage Example
// ============================================================================

/**
 * Example of how the pipeline would be used
 *
 * ```typescript
 * // Create the pipeline
 * const segmentPipeline = composePipeline(
 *   loggingMiddleware,
 *   createCachingMiddleware(lookupCache, storeCache),
 *   revalidationMiddleware,
 *   resolveSegmentsStage
 * );
 *
 * // Use in matchPartial
 * async function matchPartial(request, context) {
 *   const ctx = buildPipelineContext(request, context);
 *
 *   const segments: ResolvedSegment[] = [];
 *   for await (const segment of segmentPipeline(ctx)) {
 *     segments.push(segment);
 *   }
 *
 *   return { segments, ... };
 * }
 * ```
 *
 * Benefits of this approach:
 * - Each middleware can be tested independently
 * - Middleware can be composed in different orders
 * - Streaming: segments yield as soon as they're ready
 * - Easy to add new middleware (metrics, tracing, etc.)
 *
 * Tradeoffs:
 * - More indirection - harder to follow the flow
 * - Generator semantics can be confusing
 * - May be overkill for this use case
 * - Current direct approach is more explicit
 */
