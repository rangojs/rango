import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import type { ReactNode } from "react";
import { startTransition } from "react";
import type { RenderSegmentsOptions } from "../segment-system.js";

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
 * Commit context passed to partial updater for URL updates
 * Transaction encapsulates all store mutations for atomic commit
 */
export interface PartialUpdateCommit {
  commit(segmentIds: string[], segments: ResolvedSegment[]): void;
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

    // Get current page's segments for merging with server diff
    const currentSegmentMap = getCurrentSegmentMap();

    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    const { payload, streamComplete } = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff, isIntercept } = payload.metadata;

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        console.log(`[Browser] Ignoring stale navigation (aborted)`);
        return streamComplete;
      }

      console.log(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      console.log(`[Browser] Diff: ${diff?.join(", ")}`);
      if (isIntercept) {
        console.log(`[Browser] INTERCEPT: Merging with existing page segments`);
      }

      // Create lookup for new segments from server
      const newSegmentMap = new Map<string, ResolvedSegment>();
      (newSegments || []).forEach((s: ResolvedSegment) =>
        newSegmentMap.set(s.id, s)
      );

      // If diff is empty, check if we need to update due to segment removal
      // This happens when navigating FROM an intercept (has @modal) TO a regular route (no @modal)
      if (!diff || diff.length === 0) {
        const matchedIds = matched || [];
        const currentIds = Array.from(currentSegmentMap.keys());

        // Check if current has @modal but matched doesn't - need to re-render to remove modal
        const currentHasModal = currentIds.some(id => id.includes("@modal"));
        const matchedHasModal = matchedIds.some((id: string) => id.includes("@modal"));
        const needsModalRemoval = currentHasModal && !matchedHasModal;

        if (needsModalRemoval) {
          console.log(
            `[Browser] No diff but @modal needs removal - forcing re-render`
          );
          // Build segments from matched IDs using cache
          const existingSegments = matchedIds
            .map((id: string) => currentSegmentMap.get(id))
            .filter(Boolean) as ResolvedSegment[];

          // Render and update
          const newTree = await renderSegments(existingSegments);
          tx.commit(matchedIds, existingSegments);
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
          });
          console.log(`[Browser] Navigation complete (modal removed)\n`);
          return streamComplete;
        }

        console.log(
          `[Browser] No changes - all revalidations returned false, keeping existing UI`
        );
        const existingSegments = matchedIds
          .map((id: string) => currentSegmentMap.get(id))
          .filter(Boolean) as ResolvedSegment[];
        tx.commit(matchedIds, existingSegments);
        console.log(`[Browser] Navigation complete (no re-render)\n`);
        return streamComplete;
      }

      // INTERCEPT HANDLING:
      // When intercepting, we keep the current page's segments and merge in the intercept.
      // This allows the main content (shop index) to stay visible while the modal (@modal) shows.
      let fullSegments: ResolvedSegment[];
      let finalMatchedIds: string[];
      let interceptCacheEmpty = false; // Track if intercept had empty cache (needs HMR resilience)

      if (isIntercept) {
        // Start with all current segments
        const existingSegments = Array.from(currentSegmentMap.values());

        // If cache is empty, we can't merge - need full page segments
        // This happens during cross-tab refresh when cache was cleared
        if (existingSegments.length === 0) {
          console.warn(`[Browser] Intercept but cache is empty - doing full page fetch`);

          if (isRetry) {
            // If already retrying and still intercept with empty cache, something is wrong
            // Just use what we have (intercept segments only)
            console.error(`[Browser] Intercept cache still empty after retry, proceeding with partial content`);
            finalMatchedIds = matched || [];
            fullSegments = (newSegments || []) as ResolvedSegment[];
          } else {
            // Refetch with _rsc_full flag to tell server not to short-circuit for intercept
            // This will return full page + intercept segments
            const fullUrl = new URL(url, window.location.origin);
            fullUrl.searchParams.set("_rsc_full", "1");
            return fetchPartialUpdate(fullUrl.href, [], true, signal, tx, { isAction });
          }
        } else {
          // Merge intercept segments: add new or update existing slots
          const mergedMap = new Map<string, ResolvedSegment>();
          existingSegments.forEach(s => mergedMap.set(s.id, s));
          newSegments?.forEach((s: ResolvedSegment) => mergedMap.set(s.id, s));

          fullSegments = Array.from(mergedMap.values());
          finalMatchedIds = fullSegments.map(s => s.id);

          console.log(`[Browser] Intercept merge: ${existingSegments.length} existing + ${newSegments?.length || 0} new = ${fullSegments.length} total`);
        }
      } else {
        // Normal navigation: build full segment list by merging:
        // - New/changed segments from server response (diff)
        // - Unchanged segments from current page's cache
        finalMatchedIds = matched || [];
        fullSegments = finalMatchedIds
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
      }

      const matchedIds = finalMatchedIds;

      // HMR RESILIENCE: Check if we're missing segments
      // Skip for intercepts since we're merging with existing segments
      if (!isIntercept && fullSegments.length < matchedIds.length) {
        const missingCount = matchedIds.length - fullSegments.length;
        const missingIds = matchedIds.filter(
          (id: string) => !newSegmentMap.has(id) && !currentSegmentMap.has(id)
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
        return fetchPartialUpdate(url, [], true, signal, tx, { isAction });
      }

      console.log(
        `[Browser] Merged segments: ${fullSegments.map((s) => s.id).join(", ")}`
      );

      if (signal?.aborted) {
        console.log(
          `[Browser] Ignoring stale navigation (aborted before render)`
        );
        return streamComplete;
      }

      // Rebuild tree on client (await for loader data resolution)
      // Race against abort signal to allow cancellation during loader awaiting
      console.log("[partial-update] Starting renderSegments...");
      const startTime = Date.now();
      const newTree = await (signal
        ? Promise.race([
            renderSegments(fullSegments, { isAction }),
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException("Navigation aborted", "AbortError"));
              }
              signal.addEventListener("abort", () => {
                reject(new DOMException("Navigation aborted", "AbortError"));
              });
            }),
          ])
        : renderSegments(fullSegments, { isAction }));
      console.log(
        `[partial-update] renderSegments completed in ${Date.now() - startTime}ms`
      );

      // Final abort check before committing - another navigation may have started
      if (signal?.aborted) {
        console.log(
          `[Browser] Ignoring stale navigation (aborted before commit)`
        );
        return streamComplete;
      }

      // Commit navigation - transaction handles all store mutations atomically
      tx.commit(matchedIds, fullSegments);

      // Emit update to trigger React render
      // For actions, wrap in startTransition to avoid UI flickering
      if (isAction) {
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
      // For actions, wrap in startTransition to avoid UI flickering
      if (isAction) {
        startTransition(async () => {
          onUpdate({
            root: await payload.root,
            metadata: payload.metadata!,
          });
        });
      } else {
        onUpdate({
          root: await payload.root,
          metadata: payload.metadata!,
        });
      }

      return streamComplete;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
