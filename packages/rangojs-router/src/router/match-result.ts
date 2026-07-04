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
 *     - client doesn't have the segment (structurally required parent node)
 *
 *   Skip if:
 *     - component === null AND type !== "loader" AND client has it cached
 *     - (Revalidation skip — client already has this segment's UI)
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
 * Deduplicate inherited loader segments by loaderId.
 *
 * When a route has loaders and a child layout has parallel slots, the same
 * loader is resolved twice: once for the route and once inherited into the
 * layout (tagged with `_inherited`). The inherited copy is only needed when
 * the route uses `loading()` — in that case, the loader data is inside a
 * LoaderBoundary/Suspense that parallel slots can't reach through. Without
 * loading(), useLoader() traverses parent contexts and finds the data.
 */
function deduplicateLoaderSegments(
  segments: ResolvedSegment[],
  logPrefix: string,
): { segments: ResolvedSegment[]; removedIds: Set<string> } {
  // Single pass: original (non-inherited) loaderIds, all loaderIds grouped by
  // namespace, and namespaces of segments that declare loading().
  const originalLoaders = new Set<string>();
  const loaderIdsByNamespace = new Map<string, string[]>();
  const namespacesWithLoading = new Set<string>();
  for (const s of segments) {
    if (s.type === "loader" && s.loaderId) {
      if (!s._inherited) originalLoaders.add(s.loaderId);
      const ids = loaderIdsByNamespace.get(s.namespace);
      if (ids) ids.push(s.loaderId);
      else loaderIdsByNamespace.set(s.namespace, [s.loaderId]);
    } else if (
      s.type !== "loader" &&
      s.loading !== undefined &&
      s.loading !== false
    ) {
      namespacesWithLoading.add(s.namespace);
    }
  }

  const loadersWithLoading = new Set<string>();
  for (const ns of namespacesWithLoading) {
    for (const id of loaderIdsByNamespace.get(ns) ?? []) {
      loadersWithLoading.add(id);
    }
  }

  const result: ResolvedSegment[] = [];
  const removedIds = new Set<string>();

  for (const s of segments) {
    if (
      s.type === "loader" &&
      s.loaderId &&
      s._inherited &&
      originalLoaders.has(s.loaderId) &&
      !loadersWithLoading.has(s.loaderId)
    ) {
      removedIds.add(s.id);
      continue;
    }
    result.push(s);
  }

  if (removedIds.size > 0) {
    debugLog(
      logPrefix,
      `deduped ${removedIds.size} inherited loader segment(s)`,
    );
  }

  return { segments: result, removedIds };
}

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
  let resolvedIds: string[];

  if (ctx.isFullMatch) {
    // One pass over allSegments: dedup by id (segmentsToRender + allIds) while
    // collecting every id for resolvedIds, which keeps duplicates unlike allIds.
    const seen = new Set<string>();
    segmentsToRender = [];
    allIds = [];
    resolvedIds = [];
    for (const s of allSegments) {
      resolvedIds.push(s.id);
      if (!seen.has(s.id)) {
        seen.add(s.id);
        segmentsToRender.push(s);
        allIds.push(s.id);
      }
    }
  } else {
    allIds = ctx.interceptResult
      ? ctx.clientSegmentIds.length > 0
        ? [...ctx.clientSegmentIds, ...state.interceptSegments.map((s) => s.id)]
        : allSegments.map((s) => s.id)
      : [...state.matchedIds, ...state.interceptSegments.map((s) => s.id)];

    allIds = [...new Set(allIds)];

    // One pass over allSegments: keep renderable segments and collect the
    // handler-ran ids (resolvedIds) together.
    const clientIdSet = new Set(ctx.clientSegmentIds);
    segmentsToRender = [];
    resolvedIds = [];
    for (const s of allSegments) {
      if (s._handlerRan) resolvedIds.push(s.id);
      if (
        s.component !== null ||
        s.type === "loader" ||
        !clientIdSet.has(s.id)
      ) {
        segmentsToRender.push(s);
      }
    }
  }

  const { segments: dedupedSegments, removedIds } = deduplicateLoaderSegments(
    segmentsToRender,
    logPrefix,
  );

  const matchedIds =
    removedIds.size > 0 ? allIds.filter((id) => !removedIds.has(id)) : allIds;

  // One pass over dedupedSegments: strip the internal _handlerRan marker and
  // collect the diff ids (id is unchanged by the strip) together.
  const cleanedSegments: ResolvedSegment[] = [];
  const diff: string[] = [];
  for (const s of dedupedSegments) {
    if (s._handlerRan === undefined) {
      cleanedSegments.push(s);
    } else {
      const { _handlerRan: _drop, ...rest } = s;
      cleanedSegments.push(rest as ResolvedSegment);
    }
    diff.push(s.id);
  }

  return {
    segments: cleanedSegments,
    matched: matchedIds,
    diff,
    resolvedIds,
    params: ctx.matched.params,
    routeName: ctx.routeKey,
    slots: Object.keys(state.slots).length > 0 ? state.slots : undefined,
    routeMiddleware:
      ctx.routeMiddleware.length > 0 ? ctx.routeMiddleware : undefined,
  };
}

export async function collectMatchResult<TEnv>(
  pipeline: AsyncGenerator<ResolvedSegment>,
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): Promise<MatchResult> {
  const allSegments = await collectSegments(pipeline);

  const buildStart = performance.now();

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
