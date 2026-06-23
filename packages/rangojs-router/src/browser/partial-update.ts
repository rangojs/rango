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
import {
  hasActiveIntercept as hasActiveInterceptSlots,
  isInterceptSegment,
} from "./intercept-utils.js";
import type { BoundTransaction } from "./navigation-transaction.js";
import { ServerRedirect } from "../errors.js";
import { debugLog } from "./logging.js";
import {
  validateRedirectOrigin,
  validateExternalRedirect,
} from "./validate-redirect-origin.js";
import type { NavigationUpdate } from "./types.js";

function toScrollPayload(
  scroll: boolean | undefined,
): NonNullable<NavigationUpdate["scroll"]> {
  return { enabled: scroll !== false ? scroll : false };
}

function shouldStartViewTransition(segments: ResolvedSegment[]): boolean {
  let hasIntercept = false;
  let hasTransition = false;
  for (const s of segments) {
    if (isInterceptSegment(s)) hasIntercept = true;
    else if (s.transition) hasTransition = true;
  }
  return !hasIntercept && hasTransition;
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
  | { type: "leave-intercept"; interceptSourceUrl?: string }
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

  function getCurrentCachedSegments(): ResolvedSegment[] {
    const currentKey = store.getHistoryKey();
    const cached = store.getCachedSegments(currentKey);
    return cached?.segments || [];
  }

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

    const historyKeyAtStart = store.getHistoryKey();

    const interceptSourceUrl = mode.interceptSourceUrl;

    let segments: string[];
    if (mode.type === "leave-intercept") {
      const currentSegments = segmentIds ?? segmentState.currentSegmentIds;
      const currentCached = getCurrentCachedSegments();
      const interceptIds = new Set(
        currentCached.filter(isInterceptSegment).map((s) => s.id),
      );
      segments = currentSegments.filter((id) => !interceptIds.has(id));
      debugLog(
        `[Browser] Leaving intercept - filtered segments: ${segments.join(", ")}`,
      );
    } else {
      segments = segmentIds ?? segmentState.currentSegmentIds;
    }

    const previousUrl =
      mode.type === "leave-intercept"
        ? segmentState.currentUrl || tx.currentUrl
        : interceptSourceUrl || tx.currentUrl || segmentState.currentUrl;

    debugLog(`\n[Browser] >>> NAVIGATION`);
    debugLog(`[Browser] From: ${previousUrl}`);
    debugLog(`[Browser] To: ${url}`);
    debugLog(`[Browser] Segments to send: ${segments.join(", ")}`);
    if (interceptSourceUrl) {
      debugLog(`[Browser] Intercept context from: ${interceptSourceUrl}`);
    }

    const targetCache =
      mode.type === "navigate" && mode.targetCacheSegments?.length
        ? mode.targetCacheSegments
        : undefined;
    const cachedSegs = targetCache ?? getCurrentCachedSegments();
    const cachedSegsSource = targetCache ? "history-cache" : "current-page";
    debugLog(
      `[Browser] cachedSegs source: ${cachedSegsSource} (${cachedSegs.length} segments: ${cachedSegs.map((s) => s.id).join(", ")})`,
    );

    let fetchResult: Awaited<ReturnType<NavigationClient["fetchPartial"]>>;
    fetchResult = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl,
      staleRevalidation:
        mode.type === "stale-revalidation" || segments.length === 0,
      version: getVersion(),
      routerId: store.getRouterId?.(),
    });
    const streamingToken = tx.startStreaming();
    const {
      payload,
      streamComplete: rawStreamComplete,
      fullyPrefetched,
    } = fetchResult;
    debugLog("payload.metadata", payload.metadata);

    // Side effect only: end the streaming token once the stream settles.
    // The wrapped promise was never read as a value; only the .end() matters.
    // The .catch keeps an unhandled rejection from leaking if the stream errors.
    rawStreamComplete.then(() => streamingToken.end()).catch(() => {});

    const currentRouterId = store.getRouterId?.();
    if (
      payload.metadata?.routerId &&
      currentRouterId &&
      payload.metadata.routerId !== currentRouterId
    ) {
      console.error(
        `[rango] Partial response router id "${payload.metadata.routerId}" does not ` +
          `match this client ("${currentRouterId}"); discarding it and reloading to re-sync.`,
      );
      window.location.href = url;
      return;
    }

    if (payload.metadata?.redirect) {
      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale redirect (aborted)");
        return;
      }
      // Explicit off-host redirect (redirect(url, { external: true })):
      // hard-navigate, but still scheme-validate (http/https only). external
      // waives the same-origin check the app opted out of, NOT scheme safety, so
      // a forged payload carrying a javascript:/data: URL cannot script via
      // location.assign.
      if (payload.metadata.redirect.external) {
        const externalUrl = validateExternalRedirect(
          payload.metadata.redirect.url,
          window.location.origin,
        );
        if (!externalUrl) {
          debugLog("[Browser] Ignoring blocked external redirect payload");
          return;
        }
        debugLog("[Browser] External redirect (hard navigation)");
        window.location.assign(externalUrl);
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

      if (!diff || diff.length === 0) {
        const matchedIds = matched || [];
        const cacheMap = new Map(cachedSegs.map((s) => [s.id, s]));
        const existingSegments = matchedIds
          .map((id: string) => cacheMap.get(id))
          .filter(Boolean) as ResolvedSegment[];

        if (mode.type === "navigate" && targetCache) {
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

          if (mode.targetCacheHandleData) {
            store.updateCacheHandleData(
              store.getHistoryKey(),
              mode.targetCacheHandleData,
            );
          }

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

          if (shouldStartViewTransition(existingSegments)) {
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

        debugLog(
          "[Browser] No changes - all revalidations returned false, keeping existing UI",
        );
        tx.commit(matchedIds, existingSegments);
        debugLog("[Browser] Navigation complete (no re-render)");
        return;
      }

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

        return fetchPartialUpdate(url, [], true, signal, tx, mode);
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before render)");
        return;
      }

      const renderOptions = {
        isAction: mode.type === "action",
        // forceAwait unwraps the ROUTER loader promises during render so they
        // land without a loading()/fallback frame. A fully-prefetched nav has
        // its router data already resolved (the prefetch stream drained), so
        // awaiting it here is free and lets us commit NORMALLY (not in a
        // transition) below — a normal commit still shows fallbacks for any
        // CLIENT component that suspends on mount, which a transition would
        // wrongly suppress by holding the old UI until that suspense settles.
        forceAwait: mode.type === "stale-revalidation" || fullyPrefetched,
        interceptSegments:
          reconciled.interceptSegments.length > 0
            ? reconciled.interceptSegments
            : undefined,
      };
      let newTree: Awaited<ReturnType<typeof renderSegments>>;
      if (signal) {
        // Race render against abort. Store the abort handler and register it
        // { once:true } so a non-aborted render (which wins the race) can
        // remove it in finally — otherwise the listener stays attached and the
        // rejecting promise never settles. Mirrors teeWithCompletion in
        // browser/response-adapter.ts.
        let onAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new DOMException("Navigation aborted", "AbortError"));
            return;
          }
          onAbort = () =>
            reject(new DOMException("Navigation aborted", "AbortError"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          newTree = await Promise.race([
            renderSegments(reconciled.mainSegments, renderOptions),
            abortPromise,
          ]);
        } finally {
          if (onAbort) signal.removeEventListener("abort", onAbort);
        }
      } else {
        newTree = await renderSegments(reconciled.mainSegments, renderOptions);
      }

      if (signal?.aborted) {
        debugLog("[Browser] Ignoring stale navigation (aborted before commit)");
        return;
      }

      const isInterceptResponse = hasActiveInterceptSlots(
        payload.metadata?.slots,
      );

      const effectiveInterceptSource =
        interceptSourceUrl || segmentState.currentUrl;
      if (mode.type !== "action" && mode.type !== "stale-revalidation") {
        if (isInterceptResponse) {
          store.setInterceptSourceUrl(effectiveInterceptSource);
        } else {
          store.setInterceptSourceUrl(null);
        }
      }

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

      const hasTransition = shouldStartViewTransition(reconciled.segments);
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
        // Normal commit (cold/partial nav AND fully-prefetched nav). For a
        // fully-prefetched nav, renderOptions.forceAwait (above) unwrapped the
        // already-resolved ROUTER loader data AND route content during render, so
        // the new tree carries it inline with no loading()/fallback frame — yet we
        // still commit NORMALLY here rather than in a transition. A transition
        // holds the OLD UI until ALL suspense in the new tree settles, including a
        // CLIENT component that starts its own data request only when mounted
        // (post-commit) under a persistent boundary; that would retain the
        // previous page indefinitely with no feedback. A normal commit lets such
        // client-initiated suspense reveal a fallback (correct) while the router
        // data — genuinely ready — never flashes. Cold/partial navs
        // (fullyPrefetched=false) do not forceAwait, so they stream their
        // fallbacks. Explicit transition() routes keep the broader content-hold
        // via the hasTransition branch above (the documented opt-in).
        onUpdate({
          root: newTree,
          metadata: payload.metadata!,
          scroll: scrollPayload,
        });
      }

      debugLog("[Browser] Navigation complete");
      return;
    } else {
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

      const fullHasTransition = shouldStartViewTransition(segments);
      const fullScrollPayload = toScrollPayload(fullScroll);

      if (mode.type === "stale-revalidation") {
        await rawStreamComplete;
        // Mirror the partial branch's history-key staleness guard (above): the
        // await above is a real async suspension, so the user may have navigated
        // away while this background revalidation was draining. Dropping a late
        // full-update here prevents it from clobbering the freshly committed UI
        // of the page the user moved to.
        const historyKeyNow = store.getHistoryKey();
        if (historyKeyNow !== historyKeyAtStart) {
          debugLog(
            `[Browser] Stale revalidation (full update): history key changed (${historyKeyAtStart} -> ${historyKeyNow}), skipping UI update`,
          );
          return;
        }
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
