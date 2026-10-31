import type { ResolvedSegment } from "./types.js";
import { insertMissingDiffSegments } from "./merge-segment-loaders.js";
import { assertSegmentStructure } from "./segment-structure-assert.js";
import { splitInterceptSegments } from "./intercept-utils.js";
import { debugLog, IS_BROWSER_DEBUG } from "./logging.js";

/**
 * Determines the merging behavior for segment reconciliation.
 *
 * - 'action': From server-action-bridge's own merge. Always preserves cached
 *   loading (even undefined), never clears cached segment loading.
 * - 'navigation': From partial-update during normal navigation. Preserves
 *   cached loading only when defined, clears truthy loading on cached
 *   segments not in server diff.
 * - 'stale-revalidation': From partial-update during stale revalidation or
 *   action-triggered refetch. Always preserves cached loading (same as
 *   action), clears truthy loading on cached segments not in server diff.
 *
 * No actor merges loader data: a loader the server skipped, an intercept's
 * included, is its own cached segment in `matched`.
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
 * A segment the server sent over its cached copy, keeping the cached
 * structural properties so the React tree keeps its shape. Changing them
 * between renders alters the element nesting (with/without
 * RouteContentWrapper, MountContextProvider, etc.), which remounts components
 * and destroys useActionState.
 */
