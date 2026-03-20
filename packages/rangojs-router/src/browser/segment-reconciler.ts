import type { ResolvedSegment } from "./types.js";
import {
  mergeSegmentLoaders,
  needsLoaderMerge,
  insertMissingDiffSegments,
} from "./merge-segment-loaders.js";
import { assertSegmentStructure } from "./segment-structure-assert.js";
import { splitInterceptSegments } from "./intercept-utils.js";

/**
 * Determines the merging behavior for segment reconciliation.
 *
 * - 'action': From server-action-bridge's own merge. Always merges loaders,
 *   always preserves cached loading (even undefined), never clears cached
 *   segment loading.
 * - 'navigation': From partial-update during normal navigation. Does NOT merge
 *   loaders, preserves cached loading only when defined, clears truthy loading
 *   on cached segments not in server diff.
 * - 'stale-revalidation': From partial-update during stale revalidation or
 *   action-triggered refetch. Merges loaders, always preserves cached loading
 *   (same as action), clears truthy loading on cached segments not in server diff.
 */
export type ReconcileActor = "navigation" | "action" | "stale-revalidation";

export interface ReconcileInput {
  actor: ReconcileActor;
  /** All segment IDs the server expects the client to have (matched array) */
  matched: string[];
  /** Segment IDs that changed (diff array) */
  diff: string[];
  /** Segments returned from server (raw array, keyed internally by ID) */
  serverSegments: ResolvedSegment[];
  /** Cached segments from current page (raw array, keyed internally by ID) */
  cachedSegments: ResolvedSegment[];
  /** When true, diff segments not in matched are inserted after their parent
   *  layout. Used during navigation when consolidation fetch returns loader
   *  segments that aren't in the matched array. */
  insertMissingDiff?: boolean;
}

export interface ReconcileResult {
  /** All merged segments in matched order (for caching and committing) */
  segments: ResolvedSegment[];
  /** Main segments excluding intercepts (for rendering) */
  mainSegments: ResolvedSegment[];
  /** Intercept segments only (passed via render options) */
  interceptSegments: ResolvedSegment[];
}

/**
 * Single source of truth for merging server segments with cached segments.
 *
 * Replaces the duplicated merge loops in server-action-bridge.ts and
 * partial-update.ts. The actor parameter controls the subtle behavioral
 * differences between action and navigation merging:
 *
 * Loading preservation:
 * - action/stale-revalidation: Always preserves cached loading value when it
 *   differs from server (even when cached is undefined). This prevents tree
 *   structure changes that would remount components and destroy useActionState
 *   during action revalidation or action-triggered refetch.
 * - navigation: Preserves cached loading only when the cached value is defined
 *   (not undefined). When cached is undefined, lets server value through
 *   because we're building a new tree.
 *
 * Loader merging:
 * - action/stale-revalidation: Merges partial loader data when server returns
 *   fewer loaders than cached (revalidation only updated some loaders).
 * - navigation: Does not merge (full navigation fetches complete data).
 *
 * Cached segment handling (segments in matched but not in server response):
 * - action: Returns cached segment as-is (preserve tree structure).
 * - navigation/stale-revalidation: Clears truthy loading to undefined
 *   (prevents showing stale skeletons), but preserves loading=false
 *   (suppressed boundary is structural).
 */
