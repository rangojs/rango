/**
 * Match Result Collection
 *
 * Collects segments from the pipeline and builds the final MatchResult.
 * This is the final stage of the match pipeline.
 *
 * COLLECTION FLOW
 * ===============
 *
 *   Pipeline Generator
 *         |
 *         v
 *   +---------------------------+
 *   | collectSegments()        |  Drain async generator
 *   | for await...push         |
 *   +---------------------------+
 *         |
 *         v
 *   +---------------------------+
 *   | buildMatchResult()       |  Transform to MatchResult
 *   +---------------------------+
 *         |
 *         |
 *   +-----+-----+
 *   |           |
 * Full       Partial
 * Match      Match
 *   |           |
 *   v           v
 * All segs   Filter:
 * rendered   - null components out
 *            - keep loaders
 *            - handle intercepts
 *   |           |
 *   +-----------+
 *         |
 *         v
 *   MatchResult {
 *     segments,    // Segments to render
 *     matched,     // All segment IDs
 *     diff,        // Changed segment IDs
 *     params,      // Route params
 *     slots,       // Intercept slot data
 *     serverTiming // Performance metrics
 *   }
 *
 *
 * FULL VS PARTIAL MATCH
 * =====================
 *
 * Full Match (document request):
 *   - All segments are rendered
 *   - allIds = all segment IDs
 *   - No filtering needed
 *
 * Partial Match (navigation):
 *   - Filter out null components (client already has them)
 *   - BUT keep loader segments (they carry data)
 *   - Handle intercepts specially (preserve client page + add modal)
 *
 *
 * SEGMENT FILTERING RULES
 * =======================
 *
 * For partial match, segments are filtered:
 *
 *   Keep if:
 *     - component !== null (needs rendering)
 *     - type === "loader" (carries data even with null component)
 *
 *   Skip if:
 *     - component === null AND type !== "loader"
 *     - (Client already has this segment's UI)
 *
 *
 * INTERCEPT HANDLING
 * ==================
 *
 * When intercepting (modal over current page):
 *
 *   allIds = client segments + intercept segments
 *
 * This tells the client:
 *   1. Keep your current segments
 *   2. Add these intercept segments to the modal slot
 *
 * The page stays visible, modal renders on top.
 *
 *
 * MATCHRESULT STRUCTURE
 * =====================
 *
 * {
 *   segments: ResolvedSegment[]  // Segments to serialize and render
 *   matched: string[]            // All segment IDs for this route
 *   diff: string[]               // Which segments changed (for client diffing)
 *   params: Record<string,string> // Route parameters
 *   slots?: Record<string, {...}> // Named slot data for intercepts
 *   serverTiming?: string         // Server-Timing header value
 *   routeMiddleware?: [...]       // Route middleware results
 * }
 *
 * The client uses this to:
 *   1. Render segments[] to the UI tree
 *   2. Update internal state with matched[]
 *   3. Diff against previous state with diff[]
 *   4. Render slot content if slots present
 */
import type { MatchResult, ResolvedSegment } from "../types.js";
import type { MatchContext, MatchPipelineState } from "./match-context.js";
import { debugLog } from "./logging.js";
import { appendMetric } from "./metrics.js";

/**
 * Collect all segments from an async generator
 */
export async function collectSegments(
  generator: AsyncGenerator<ResolvedSegment>,
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];
  for await (const segment of generator) {
    segments.push(segment);
  }
  return segments;
}

/**
 * Build the final MatchResult from collected segments and context
 */
export function buildMatchResult<TEnv>(
  allSegments: ResolvedSegment[],
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): MatchResult {
  const logPrefix = ctx.isFullMatch
    ? "[Router.match]"
    : "[Router.matchPartial]";

  let allIds: string[];
  let segmentsToRender: ResolvedSegment[];

  if (ctx.isFullMatch) {
    // Full match (document request) - all segments are rendered
    // Deduplicate by segment ID (defense-in-depth). The primary dedup is in
    // resolveAllSegments, but this guards against any path that bypasses it.
    // include() scopes can produce entries that resolve the same shared layout,
    // and duplicate IDs change the client's React tree depth causing remounts.
    const seen = new Set<string>();
    segmentsToRender = [];
    for (const s of allSegments) {
      if (!seen.has(s.id)) {
        seen.add(s.id);
        segmentsToRender.push(s);
      }
    }
    allIds = segmentsToRender.map((s) => s.id);
  } else {
    // Partial match (navigation) - filter and handle intercepts
    // When intercepting, tell browser to keep its current segments + add modal
    // This prevents the browser from discarding the current page content
    // If client sent empty segments (HMR recovery), use segment IDs from allSegments
    allIds = ctx.interceptResult
      ? ctx.clientSegmentIds.length > 0
        ? [...ctx.clientSegmentIds, ...state.interceptSegments.map((s) => s.id)]
        : allSegments.map((s) => s.id) // Use actual segments, not matchedIds
      : [...state.matchedIds, ...state.interceptSegments.map((s) => s.id)];

    // Deduplicate allIds (defense-in-depth for partial match path)
    allIds = [...new Set(allIds)];

    // Filter out segments with null components (client already has them)
    // BUT always include loader segments - they carry data even with null component
    segmentsToRender = allSegments.filter(
      (s) => s.component !== null || s.type === "loader",
    );
  }

  debugLog(logPrefix, "all segments", {
    segments: allSegments.map((s) => ({
      id: s.id,
      type: s.type,
      hasComponent: s.component !== null,
    })),
  });
  debugLog(logPrefix, "segments to render", {
    segmentIds: segmentsToRender.map((s) => s.id),
  });

  return {
    segments: segmentsToRender,
    matched: allIds,
    diff: segmentsToRender.map((s) => s.id),
    params: ctx.matched.params,
    routeName: ctx.routeKey,
    slots: Object.keys(state.slots).length > 0 ? state.slots : undefined,
    routeMiddleware:
      ctx.routeMiddleware.length > 0 ? ctx.routeMiddleware : undefined,
  };
}

/**
 * Collect segments from pipeline and build MatchResult
 *
 * This is the main entry point for building the final result after
 * the pipeline has processed all segments.
 */
export async function collectMatchResult<TEnv>(
  pipeline: AsyncGenerator<ResolvedSegment>,
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): Promise<MatchResult> {
  const allSegments = await collectSegments(pipeline);

  const buildStart = performance.now();

  // Update state with collected segments if not already set
  if (state.segments.length === 0) {
    state.segments = allSegments;
  }

  const result = buildMatchResult(allSegments, ctx, state);
  appendMetric(
    ctx.metricsStore,
    "collect-result",
    buildStart,
    performance.now() - buildStart,
  );
  return result;
}
