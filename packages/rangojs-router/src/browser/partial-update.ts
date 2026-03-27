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
import type { NavigationUpdate } from "./types.js";

/** Build a scroll payload from the commit's scroll option */
function toScrollPayload(
  scroll: boolean | undefined,
): NonNullable<NavigationUpdate["scroll"]> {
  return { enabled: scroll !== false ? scroll : false };
}

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
  /** RSC version getter — returns the current version (may change after HMR) */
  getVersion?: () => string | undefined;
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
 * Discriminated update mode for partial updates.
 */
export type UpdateMode =
  | {
      type: "navigate";
      /** Cached segments for the target URL. When provided, these are used to build
       * the segment map instead of the current page's segments. This ensures consistency
       * when we send cached segment IDs to the server - if the server returns empty diff,
       * we use the same segments we told the server we have. */
      targetCacheSegments?: ResolvedSegment[];
      /** Cached handle data for the target URL. When server returns empty diff and we're
       * rendering from cache, this is passed to the UI to restore breadcrumbs etc. */
      targetCacheHandleData?: Record<string, Record<string, unknown[]>>;
      /** Source URL for intercept restore (popstate cache miss) */
      interceptSourceUrl?: string;
    }
  | { type: "leave-intercept" }
  | { type: "stale-revalidation"; interceptSourceUrl?: string }
  | { type: "action"; interceptSourceUrl?: string };

/**
 * Type for the fetchPartialUpdate function
 */
export type PartialUpdater = (
  targetUrl: string,
  segmentIds: string[] | undefined,
  isRetry: boolean,
  signal: AbortSignal | undefined,
  tx: BoundTransaction,
  mode?: UpdateMode,
) => Promise<void>;

/**
 * Create a partial updater for fetching and applying RSC partial updates
 *
 * This function is shared between navigation-bridge and server-action-bridge
 * to handle partial RSC updates with HMR resilience.
 *
 * @param config - Partial update configuration
 * @returns fetchPartialUpdate function
 */