export function reconcileSegments(input: ReconcileInput): ReconcileResult {
  const { actor, matched, diff, insertMissingDiff } = input;
  const shouldMergeLoaders = actor !== "navigation";
  const context = actor === "action" ? "action-bridge" : "partial-update";

  // Build lookup maps from arrays
  const serverSegments = new Map<string, ResolvedSegment>();
  input.serverSegments.forEach((s) => serverSegments.set(s.id, s));
  const cachedSegments = new Map<string, ResolvedSegment>();
  input.cachedSegments.forEach((s) => cachedSegments.set(s.id, s));

  const segments = matched
    .map((segId: string) => {
      const fromServer = serverSegments.get(segId);
      const fromCache = cachedSegments.get(segId);

      if (fromServer) {
        // Merge partial loader data when server returns fewer loaders than cached
        if (shouldMergeLoaders && needsLoaderMerge(fromServer, fromCache)) {
          return mergeSegmentLoaders(fromServer, fromCache);
        }

        // Preserve cached structural properties to maintain consistent React tree.
        // Changing these between renders alters the element nesting
        // (with/without RouteContentWrapper, MountContextProvider, etc.),
        // causing React to remount components and destroy useActionState.
        if (fromCache) {
          let merged = fromServer;

          // When server returns component: null for a layout segment, it means
          // "this segment doesn't need re-rendering" - preserve the cached component
          // to maintain the outlet chain and prevent React tree changes
          if (
            fromServer.component === null &&
            fromServer.type === "layout" &&
            fromCache.component != null
          ) {
            merged = { ...merged, component: fromCache.component };
          }

          // Loading preservation is actor-aware:
          // - action/stale-revalidation: always preserve cached value to prevent
          //   tree remount (even when cached is undefined, to avoid adding a
          //   Suspense boundary that wasn't there before)
          // - navigation: only when cached is defined (building a new tree)
          if (actor !== "navigation") {
            if (fromServer.loading !== fromCache.loading) {
              merged = { ...merged, loading: fromCache.loading };
            }
          } else {
            if (
              fromCache.loading !== undefined &&
              fromServer.loading !== fromCache.loading
            ) {
              merged = { ...merged, loading: fromCache.loading };
            }
          }

          // mountPath: SSR segments may lack mountPath while revalidated segments
          // include it. The conditional MountContextProvider wrapper changes tree depth.
          if (fromServer.mountPath !== fromCache.mountPath) {
            merged = { ...merged, mountPath: fromCache.mountPath };
          }

          // Dev-mode assertion: warn if the merged result still differs from cache
          // in tree-structural properties. This catches bugs where the merge code
          // above fails to preserve a value it should have.
          assertSegmentStructure(fromCache, merged, context);

          return merged;
        }
        return fromServer;
      }

      // Fall back to cached segment (server expects client to already have it)
      if (!fromCache) {
        if (actor === "action") {
          console.error(`[Browser] MISSING SEGMENT: ${segId} not in cache!`);
        } else {
          console.warn(`[Browser] Missing segment: ${segId}`);
        }
        return fromCache;
      }

      // For non-action actors: cached segments the server decided not to re-render.
      // - Preserve loading=false (suppressed boundary) to maintain tree structure
      // - Preserve parallel segment loading so renderSegments can reconstruct
      //   parallel-owned loader markers from the cached slot metadata
      // - Clear other truthy loading values to prevent suspense on cached content
      if (actor !== "action") {
        if (fromCache.type === "parallel" && fromCache.loading !== undefined) {
          return fromCache;
        }
        if (fromCache.loading !== undefined && fromCache.loading !== false) {
          return { ...fromCache, loading: undefined };
        }
      }

      return fromCache;
    })
    .filter(Boolean) as ResolvedSegment[];

  // Insert diff segments not in matched (e.g., loader segments from consolidation fetch).
  // Only needed during navigation - action bridge doesn't use this.
  if (insertMissingDiff) {
    const matchedIdSet = new Set(matched);
    insertMissingDiffSegments(segments, diff, matchedIdSet, serverSegments);
  }

  const { main, intercept } = splitInterceptSegments(segments);

  return {
    segments,
    mainSegments: main,
    interceptSegments: intercept,
  };
}

/**
 * Reconcile error segments with cached segments.
 *
 * For error responses, the server returns the error boundary segment.
 * This function overlays error segments onto the full cached tree,
 * preserving sibling layouts that aren't in the error parent chain.
 */
export function reconcileErrorSegments(
  cachedSegments: ResolvedSegment[],
  errorSegments: ResolvedSegment[],
): ReconcileResult {
  const errorMap = new Map<string, ResolvedSegment>();
  errorSegments.forEach((s) => errorMap.set(s.id, s));

  const segments = cachedSegments.map((cached) => {
    const fromServer = errorMap.get(cached.id);
    return fromServer || cached;
  });

  const { main, intercept } = splitInterceptSegments(segments);

  return {
    segments,
    mainSegments: main,
    interceptSegments: intercept,
  };
}
