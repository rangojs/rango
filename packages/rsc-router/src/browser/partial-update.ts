import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import type { ReactNode } from "react";
import { startTransition } from "react";
import type { RenderSegmentsOptions } from "../segment-system.js";
import {
  mergeSegmentLoaders,
  needsLoaderMerge,
  insertMissingDiffSegments,
} from "./merge-segment-loaders.js";
import type { BoundTransaction } from "./navigation-bridge.js";

/**
 * Configuration for creating a partial updater
 */
export interface PartialUpdateConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
  renderSegments: (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions
  ) => Promise<ReactNode> | ReactNode;
}

/**
 * Options that can override the pre-configured commit settings
 */
export interface CommitOverrides {
  /** Override scroll behavior (e.g., disable for intercepts) */
  scroll?: boolean;
  /** Override replace behavior (e.g., force replace for intercepts) */
  replace?: boolean;
  /** Mark this as an intercept route */
  intercept?: boolean;
  /** Source URL where intercept was triggered from */
  interceptSourceUrl?: string;
}

/**
 * Commit context passed to partial updater for URL updates
 * Transaction encapsulates all store mutations for atomic commit
 */

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds: string[] | undefined,
  isRetry: boolean,
  signal: AbortSignal | undefined,
  type: BoundTransaction,
  options?: {
    isAction?: boolean;
    staleRevalidation?: boolean;
    interceptSourceUrl?: string;
  }
) => Promise<Promise<void>>;

/**
 * Create a partial updater for fetching and applying RSC partial updates
 *
 * This function is shared between navigation-bridge and server-action-bridge
 * to handle partial RSC updates with HMR resilience.
 *
 * @param config - Partial update configuration
 * @returns fetchPartialUpdate function
 *
 * @example
 * ```typescript
 * const fetchPartialUpdate = createPartialUpdater({
 *   store,
 *   client,
 *   onUpdate: (update) => store.emit(update),
 *   renderSegments,
 * });
 *
 * await fetchPartialUpdate('/new-page');
 * ```
 */
