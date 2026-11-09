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
import type {
  InternalHandlerContext,
  MatchResult,
  ResolvedSegment,
} from "../types.js";
import { isPlaceholder } from "../types/segments.js";
import { interceptMatched } from "../browser/intercept-utils.js";
import type { MatchContext, MatchPipelineState } from "./match-context.js";
import { appendMetric } from "./metrics.js";
import {
  collectInterceptTargetNames,
  interceptSegmentIds,
} from "./intercept-resolution.js";

export async function collectSegments(
  generator: AsyncGenerator<ResolvedSegment>,
): Promise<ResolvedSegment[]> {
  const segments: ResolvedSegment[] = [];
  for await (const segment of generator) {
    segments.push(segment);
  }
  return segments;
}

export function buildMatchResult<TEnv>(
  allSegments: ResolvedSegment[],
  ctx: MatchContext<TEnv>,
  state: MatchPipelineState,
): MatchResult {
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
        ? interceptMatched(
            ctx.clientSegmentIds,
            interceptSegmentIds(
              ctx.interceptResult.entry,
              ctx.interceptResult.intercept,
            ),
          )
        : allSegments.map((s) => s.id)
      : [...state.matchedIds, ...state.interceptSegments.map((s) => s.id)];

    allIds = [...new Set(allIds)];

    // One pass over allSegments: keep renderable segments and collect the
    // ids that ran (resolvedIds) together. A partial match resolves only the
    // loaders it runs (revalidation.ts), so each loader segment here ran:
    // the browser replaces that loader's handle pushes, and keeps those of a
    // loader it skipped (handles/pushed-by.ts).
    const clientIdSet = new Set(ctx.clientSegmentIds);
    segmentsToRender = [];
    resolvedIds = [];
    for (const s of allSegments) {
      // A deferred loader (prefetch: false) did not run in this response:
      // its pushes arrive with the fill, which lists it then.
      if (s._handlerRan || (s.type === "loader" && !isPlaceholder(s))) {
        resolvedIds.push(s.id);
      }
      // A deferred unit (prefetch: false) has a null component and is sent:
      // only a segment the client does not hold is ever deferred, and
      // deferral reads these same ids (prefetch-deferral.ts
      // PrefetchDeferral.held), not the set the match forces renders with.
      if (
        s.component !== null ||
        s.type === "loader" ||
        !clientIdSet.has(s.id)
      ) {
        segmentsToRender.push(s);
      }
    }
  }

  const toWire = createWireSegmentStep();
  const cleanedSegments: ResolvedSegment[] = [];
  const diff: string[] = [];
  for (const s of segmentsToRender) {
    cleanedSegments.push(toWire(s));
    diff.push(s.id);
  }

  // Intercept targets reachable when THIS location becomes a navigation
  // origin — the browser-local clientUrls matcher declines its optimistic
  // presentation for these (see collectInterceptTargetNames).
  const interceptTargets = collectInterceptTargetNames(ctx.manifestEntry);
  const sourceHeld = (
    ctx.handlerContext as InternalHandlerContext<any, TEnv> | undefined
  )?._sourceHeld;

  return {
    segments: cleanedSegments,
    matched: allIds,
    diff,
    resolvedIds,
    params: ctx.matched.params,
    routeName: ctx.routeKey,
    slots: wireSlots(state.slots, toWire),
    ...(interceptTargets.length > 0 ? { interceptTargets } : {}),
    ...(ctx.interceptTargeted ? { interceptTargeted: true } : {}),
    ...(sourceHeld ? { sourceHeld } : {}),
    ...(!ctx.isFullMatch && sendsOnlyStored(segmentsToRender, state)
      ? { fromStorage: true as const }
      : {}),
    routeMiddleware:
      ctx.routeMiddleware.length > 0 ? ctx.routeMiddleware : undefined,
  };
}

/**
 * The one step every segment a MatchResult sends goes through, in `segments`
 * and in every slot's `segments`: it drops each own key that starts with `_`.
 * Those are server-side markers (`_handlerRan`). A strip that names its fields
 * misses the next marker someone adds, and one applied to `segments` alone
 * misses an intercept's slot, which holds the same kind of segment. No `_` key
 * is part of the wire shape: the browser reads none, and the cache codec
 * (cache/segment-codec.ts) stores none.
 *
 * Returns the input object when it has no such key, and a copy otherwise:
 * the input may be a record a cache, prerender or held tree keeps. Copies are
 * memoized per step, so a segment the pipeline put in both `segments` and a
 * slot (an intercept's) comes out as one object in both.
 */
function createWireSegmentStep(): (
  segment: ResolvedSegment,
) => ResolvedSegment {
  const copies = new Map<ResolvedSegment, ResolvedSegment>();
  return (segment) => {
    const copied = copies.get(segment);
    if (copied) return copied;
    const keys = Object.keys(segment);
    if (!keys.some(isInternalKey)) return segment;
    const source = segment as unknown as Record<string, unknown>;
    const wire: Record<string, unknown> = {};
    for (const key of keys) {
      if (!isInternalKey(key)) wire[key] = source[key];
    }
    const out = wire as unknown as ResolvedSegment;
    copies.set(segment, out);
    return out;
  };
}

const isInternalKey = (key: string): boolean => key.startsWith("_");

/**
 * The pipeline's slots as sent: fresh slot objects whose segments went
 * through `toWire`, so `state.slots` (and the records it points at) is left
 * as the pipeline built it.
 */
function wireSlots(
  slots: MatchPipelineState["slots"],
  toWire: (segment: ResolvedSegment) => ResolvedSegment,
): MatchResult["slots"] {
  const names = Object.keys(slots);
  if (names.length === 0) return undefined;
  const out: NonNullable<MatchResult["slots"]> = {};
  for (const name of names) {
    const slot = slots[name]!;
    out[name] = { ...slot, segments: slot.segments.map(toWire) };
  }
  return out;
}

/**
 * Whether a partial answer sends only what the cache lookup decoded from
 * storage (MatchResult.fromStorage). By object, not by id: a
 * segment the live walk resolved under a stored one's id (a live layout above
 * a cache() boundary, an intercept resolved live) is not the stored copy.
 * Any loader segment ran in this request, so it is live. Defaults to live:
 * counted stored by mistake, a segment brings back the cached failures #1170
 * removed. A stale cache() record (state.shouldRevalidate, refreshed in the
 * background), a stale on-demand Prerender overlay entry (state.storedStale,
 * which only the overlay can be: the build manifest never goes stale) and an
 * answer that sends nothing count as live too: the browser would keep the
 * first two past their refresh, and the third is a source page's answer.
 */
function sendsOnlyStored(
  sent: readonly ResolvedSegment[],
  state: MatchPipelineState,
): boolean {
  if (
    !state.cacheHit ||
    !state.cachedSegments ||
    state.shouldRevalidate ||
    state.storedStale ||
    sent.length === 0
  ) {
    return false;
  }
  const stored = new Set(state.cachedSegments);
  return sent.every((s) => s.type !== "loader" && stored.has(s));
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
