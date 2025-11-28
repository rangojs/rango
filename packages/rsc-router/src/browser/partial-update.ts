import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import type { ReactNode } from "react";

/**
 * Configuration for creating a partial updater
 */
export interface PartialUpdateConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
  renderSegments: (segments: ResolvedSegment[]) => ReactNode;
}

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds?: string[],
  isRetry?: boolean,
  signal?: AbortSignal
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
export function createPartialUpdater(config: PartialUpdateConfig): PartialUpdater {
  const { store, client, onUpdate, renderSegments } = config;

  /**
   * Fetch partial update and trigger UI update
   * Returns a promise that resolves when the RSC stream is fully consumed
   *
   * @param signal - AbortSignal to check if navigation is stale (not for aborting fetch)
   */
  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds?: string[],
    isRetry = false,
    signal?: AbortSignal
  ): Promise<Promise<void>> {
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;
    const segments = segmentIds ?? segmentState.currentSegmentIds;

    console.log(`\n[Browser] >>> NAVIGATION`);
    console.log(`[Browser] From: ${segmentState.currentUrl}`);
    console.log(`[Browser] To: ${url}`);
    console.log(`[Browser] Segments to send: ${segments.join(", ")}`);

    // Optimistically set the new path
    store.setPath(new URL(url).pathname);

    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    const { payload, streamComplete } = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

    // Check if this navigation is stale (a newer one started)
    if (signal?.aborted) {
      console.log(`[Browser] Ignoring stale navigation (aborted)`);
      return streamComplete;
    }

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      console.log(`[Browser] Diff: ${diff?.join(", ")}`);

      // If diff is empty, nothing changed - skip update
      if (!diff || diff.length === 0) {
        console.log(
          `[Browser] No changes - all revalidations returned false, keeping existing UI`
        );
        store.setCurrentUrl(url);
        store.setPath(new URL(url).pathname);
        console.log(`[Browser] Navigation complete (no re-render)\n`);
        return streamComplete;
      }

      // Update stored segments with new ones
      store.storeSegments(newSegments || []);

      // Build full segment list by merging
      const matchedIds = matched || [];
      const fullSegments = matchedIds
        .map((id: string) => {
          const segment = store.getSegmentState().storedSegments.get(id);
          if (!segment) {
            console.warn(`[Browser] Missing segment: ${id}`);
          }
          return segment;
        })
        .filter(Boolean) as ResolvedSegment[];

      // HMR RESILIENCE: Check if we're missing segments
      if (fullSegments.length < matchedIds.length) {
        const missingCount = matchedIds.length - fullSegments.length;
        const missingIds = matchedIds.filter(
          (id: string) => !store.getSegmentState().storedSegments.has(id)
        );

        if (isRetry) {
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: ${missingIds.join(", ")}`
          );
        }

        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`
        );

        // Refetch with empty segments = server sends everything
        return fetchPartialUpdate(url, [], true, signal);
      }

      console.log(
        `[Browser] Merged segments: ${fullSegments.map((s) => s.id).join(", ")}`
      );

      // Rebuild tree on client
      const newTree = renderSegments(fullSegments);

      // Update segment IDs
      store.setSegmentIds(matchedIds);
      store.setCurrentUrl(url);

      // Emit update
      onUpdate({
        root: newTree,
        metadata: payload.metadata,
      });

      console.log(`[Browser] Navigation complete\n`);
      return streamComplete;
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);
      store.setSegmentIds(
        payload.metadata?.segments?.map((s: any) => s.id) || []
      );
      store.setCurrentUrl(url);
      store.setPath(new URL(url).pathname);

      onUpdate({
        root: payload.root,
        metadata: payload.metadata!,
      });
      return streamComplete;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
