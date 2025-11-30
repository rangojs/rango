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
  renderSegments: (segments: ResolvedSegment[]) => Promise<ReactNode> | ReactNode;
}

/**
 * Commit context passed to partial updater for URL updates
 * Transaction encapsulates all store mutations for atomic commit
 */
export interface PartialUpdateCommit {
  commit(segmentIds: string[]): void;
}

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds: string[] | undefined,
  isRetry: boolean,
  signal: AbortSignal | undefined,
  tx: PartialUpdateCommit
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
   * @param tx - Transaction for committing segment state (required)
   * @param signal - AbortSignal to check if navigation is stale (not for aborting fetch)
   */
  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds: string[] | undefined,
    isRetry: boolean,
    signal: AbortSignal | undefined,
    tx: PartialUpdateCommit
  ): Promise<Promise<void>> {
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;
    const segments = segmentIds ?? segmentState.currentSegmentIds;

    console.log(`\n[Browser] >>> NAVIGATION`);
    console.log(`[Browser] From: ${segmentState.currentUrl}`);
    console.log(`[Browser] To: ${url}`);
    console.log(`[Browser] Segments to send: ${segments.join(", ")}`);

    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    const { payload, streamComplete } = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      // Always store received segments, even if navigation is aborted.
      // The segment data is still valid and might be needed by the next navigation.
      // This prevents the "missing segments" HMR retry when navigations overlap.
      store.storeSegments(newSegments || []);

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        console.log(`[Browser] Ignoring stale navigation (aborted, but segments stored)`);
        return streamComplete;
      }

      console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      console.log(`[Browser] Diff: ${diff?.join(", ")}`);

      // If diff is empty, nothing changed - skip UI update but commit URL
      if (!diff || diff.length === 0) {
        console.log(
          `[Browser] No changes - all revalidations returned false, keeping existing UI`
        );
        tx.commit(matched || []);
        console.log(`[Browser] Navigation complete (no re-render)\n`);
        return streamComplete;
      }

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
        return fetchPartialUpdate(url, [], true, signal, tx);
      }

      console.log(
        `[Browser] Merged segments: ${fullSegments.map((s) => s.id).join(", ")}`
      );

      // Rebuild tree on client (await for loader data resolution)
      // Race against abort signal to allow cancellation during loader awaiting
      console.log("[partial-update] Starting renderSegments...");
      const startTime = Date.now();
      const newTree = await (signal
        ? Promise.race([
            renderSegments(fullSegments),
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException("Navigation aborted", "AbortError"));
              }
              signal.addEventListener("abort", () => {
                reject(new DOMException("Navigation aborted", "AbortError"));
              });
            }),
          ])
        : renderSegments(fullSegments));
      console.log(`[partial-update] renderSegments completed in ${Date.now() - startTime}ms`);

      // Commit navigation - transaction handles all store mutations atomically
      tx.commit(matchedIds);

      // Emit update to trigger React render
      onUpdate({
        root: newTree,
        metadata: payload.metadata,
      });

      console.log(`[Browser] Navigation complete\n`);
      return streamComplete;
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);

      // Always store received segments, even if navigation is aborted
      const segments = payload.metadata?.segments || [];
      store.storeSegments(segments);

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        console.log(`[Browser] Ignoring stale navigation (aborted, but segments stored)`);
        return streamComplete;
      }

      // Await loader data from segments before committing URL
      // This ensures URL only updates after loaders resolve
      const loaderSegments = segments.filter(
        (s: ResolvedSegment) => s.type === "loader" && s.loaderData !== undefined
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

      const segmentIds = segments.map((s: any) => s.id);

      // Commit navigation - transaction handles all store mutations atomically
      tx.commit(segmentIds);

      // Emit update to trigger React render
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