export function createPartialUpdater(
  config: PartialUpdateConfig,
): PartialUpdater {
  const {
    store,
    client,
    onUpdate,
    renderSegments,
    getVersion = () => undefined,
  } = config;

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
    mode: UpdateMode = { type: "navigate" },
  ): Promise<void> {
    const segmentState = store.getSegmentState();
    const url = targetUrl || window.location.href;

    // Capture history key at start for stale revalidation consistency check
    const historyKeyAtStart = store.getHistoryKey();

    // Derive interceptSourceUrl from modes that carry it
    const interceptSourceUrl =
      mode.type === "stale-revalidation" ||
      mode.type === "action" ||
      mode.type === "navigate"
        ? mode.interceptSourceUrl
        : undefined;

    // When leaving intercept, filter out intercept-specific segments
    let segments: string[];
    if (mode.type === "leave-intercept") {
      const currentSegments = segmentIds ?? segmentState.currentSegmentIds;
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
    // When navigating with targetCacheSegments, use those for consistency.
    // Otherwise fall back to current page's segments (for same-route revalidation).
    const targetCache =
      mode.type === "navigate" ? mode.targetCacheSegments : undefined;
    const cachedSegs =
      targetCache && targetCache.length > 0
        ? targetCache
        : getCurrentCachedSegments();

    // Fetch partial payload (no abort signal - RSC doesn't support it well)
    let fetchResult: Awaited<ReturnType<NavigationClient["fetchPartial"]>>;
    fetchResult = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl,
      // Mark stale when explicitly requested OR when no segments are sent
      // (action redirect sends empty segments for a fresh render).
      staleRevalidation:
        mode.type === "stale-revalidation" || segments.length === 0,
      version: getVersion(),
      routerId: store.getRouterId?.(),
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

    // Detect app switch: if routerId changed, the navigation crossed into
    // a different router (e.g., via host router path mount). Downgrade
    // partial to full so the entire tree is replaced without reconciliation
    // against stale segments from the previous app.
    if (payload.metadata?.routerId) {
      const prevRouterId = store.getRouterId?.();
      if (prevRouterId && prevRouterId !== payload.metadata.routerId) {
        debugLog(
          `[Browser] App switch detected (${prevRouterId} → ${payload.metadata.routerId}), forcing full update`,
        );
        payload.metadata.isPartial = false;
      }
      store.setRouterId?.(payload.metadata.routerId);
    }

    // Handle server-side redirect with state
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
      if (!diff || diff.length === 0) {
        const matchedIds = matched || [];
        const cacheMap = new Map(cachedSegs.map((s) => [s.id, s]));
        const existingSegments = matchedIds
          .map((id: string) => cacheMap.get(id))
          .filter(Boolean) as ResolvedSegment[];

        // When navigating with cached segments to a different route, render them.
        if (mode.type === "navigate" && targetCache && targetCache.length > 0) {
          debugLog(
            "[Browser] No diff but navigating with cached segments - rendering target route",
          );

          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
          });

          const { scroll: commitScroll } = tx.commit(
            matchedIds,
            existingSegments,
          );

          // tx.commit() cached the source page's handleData because
          // eventController hasn't been updated yet. Overwrite with the
          // correct cached handleData to prevent cache corruption on
          // subsequent navigations to this same URL.
          if (mode.targetCacheHandleData) {
            store.updateCacheHandleData(
              store.getHistoryKey(),
              mode.targetCacheHandleData,
            );
          }

          // Include cachedHandleData in metadata so NavigationProvider can restore
          // breadcrumbs and other handle data from cache.
          // Remove `handles` from metadata to prevent NavigationProvider from
          // processing an empty handles stream, which would clear the cached breadcrumbs.
          const { handles: _unusedHandles, ...metadataWithoutHandles } =
            payload.metadata!;
          const cachedUpdate = {
            root: newTree,
            metadata: {
              ...metadataWithoutHandles,
              cachedHandleData: mode.targetCacheHandleData,
            },
            scroll: toScrollPayload(commitScroll),
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
        if (mode.type === "leave-intercept") {
          debugLog(
            "[Browser] Leaving intercept - forcing re-render to remove modal",
          );

          const newTree = await renderSegments(existingSegments, {
            forceAwait: true,
          });

          const { scroll: leaveScroll } = tx.commit(
            matchedIds,
            existingSegments,
          );

          onUpdate({
            root: newTree,
            metadata: payload.metadata,
            scroll: toScrollPayload(leaveScroll),
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
        mode.type === "stale-revalidation" || mode.type === "action"
          ? "stale-revalidation"
          : "navigation";

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
        if (mode.type === "action") {
          return;
        }
        console.warn(
          `[Browser] HMR detected: Missing ${missingCount} segments. Refetching all...`,
        );

        // Refetch with empty segments = server sends everything
        return fetchPartialUpdate(url, [], true, signal, tx, mode);
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before render)");
        return;
      }

      // Rebuild tree on client (await for loader data resolution)
      const renderOptions = {
        isAction: mode.type === "action",
        forceAwait: mode.type === "stale-revalidation",
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
      const isInterceptResponse = hasActiveInterceptSlots(
        payload.metadata?.slots,
      );

      // Track intercept context (only on navigation, not actions or stale revalidation)
      // Use the authoritative source from mode/history state when restoring an
      // intercept via popstate cache miss; fall back to the current URL for fresh
      // intercept navigations.
      const effectiveInterceptSource =
        interceptSourceUrl || segmentState.currentUrl;
      if (mode.type !== "action" && mode.type !== "stale-revalidation") {
        if (isInterceptResponse) {
          store.setInterceptSourceUrl(effectiveInterceptSource);
        } else {
          store.setInterceptSourceUrl(null);
        }
      }

      // Commit navigation - use server's matched as the authoritative segment ID list.
      // reconciled.segments may be missing IDs (e.g., loader segments not in diff or cache)
      // but the server's matched always includes all expected segment IDs.
      const allSegmentIds = matchedIds;
      const serverLocationState = payload.metadata?.locationState;
      const overrides: CommitOverrides | undefined = isInterceptResponse
        ? {
            scroll: false,
            intercept: true,
            interceptSourceUrl: effectiveInterceptSource,
            ...(serverLocationState && { serverState: serverLocationState }),
          }
        : serverLocationState
          ? { serverState: serverLocationState }
          : undefined;
      const { scroll: navScroll } = tx.commit(
        allSegmentIds,
        reconciled.segments,
        overrides,
      );

      // For stale revalidation: verify history key hasn't changed before updating UI
      if (mode.type === "stale-revalidation") {
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          debugLog(
            `[Browser] Stale revalidation: history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`,
          );
          return;
        }
      }

      debugLog("[partial-update] updating document");

      // Emit update to trigger React render.
      // Scroll info is included so NavigationProvider applies it after React commits.
      const hasTransition = reconciled.mainSegments.some((s) => s.transition);
      const scrollPayload = toScrollPayload(navScroll);

      if (mode.type === "action" || mode.type === "stale-revalidation") {
        startTransition(() => {
          if (hasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
            scroll: scrollPayload,
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
            scroll: scrollPayload,
          });
        });
      } else {
        onUpdate({
          root: newTree,
          metadata: payload.metadata!,
          scroll: scrollPayload,
        });
      }

      debugLog("[Browser] Navigation complete");
      return;
    } else {
      // Full update (fallback)
      console.warn(`[Browser] Full update (fallback)`);

      const segments = payload.metadata?.segments || [];

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted)");
        return;
      }

      const segmentIds = segments.map((s: ResolvedSegment) => s.id);

      const newTree = await renderSegments(segments);

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      const fullUpdateServerState = payload.metadata?.locationState;
      const { scroll: fullScroll } = fullUpdateServerState
        ? tx.commit(segmentIds, segments, {
            serverState: fullUpdateServerState,
          })
        : tx.commit(segmentIds, segments);

      const fullHasTransition = segments.some(
        (s: ResolvedSegment) => s.transition,
      );
      const fullScrollPayload = toScrollPayload(fullScroll);

      if (mode.type === "stale-revalidation") {
        await rawStreamComplete;
        startTransition(() => {
          if (fullHasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
            scroll: fullScrollPayload,
          });
        });
      } else if (mode.type === "action") {
        startTransition(async () => {
          if (fullHasTransition && addTransitionType) {
            addTransitionType("action");
          }
          onUpdate({
            root: newTree,
            metadata: payload.metadata!,
            scroll: fullScrollPayload,
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
            scroll: fullScrollPayload,
          });
        });
      } else {
        onUpdate({
          root: newTree,
          metadata: payload.metadata!,
          scroll: fullScrollPayload,
        });
      }

      return;
    }
  }

  return fetchPartialUpdate;
}

export { createPartialUpdater as default };