function mergeCached(
  fromServer: ResolvedSegment,
  fromCache: ResolvedSegment,
  actor: ReconcileActor,
): ResolvedSegment {
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
  if (
    fromServer.loading !== fromCache.loading &&
    (actor !== "navigation" || fromCache.loading !== undefined)
  ) {
    merged = { ...merged, loading: fromCache.loading };
  }

  // mountPath: SSR segments may lack mountPath while revalidated segments
  // include it. The conditional MountContextProvider wrapper changes tree depth.
  if (fromServer.mountPath !== fromCache.mountPath) {
    merged = { ...merged, mountPath: fromCache.mountPath };
  }

  // Dev-mode assertion: warn if the merged result still differs from cache
  // in tree-structural properties. This catches bugs where the merge code
  // above fails to preserve a value it should have.
  assertSegmentStructure(
    fromCache,
    merged,
    actor === "action" ? "action-bridge" : "partial-update",
  );
  return merged;
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
 * Cached segment handling (segments in matched but not in server response):
 * - action: Returns cached segment as-is (preserve tree structure).
 * - navigation/stale-revalidation: Clears truthy loading to undefined
 *   (prevents showing stale skeletons), but preserves loading=false
 *   (suppressed boundary is structural).
 */
export function reconcileSegments(input: ReconcileInput): ReconcileResult {
  const { actor, matched, diff, insertMissingDiff } = input;

  // Build lookup maps from arrays
  const serverSegments = new Map<string, ResolvedSegment>();
  input.serverSegments.forEach((s) => serverSegments.set(s.id, s));
  const cachedSegments = new Map<string, ResolvedSegment>();
  input.cachedSegments.forEach((s) => cachedSegments.set(s.id, s));

  const diffSet = new Set(diff);
  // A clientUrls() layout() loader the server held on a navigation between
  // two routes of the layout (client-urls/layout-loader-copies.ts): matched
  // names it under the destination route, the page holds it under the group
  // route it leaves. Its copy keeps its data under the new id.
  const origin = input.cachedSegments.find((s) => s.clientGroup);
  const destination =
    origin &&
    input.serverSegments.find((s) => s.clientGroup === origin.clientGroup);
  const carried = (id: string) => {
    const copy =
      destination && cachedSegments.get(id.replace(destination.id, origin.id));
    return copy && { ...copy, id };
  };
  if (IS_BROWSER_DEBUG) {
    debugLog(
      `[reconcile] actor=${actor}, matched=${matched.length}, diff=${diff.length}`,
    );
    debugLog(
      `[reconcile] server segments: ${[...serverSegments.keys()].join(", ")}`,
    );
    debugLog(
      `[reconcile] cached segments: ${[...cachedSegments.keys()].join(", ")}`,
    );
  }

  const segments = matched
    .map((segId: string) => {
      const fromServer = serverSegments.get(segId);
      let fromCache = cachedSegments.get(segId);

      if (fromServer) {
        const inDiff = diffSet.has(segId);
        if (fromCache) {
          if (IS_BROWSER_DEBUG) {
            debugLog(
              `[reconcile] ${segId}: SERVER+CACHE merge (${inDiff ? "in diff" : "not in diff"}, type=${fromServer.type}, component=${fromServer.component === null ? "null→cached" : "server"})`,
            );
          }
          return mergeCached(fromServer, fromCache, actor);
        }
        if (IS_BROWSER_DEBUG) {
          debugLog(
            `[reconcile] ${segId}: SERVER only (${inDiff ? "in diff" : "not in diff"}, type=${fromServer.type}, no cache entry)`,
          );
        }
        return fromServer;
      }

      // Fall back to cached segment (server expects client to already have it)
      fromCache ??= carried(segId);
      if (!fromCache) {
        if (actor === "action") {
          console.error(`[Browser] MISSING SEGMENT: ${segId} not in cache!`);
        } else {
          console.warn(`[Browser] Missing segment: ${segId}`);
        }
        return fromCache;
      }

      if (IS_BROWSER_DEBUG) {
        debugLog(
          `[reconcile] ${segId}: CACHE only (not from server, type=${fromCache.type}, component=${fromCache.component != null ? "yes" : "null"})`,
        );
      }

      // Return the cached segment as-is, regardless of actor. We used to clear
      // truthy `loading` here to prevent a stale Suspense fallback from
      // committing against cached content, but that swapped the render tree
      // from the LoaderBoundary branch to the plain OutletProvider branch
      // inside renderSegments, causing React to unmount the entire chain
      // (LoaderBoundary > Suspense > LoaderResolver > RouteContentWrapper >
      // Suspender) every time the user opened an intercept or navigated back
      // to a cached page. The flicker is now prevented by renderSegments
      // handing the boundary settled content and loader data, so preserving
      // `loading` keeps the element tree stable.
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
 * Reconcile an error-boundary response with cached segments.
 *
 * The server returns the error boundary segment and, above it, what the
 * action's revalidation re-ran (rsc/server-action.ts). This function overlays
 * them onto the full cached tree, preserving sibling layouts that aren't in
 * the error parent chain. The error segment replaces its cached copy; every
 * other segment merges as an action's does (mergeCached).
 */
export function reconcileErrorSegments(
  cachedSegments: ResolvedSegment[],
  errorSegments: ResolvedSegment[],
): ReconcileResult {
  const errorMap = new Map<string, ResolvedSegment>();
  errorSegments.forEach((s) => errorMap.set(s.id, s));

  const segments = cachedSegments.map((cached) => {
    const fromServer = errorMap.get(cached.id);
    return !fromServer
      ? cached
      : fromServer.type === "error"
        ? fromServer
        : mergeCached(fromServer, cached, "action");
  });

  const { main, intercept } = splitInterceptSegments(segments);

  return {
    segments,
    mainSegments: main,
    interceptSegments: intercept,
  };
}

/**
 * The ids a page holds once an action's error boundary `boundary` shows: the
 * ones above it. Nothing at or below the boundary ran after the action's
 * write (its response and the follow-up cut there), so the next request must
 * not hold it. ShortCodes nest, so those ids start with the boundary's: the
 * boundary, its loaders (`${id}D…`), its slots and every entry under it. A
 * sibling with a longer index (`…R10` beside `…R1`) is kept.
 */
export function idsAboveBoundary(
  ids: string[],
  boundary: string | undefined,
): string[] {
  return boundary
    ? ids.filter(
        (id) =>
          !id.startsWith(boundary) || /\d/.test(id.charAt(boundary.length)),
      )
    : ids;
}

/**
 * The error segment of every action error boundary committed, by identity
 * (server-action-bridge.ts adds and deletes). An entry shows one while its
 * cached list still holds that object: a later commit on the entry replaces
 * the list, and a refetch that holds the boundary keeps it. Weak, so a
 * replaced boundary is not kept alive. Two routers never share a segment
 * object. No hook reads it.
 */
export const actionBoundaries: WeakSet<ResolvedSegment> = new WeakSet();

/**
 * The index of the deepest action error boundary in `segments`, -1 for none.
 * It is that action's outcome, which no GET reproduces: a background refetch
 * of the page (the follow-up, Back/Forward's stale revalidation, the
 * cross-tab refresh) holds it and renders what is above it. At 0 nothing is
 * above it.
 */
export function actionBoundaryAt(segments: readonly ResolvedSegment[]): number {
  let at = segments.length;
  while (at-- && !actionBoundaries.has(segments[at]));
  return at;
}
