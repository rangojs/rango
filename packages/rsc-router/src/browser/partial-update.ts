import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import { startTransition } from "react";

/**
 * Configuration for creating a partial updater
 */
export interface PartialUpdateConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
}

/**
 * Options that can override the pre-configured commit settings
 */
export interface CommitOverrides {
  /** Override scroll behavior (e.g., disable for intercepts) */
  scroll?: boolean;
}

/**
 * Commit context passed to partial updater for URL updates
 * Transaction encapsulates all store mutations for atomic commit
 */
export interface PartialUpdateCommit {
  commit(
    segmentIds: string[],
    segments: ResolvedSegment[],
    overrides?: CommitOverrides
  ): void;
}

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds: string[] | undefined,
  isRetry: boolean,
  signal: AbortSignal | undefined,
  tx: PartialUpdateCommit,
  options?: { isAction?: boolean }
) => Promise<Promise<void>>;

/**
 * Create a partial updater for fetching and applying RSC partial updates
 *
 * This function is shared between navigation-bridge and server-action-bridge
 * to handle partial RSC updates with HMR resilience.
 *
 * V2: Instead of rendering segments into a React tree, we pass segments
 * directly to onUpdate. The NavigationProviderV2 updates the segment store
 * and only affected components re-render.
 *
 * @param config - Partial update configuration
 * @returns fetchPartialUpdate function
 */
export function createPartialUpdater(
  config: PartialUpdateConfig
): PartialUpdater {
  const { store, client, onUpdate } = config;

  /**
   * Build a lookup map from current page's cached segments
   */
  function getCurrentSegmentMap(): Map<string, ResolvedSegment> {
    const currentKey = store.getHistoryKey();
    const cachedSegments = store.getCachedSegments(currentKey) || [];
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
    tx: PartialUpdateCommit,
    options?: { isAction?: boolean }
  ): Promise<Promise<void>> {
    const { isAction = false } = options || {};
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;
    const segments = segmentIds ?? segmentState.currentSegmentIds;

    console.log(`\n[Browser] >>> NAVIGATION`);
    console.log(`[Browser] From: ${segmentState.currentUrl}`);
    console.log(`[Browser] To: ${url}`);
    console.log(`[Browser] Segments to send: ${segments.join(", ")}`);

    // Set streaming state for navigations (actions handle their own streaming state)
    if (!isAction) {
      store.setState({ isStreaming: true });
    }

    // Get current page's segments for merging with server diff
    const currentSegmentMap = getCurrentSegmentMap();

    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    const { payload, streamComplete: rawStreamComplete } = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

    // Wrap stream completion to clear streaming state when done
    // Only clear if this navigation wasn't aborted (newer navigation handles its own state)
    const streamComplete = isAction
      ? rawStreamComplete
      : rawStreamComplete.then(() => {
          if (!signal?.aborted) {
            store.setState({ isStreaming: false });
          }
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
      const allSegments = matchedIds
        .map((id: string) => {
          // First check server response (new/updated segments)
          const fromServer = newSegmentMap.get(id);
          if (fromServer) return fromServer;
          // Fall back to current page's cached segments
          const fromCache = currentSegmentMap.get(id);
          if (!fromCache) {
            console.warn(`[Browser] Missing segment: ${id}`);
          }
          return fromCache;
        })
        .filter(Boolean) as ResolvedSegment[];

      // HMR RESILIENCE: Check if we're missing segments
      if (allSegments.length < matchedIds.length) {
        const missingCount = matchedIds.length - allSegments.length;
        const missingIds = matchedIds
          .filter(
            (id: string) => !newSegmentMap.has(id) && !currentSegmentMap.has(id)
          )
          .filter((s) => !!s);

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

      // Final abort check before committing
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

      // Track intercept context for action revalidation (only on navigation, not actions)
      if (!isAction) {
        if (hasActiveIntercept) {
          // Save the source URL for action revalidation to maintain intercept context
          store.setInterceptSourceUrl(segmentState.currentUrl);
        } else {
          // Clear intercept context when navigating to a non-intercept route
          store.setInterceptSourceUrl(null);
        }
      }

      // Commit navigation - transaction handles all store mutations atomically
      // Disable scroll for intercept responses to keep scroll position
      tx.commit(
        matchedIds,
        allSegments,
        hasActiveIntercept ? { scroll: false } : undefined
      );
      console.log("[partial-update] updating document");

      // Emit update with segments (V2: no tree rendering, just pass segments)
      // NavigationProviderV2 will update the segment store directly
      const updatePayload = {
        root: null, // V2: root not used, segments go to store
        metadata: {
          ...payload.metadata,
          segments: allSegments,
          diff,
        },
      };

      if (isAction) {
        startTransition(() => {
          onUpdate(updatePayload);
        });
      } else {
        onUpdate(updatePayload);
      }

      console.log(`[Browser] Navigation complete\n`);
      return streamComplete;
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);
      console.log("[partial-update] payload.metadata:", payload.metadata);

      const segments = payload.metadata?.segments || [];
      console.log("[partial-update] Full update segments:", segments.length, segments.map((s: ResolvedSegment) => s.id));

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

      // Emit update with segments (V2: full update, no diff)
      const updatePayload = {
        root: null, // V2: root not used
        metadata: {
          pathname: payload.metadata?.pathname ?? new URL(url).pathname,
          segments,
          isPartial: false,
        },
      };

      console.log("[partial-update] Emitting full update:", {
        segmentCount: segments.length,
        segmentIds: segments.map((s: ResolvedSegment) => s.id),
        pathname: updatePayload.metadata.pathname,
      });

      if (isAction) {
        startTransition(() => {
          onUpdate(updatePayload);
        });
      } else {
        onUpdate(updatePayload);
      }

      return streamComplete;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
