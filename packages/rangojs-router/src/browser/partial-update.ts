import type {
  NavigationStore,
  NavigationClient,
  UpdateSubscriber,
  ResolvedSegment,
} from "./types.js";
import type { ReactNode } from "react";
import * as React from "react";
import { startTransition } from "react";

// addTransitionType is only available in React experimental
const addTransitionType: ((type: string) => void) | undefined =
  "addTransitionType" in React ? (React as any).addTransitionType : undefined;
import type { RenderSegmentsOptions } from "../segment-system.js";
import { reconcileSegments } from "./segment-reconciler.js";
import type { ReconcileActor } from "./segment-reconciler.js";
import { hasActiveIntercept as hasActiveInterceptSlots } from "./intercept-utils.js";
import type { BoundTransaction } from "./navigation-transaction.js";
import { ServerRedirect } from "../errors.js";
import { debugLog } from "./logging.js";
import { validateRedirectOrigin } from "./validate-redirect-origin.js";

/**
 * Configuration for creating a partial updater
 */
export interface PartialUpdateConfig {
  store: NavigationStore;
  client: NavigationClient;
  onUpdate: UpdateSubscriber;
  renderSegments: (
    segments: ResolvedSegment[],
    options?: RenderSegmentsOptions,
  ) => Promise<ReactNode> | ReactNode;
  /** RSC version received from server (from initial payload metadata) */
  version?: string;
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
  /** Server-set location state to merge into history.pushState */
  serverState?: Record<string, unknown>;
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
    /** Cached segments for the target URL. When provided, these are used to build
     * the segment map instead of the current page's segments. This ensures consistency
     * when we send cached segment IDs to the server - if the server returns empty diff,
     * we use the same segments we told the server we have. */
    targetCacheSegments?: ResolvedSegment[];
    /** Cached handle data for the target URL. When server returns empty diff and we're
     * rendering from cache, this is passed to the UI to restore breadcrumbs etc. */
    targetCacheHandleData?: Record<string, Record<string, unknown[]>>;
    /** When true, we're leaving an intercept state - don't use current segment IDs
     * as fallback and force a fresh render from server */
    leavingIntercept?: boolean;
  },
) => Promise<void>;

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
  config: PartialUpdateConfig,
): PartialUpdater {
  const { store, client, onUpdate, renderSegments, version } = config;

  /**
   * Get current page's cached segments as an array
   */
  function getCurrentCachedSegments(): ResolvedSegment[] {
    const currentKey = store.getHistoryKey();
    const cached = store.getCachedSegments(currentKey);
    return cached?.segments || [];
  }

  /**
   * Fetch partial update and trigger UI update
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
      targetCacheSegments?: ResolvedSegment[];
      targetCacheHandleData?: Record<string, Record<string, unknown[]>>;
      leavingIntercept?: boolean;
    },
  ): Promise<void> {
    const {
      isAction = false,
      staleRevalidation = false,
      interceptSourceUrl,
      targetCacheSegments,
      targetCacheHandleData,
      leavingIntercept = false,
    } = options || {};
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;

    // Capture history key at start for stale revalidation consistency check
    const historyKeyAtStart = store.getHistoryKey();

    // When leaving intercept, don't send current segment IDs - we need fresh non-intercept segments
    // Filter out intercept-related segments (parallel slots like @modal) from current segments
    let segments: string[];
    if (leavingIntercept) {
      // When leaving intercept, only send segments that aren't intercept-specific
      // The server will return the non-intercept version of the route
      const currentSegments = segmentIds ?? segmentState.currentSegmentIds;
      // Use cached segment metadata (namespace) to identify intercept segments.
      // Only intercept segments have namespace starting with "intercept:" —
      // regular parallel segments like @sidebar are preserved.
      const currentCached = getCurrentCachedSegments();
      const interceptIds = new Set(
        currentCached
          .filter((s) => s.namespace?.startsWith("intercept:"))
          .map((s) => s.id),
      );
      segments = currentSegments.filter((id) => !interceptIds.has(id));
      debugLog(
        `[Browser] Leaving intercept - filtered segments: ${segments.join(", ")}`,
      );
    } else {
      segments = segmentIds ?? segmentState.currentSegmentIds;
    }

    // For intercept revalidation, use the intercept source URL as previousUrl
    // This tells the server the route should be treated as an intercept
    const previousUrl =
      interceptSourceUrl || tx.currentUrl || segmentState.currentUrl;

    debugLog(`\n[Browser] >>> NAVIGATION`);
    debugLog(`[Browser] From: ${previousUrl}`);
    debugLog(`[Browser] To: ${url}`);
    debugLog(`[Browser] Segments to send: ${segments.join(", ")}`);
    if (interceptSourceUrl) {
      debugLog(`[Browser] Intercept context from: ${interceptSourceUrl}`);
    }

    // Get cached segments for merging with server diff.
    // When targetCacheSegments is provided (navigating to a cached route), use those
    // to ensure consistency - we use the same segments we told the server we have.
    // Otherwise fall back to current page's segments (for same-route revalidation).
    const cachedSegs =
      targetCacheSegments && targetCacheSegments.length > 0
        ? targetCacheSegments
        : getCurrentCachedSegments();
    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    let fetchResult: Awaited<ReturnType<NavigationClient["fetchPartial"]>>;
    fetchResult = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl,
      // Mark stale when explicitly requested OR when no segments are sent
      // (action redirect sends empty segments for a fresh render).
      // Only the fetch URL param is affected here — behavioral side effects
      // (forceAwait, history key check) are controlled by the staleRevalidation variable.
      staleRevalidation: staleRevalidation || segments.length === 0,
      version,
    });
    // Mark navigation as streaming (response received, now parsing RSC).
    // Called after fetchPartial so pendingUrl stays set during the network wait,
    // allowing useLinkStatus to show per-link pending indicators.
    const streamingToken = tx.startStreaming();
    const { payload, streamComplete: rawStreamComplete } = fetchResult;
    debugLog("payload.metadata", payload.metadata);

    const streamComplete = rawStreamComplete.then(() => {
      streamingToken.end();
    });

    // Handle server-side redirect with state: the server returned a 200 with
    // a redirect payload instead of a 3xx so that location state is preserved.
    // Throw ServerRedirect to let navigate() catch it and re-navigate with state.
    // Check signal.aborted first — a newer navigation may have started, and we
    // must not redirect from a stale response.
    if (payload.metadata?.redirect) {
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale redirect (aborted)");
        return;
      }
      const redirectUrl = validateRedirectOrigin(
        payload.metadata.redirect.url,
        window.location.origin,
      );
      if (!redirectUrl) {
        debugLog("[Browser] Ignoring blocked redirect payload");
        return;
      }
      const serverState = payload.metadata.locationState;
      throw new ServerRedirect(redirectUrl, serverState);
    }

    if (payload.metadata?.isPartial) {
      const { segments: newSegments, matched, diff } = payload.metadata;

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted)");
        return;
      }

      debugLog(`[Browser] Partial update - matched: ${matched?.join(", ")}`);
      debugLog(`[Browser] Diff: ${diff?.join(", ")}`);

      // If diff is empty, nothing changed on server side.
      // However, if we're navigating with targetCacheSegments (to a different route),
      // we still need to render those segments since the UI is showing the old route.
      if (!diff || diff.length === 0) {
        const matchedIds = matched || [];
        const cacheMap = new Map(cachedSegs.map((s) => [s.id, s]));
        const existingSegments = matchedIds
          .map((id: string) => cacheMap.get(id))
          .filter(Boolean) as ResolvedSegment[];

        // When navigating with cached segments to a different route, render them.
        // targetCacheSegments being provided means we're navigating to a cached route.
        if (targetCacheSegments && targetCacheSegments.length > 0) {
          debugLog(
            "[Browser] No diff but navigating with cached segments - rendering target route",
          );

          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
          });

          tx.commit(matchedIds, existingSegments);

          // Include cachedHandleData in metadata so NavigationProvider can restore
          // breadcrumbs and other handle data from cache.
          // IMPORTANT: Remove `handles` from metadata to prevent NavigationProvider from
          // processing an empty handles stream, which would clear the cached breadcrumbs.
          // When rendering from cache with empty diff, we want to use cachedHandleData instead.
          const { handles: _unusedHandles, ...metadataWithoutHandles } =
            payload.metadata!;
          const cachedUpdate = {
            root: newTree,
            metadata: {
              ...metadataWithoutHandles,
              cachedHandleData: targetCacheHandleData,
            },
          };

          const cachedHasTransition = existingSegments.some(
            (s) => s.transition,
          );
          if (cachedHasTransition) {
            startTransition(() => {
              if (addTransitionType) {
                addTransitionType("navigation");
              }
              onUpdate(cachedUpdate);
            });
          } else {
            onUpdate(cachedUpdate);
          }

          debugLog("[Browser] Navigation complete (rendered from cache)");
          return;
        }

        // When leaving intercept, force re-render even with empty diff
        // The matched segments are the non-intercept segments, which we need to render
        // to remove the modal from the UI
        if (leavingIntercept) {
          debugLog(
            "[Browser] Leaving intercept - forcing re-render to remove modal",
          );

          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
          });

          tx.commit(matchedIds, existingSegments);

          onUpdate({
            root: newTree,
            metadata: payload.metadata,
          });

          debugLog("[Browser] Navigation complete (left intercept)");
          return;
        }

        // Same route revalidation with no changes - skip UI update
        debugLog(
          "[Browser] No changes - all revalidations returned false, keeping existing UI",
        );
        tx.commit(matchedIds, existingSegments);
        debugLog("[Browser] Navigation complete (no re-render)");
        return;
      }

      // Reconcile server segments with cached segments (single source of truth)
      const matchedIds = matched || [];
      const actor: ReconcileActor =
        staleRevalidation || isAction ? "stale-revalidation" : "navigation";

      const reconciled = reconcileSegments({
        actor,
        matched: matchedIds,
        diff: diff || [],
        serverSegments: newSegments || [],
        cachedSegments: cachedSegs,
        insertMissingDiff: true,
      });

      // HMR RESILIENCE: Check if we're missing any matched segments
      const reconciledIdSet = new Set(reconciled.segments.map((s) => s.id));
      const missingIds = matchedIds.filter(
        (id: string) => !reconciledIdSet.has(id),
      );

      if (missingIds.length > 0) {
        const missingCount = missingIds.length;

        if (isRetry) {
          console.warn("Missing ids", { missingIds });
          throw new Error(
            `[Browser] Failed to fetch segments after retry. Missing: [${missingIds.join(", ")}]`,
          );
        }
        if (signal?.aborted) {
          debugLog(
            "[Browser] Ignoring stale navigation (aborted during HMR retry)",
          );
          return;
        }
        if (isAction) {
          return;
        }
        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`,
        );

        // Refetch with empty segments = server sends everything
        return fetchPartialUpdate(url, [], true, signal, tx, { isAction });
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before render)");
        return;
      }

      // Rebuild tree on client (await for loader data resolution)
      // Race against abort signal to allow cancellation during loader awaiting
      // Pass intercept segments separately for explicit handling
      // For stale revalidation, use forceAwait to ensure no loading fallbacks
      const renderOptions = {
        isAction,
        forceAwait: staleRevalidation,
        interceptSegments:
          reconciled.interceptSegments.length > 0
            ? reconciled.interceptSegments
            : undefined,
      };
      const newTree = await (signal
        ? Promise.race([
            renderSegments(reconciled.mainSegments, renderOptions),
            new Promise<never>((_, reject) => {
              if (signal.aborted) {
                reject(new DOMException("Navigation aborted", "AbortError"));
              }
              signal.addEventListener("abort", () => {
                reject(new DOMException("Navigation aborted", "AbortError"));
              });
            }),
          ])
        : renderSegments(reconciled.mainSegments, renderOptions));

      // Final abort check before committing - another navigation may have started
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      // Check if this is an intercept response (any slot is active)
      // If so, disable scroll to keep the current scroll position
      const isInterceptResponse = hasActiveInterceptSlots(
        payload.metadata?.slots,
      );

      // Track intercept context for action revalidation (only on navigation, not actions or stale revalidation)
      if (!isAction && !staleRevalidation) {
        if (isInterceptResponse) {
          // Save the source URL for action revalidation to maintain intercept context
          store.setInterceptSourceUrl(segmentState.currentUrl);
        } else {
          // Clear intercept context when navigating to a non-intercept route
          store.setInterceptSourceUrl(null);
        }
      }

      // Commit navigation - transaction handles all store mutations atomically
      // For intercept responses: disable scroll, mark as intercept, include source URL
      // Use reconciled.segments (which includes inserted diff segments) instead of matchedIds
      const allSegmentIds = reconciled.segments.map((s) => s.id);
      const serverLocationState = payload.metadata?.locationState;
      const overrides: CommitOverrides | undefined = isInterceptResponse
        ? {
            scroll: false,
            intercept: true,
            interceptSourceUrl: segmentState.currentUrl,
            ...(serverLocationState && { serverState: serverLocationState }),
          }
        : serverLocationState
          ? { serverState: serverLocationState }
          : undefined;
      tx.commit(allSegmentIds, reconciled.segments, overrides);

      // For stale revalidation: verify history key hasn't changed before updating UI
      // If user navigated away, skip UI update to avoid corrupting current view
      if (staleRevalidation) {
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          debugLog(
            `[Browser] Stale revalidation: history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`,
          );
          return;
        }
      }

      debugLog("[partial-update] updating document");

      // Emit update to trigger React render
      // For stale revalidation: wait for stream to complete (loaders resolved), then update
      // For actions: wrap in startTransition to avoid UI flickering
      // For transitions: wrap in startTransition + addTransitionType for ViewTransition
      const hasTransition = reconciled.mainSegments.some((s) => s.transition);

      if (isAction || staleRevalidation) {
        startTransition(() => {
          if (hasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
          });
        });
      } else if (hasTransition) {
        startTransition(() => {
          if (addTransitionType) {
            addTransitionType("navigation");
          }
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

      debugLog("[Browser] Navigation complete");
      return;
    } else {
      // Full update (fallback)
      // Reconstruct the tree client-side from segments via renderSegments
      // to ensure consistent component references with action revalidation.
      console.warn(`[Browser] Full update (fallback)`);

      const segments = payload.metadata?.segments || [];

      // Check if this navigation is stale (a newer one started)
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted)");
        return;
      }

      const segmentIds = segments.map((s: ResolvedSegment) => s.id);

      // Render on client for consistent component references
      const newTree = await renderSegments(segments);

      // Final abort check before committing - another navigation may have started
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      // Commit navigation - transaction handles all store mutations atomically
      const fullUpdateServerState = payload.metadata?.locationState;
      if (fullUpdateServerState) {
        tx.commit(segmentIds, segments, { serverState: fullUpdateServerState });
      } else {
        tx.commit(segmentIds, segments);
      }

      // Emit update to trigger React render
      // For stale revalidation: wait for stream to complete, then update
      // For actions: wrap in startTransition to avoid UI flickering
      // For transitions: wrap in startTransition + addTransitionType
      const fullHasTransition = segments.some(
        (s: ResolvedSegment) => s.transition,
      );

      if (staleRevalidation) {
        await rawStreamComplete;
        startTransition(() => {
          if (fullHasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
          });
        });
      } else if (isAction) {
        startTransition(async () => {
          if (fullHasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
          });
        });
      } else if (fullHasTransition) {
        startTransition(() => {
          if (addTransitionType) {
            addTransitionType("navigation");
          }
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

      return;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