export function createPartialUpdater(
  config: PartialUpdateConfig
): PartialUpdater {
  const { store, client, onUpdate, renderSegments } = config;

  /**
   * Build a lookup map from current page's cached segments
   */
  function getCurrentSegmentMap(): Map<string, ResolvedSegment> {
    const currentKey = store.getHistoryKey();
    const cached = store.getCachedSegments(currentKey);
    const cachedSegments = cached?.segments || [];
    const map = new Map<string, ResolvedSegment>();
    cachedSegments.forEach((s) => map.set(s.id, s));
    return map;
  }

  /**
   * Fetch partial update and trigger UI update
   * Returns a promise that resolves when the RSC stream is fully consumed
   *
   * @param tx - Transaction for committing segment state (required)
   * @param signal - AbortSignal to check if navigation is stale (not for aborting fetch)
   */
  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds: string[] | undefined,
    isRetry: boolean,
    signal: AbortSignal | undefined,
    tx: BoundTransaction,
    options?: {
      isAction?: boolean;
      staleRevalidation?: boolean;
      interceptSourceUrl?: string;
    }
  ): Promise<Promise<void>> {
    const {
      isAction = false,
      staleRevalidation = false,
      interceptSourceUrl,
    } = options || {};
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;

    // Capture history key at start for stale revalidation consistency check
    const historyKeyAtStart = store.getHistoryKey();
    const segments = segmentIds ?? segmentState.currentSegmentIds;

    // For intercept revalidation, use the intercept source URL as previousUrl
    // This tells the server the route should be treated as an intercept
    const previousUrl =
      interceptSourceUrl || tx.currentUrl || segmentState.currentUrl;

    console.log(`\n[Browser] >>> NAVIGATION`);
    console.log(`[Browser] From: ${previousUrl}`);
    console.log(`[Browser] To: ${url}`);
    console.log(`[Browser] Segments to send: ${segments.join(", ")}`);
    if (interceptSourceUrl) {
      console.log(`[Browser] Intercept context from: ${interceptSourceUrl}`);
    }

    // Get current page's segments for merging with server diff
    const currentSegmentMap = getCurrentSegmentMap();
    // Mark navigation as streaming (response received, now parsing RSC)
    // The token is ended when the stream completes
    const streamingToken = tx.startStreaming();
    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    const { payload, streamComplete: rawStreamComplete } =
      await client.fetchPartial({
        targetUrl: url,
        segmentIds: segments,
        previousUrl,
        staleRevalidation,
      });

    const streamComplete = rawStreamComplete.then(() => {
      streamingToken.end();
    });

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        console.log(`[Browser] Ignoring stale navigation (aborted)`);
        return streamComplete;
      }

      console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      console.log(`[Browser] Diff: ${diff?.join(", ")}`);

      // Create lookup for new segments from server
      const newSegmentMap = new Map<string, ResolvedSegment>();
      (newSegments || []).forEach((s: ResolvedSegment) =>
        newSegmentMap.set(s.id, s)
      );

      // If diff is empty, nothing changed - skip UI update but commit URL
      // Still need to collect full segments for history cache
      if (!diff || diff.length === 0) {
        console.log(
          `[Browser] No changes - all revalidations returned false, keeping existing UI`
        );
        const matchedIds = matched || [];
        const existingSegments = matchedIds
          .map((id: string) => currentSegmentMap.get(id))
          .filter(Boolean) as ResolvedSegment[];
        tx.commit(matchedIds, existingSegments);
        console.log(`[Browser] Navigation complete (no re-render)\n`);
        return streamComplete;
      }

      // Build full segment list by merging:
      // - New/changed segments from server response (diff)
      // - Unchanged segments from current page's cache
      const matchedIds = matched || [];
      console.log(`[Browser] matchedIds: ${matchedIds.join(", ")}`);
      console.log(
        `[Browser] currentSegmentMap keys: ${[...currentSegmentMap.keys()].join(", ")}`
      );
      console.log(
        `[Browser] newSegmentMap keys: ${[...newSegmentMap.keys()].join(", ")}`,
        newSegmentMap
      );

      // First pass: build segments from matched IDs
      const matchedIdSet = new Set(matchedIds);
      const allSegments = matchedIds
        .map((id: string) => {
          // First check server response (new/updated segments)
          const fromServer = newSegmentMap.get(id);
          if (fromServer) {
            // For partial revalidation (stale or action), merge server's new loader data
            // with cached loader data when server returns fewer loaders than cached
            const fromCache = currentSegmentMap.get(id);
            if (
              (staleRevalidation || isAction) &&
              needsLoaderMerge(fromServer, fromCache)
            ) {
              return mergeSegmentLoaders(fromServer, fromCache);
            }
            return fromServer;
          }
          // Fall back to current page's cached segments
          const fromCache = currentSegmentMap.get(id);
          if (!fromCache) {
            console.warn(`[Browser] Missing segment: ${id}`);
          }
          return fromCache;
        })
        .filter(Boolean) as ResolvedSegment[];

      // Insert diff segments not in matchedIds (e.g., loader segments from consolidation fetch)
      insertMissingDiffSegments(allSegments, diff, matchedIdSet, newSegmentMap);

      // HMR RESILIENCE: Check if we're missing any matched segments
      // Note: allSegments may include additional diff segments, so we check matchedIds specifically
      const allSegmentIdSet = new Set(allSegments.map((s) => s.id));
      const missingIds = matchedIds.filter(
        (id: string) => !allSegmentIdSet.has(id)
      );

      if (missingIds.length > 0) {
        const missingCount = missingIds.length;

        if (isRetry) {
          console.warn("Missing ids", { missingIds });
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: [${missingIds.join(", ")}]`
          );
        }
        if (signal?.aborted) {
          console.log(
            `[Browser] Ignoring stale navigation (aborted during HMR retry)`
          );
          return streamComplete;
        }
        if (isAction) {
          return streamComplete;
        }
        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`
        );

        // Refetch with empty segments = server sends everything
        return fetchPartialUpdate(url, [], true, signal, tx, { isAction });
      }

      // INTERCEPT HANDLING: Separate intercept segments for explicit injection
      // Intercept segments have namespace starting with "intercept:" or ID containing .@
      // This makes the flow clearer and easier to debug
      const isInterceptSegment = (s: ResolvedSegment) =>
        s.namespace?.startsWith("intercept:") ||
        (s.type === "parallel" && s.id.includes(".@"));

      const interceptSegments = allSegments.filter(isInterceptSegment);
      const mainSegments = allSegments.filter((s) => !isInterceptSegment(s));

      if (signal?.aborted) {
        console.log(
          `[Browser] Ignoring stale navigation (aborted before render)`
        );
        return streamComplete;
      }

      // Rebuild tree on client (await for loader data resolution)
      // Race against abort signal to allow cancellation during loader awaiting
      // Pass intercept segments separately for explicit handling
      // For stale revalidation, use forceAwait to ensure no loading fallbacks
      const renderOptions = {
        isAction,
        forceAwait: staleRevalidation,
        interceptSegments:
          interceptSegments.length > 0 ? interceptSegments : undefined,
      };
      const newTree = await (signal
        ? Promise.race([
            renderSegments(mainSegments, renderOptions),
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException("Navigation aborted", "AbortError"));
              }
              signal.addEventListener("abort", () => {
                reject(new DOMException("Navigation aborted", "AbortError"));
              });
            }),
          ])
        : renderSegments(mainSegments, renderOptions));

      // Final abort check before committing - another navigation may have started
      if (signal?.aborted) {
        console.log(
          `[Browser] Ignoring stale navigation (aborted before commit)`
        );
        return streamComplete;
      }

      // Check if this is an intercept response (any slot is active)
      // If so, disable scroll to keep the current scroll position
      const hasActiveIntercept = payload.metadata?.slots
        ? Object.values(payload.metadata.slots).some((slot) => slot.active)
        : false;

      // Track intercept context for action revalidation (only on navigation, not actions or stale revalidation)
      if (!isAction && !staleRevalidation) {
        if (hasActiveIntercept) {
          // Save the source URL for action revalidation to maintain intercept context
          store.setInterceptSourceUrl(segmentState.currentUrl);
        } else {
          // Clear intercept context when navigating to a non-intercept route
          store.setInterceptSourceUrl(null);
        }
      }

      // Commit navigation - transaction handles all store mutations atomically
      // For intercept responses: disable scroll, mark as intercept, include source URL
      // Use allSegmentIds (derived from allSegments) instead of matchedIds because
      // we may have added diff segments (like loader segments) not in the matched array
      const allSegmentIds = allSegments.map((s) => s.id);
      tx.commit(
        allSegmentIds,
        allSegments,
        hasActiveIntercept
          ? {
              scroll: false,
              intercept: true,
              interceptSourceUrl: segmentState.currentUrl,
            }
          : undefined
      );

      // For stale revalidation: verify history key hasn't changed before updating UI
      // If user navigated away, skip UI update to avoid corrupting current view
      if (staleRevalidation) {
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          console.log(
            `[Browser] Stale revalidation: history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`
          );
          return streamComplete;
        }
      }

      console.log("[partial-update] updating document");

      // Emit update to trigger React render
      // For stale revalidation: wait for stream to complete (loaders resolved), then update
      // For actions: wrap in startTransition to avoid UI flickering
      if (isAction || staleRevalidation) {
        startTransition(() => {
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
          });
        });
      } else {
        onUpdate({
          root: newTree,
          metadata: payload.metadata!,
        });
      }

      console.log(`[Browser] Navigation complete\n`);
      return streamComplete;
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);

      const segments = payload.metadata?.segments || [];

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        console.log(`[Browser] Ignoring stale navigation (aborted)`);
        return streamComplete;
      }

      // Await loader data from segments before committing URL
      // This ensures URL only updates after loaders resolve
      const loaderSegments = segments.filter(
        (s: ResolvedSegment) =>
          s.type === "loader" && s.loaderData !== undefined
      );
      if (loaderSegments.length > 0) {
        console.log(`[Browser] Awaiting ${loaderSegments.length} loader(s)...`);
        await Promise.all(
          loaderSegments.map((s: ResolvedSegment) =>
            s.loaderData instanceof Promise
              ? s.loaderData
              : Promise.resolve(s.loaderData)
          )
        );
        console.log(`[Browser] Loaders resolved`);
      }

      const segmentIds = segments.map((s: ResolvedSegment) => s.id);

      // Final abort check before committing - another navigation may have started
      if (signal?.aborted) {
        console.log(
          `[Browser] Ignoring stale navigation (aborted before commit)`
        );
        return streamComplete;
      }

      // Commit navigation - transaction handles all store mutations atomically
      tx.commit(segmentIds, segments);

      // Emit update to trigger React render
      // For stale revalidation: wait for stream to complete, then update
      // For actions: wrap in startTransition to avoid UI flickering
      if (staleRevalidation) {
        await rawStreamComplete;
        startTransition(() => {
          onUpdate({
            root: payload.root,
            metadata: payload.metadata!,
          });
        });
      } else if (isAction) {
        startTransition(async () => {
          onUpdate({
            root: payload.root,
            metadata: payload.metadata!,
          });
        });
      } else {
        onUpdate({
          root: payload.root,
          metadata: payload.metadata!,
        });
      }

      return streamComplete;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
