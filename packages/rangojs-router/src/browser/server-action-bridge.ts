import type {
  ServerActionBridge,
  ServerActionBridgeConfig,
  RscPayload,
} from "./types.js";
import { createPartialUpdater } from "./partial-update.js";
import { createNavigationTransaction } from "./navigation-bridge.js";
import {
  reconcileSegments,
  reconcileErrorSegments,
} from "./segment-reconciler.js";
import { classifyActionResponse } from "./action-response-classifier.js";
import { prepareClientLoaders } from "./client-loader-resolution.js";
import { startTransition } from "react";
import type { EventController } from "./event-controller.js";
import {
  toNetworkError,
  emitNetworkError,
  isBackgroundSuppressible,
} from "./network-error-handler.js";
import {
  browserDebugLog,
  isBrowserDebugEnabled,
  startBrowserTransaction,
} from "./logging.js";

// Polyfill Symbol.dispose/asyncDispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}
if (typeof Symbol.asyncDispose === "undefined") {
  (Symbol as any).asyncDispose = Symbol("Symbol.asyncDispose");
}

/**
 * Extended configuration for server action bridge with event controller
 */
export interface ServerActionBridgeConfigWithController
  extends ServerActionBridgeConfig {
  eventController: EventController;
  /** RSC version from initial payload metadata */
  version?: string;
  /** Callback to trigger SPA navigation (for action redirects) */
  onNavigate?: (url: string, options?: { state?: unknown; replace?: boolean }) => Promise<void>;
}

/**
 * Create a server action bridge for handling RSC server actions
 *
 * The bridge registers a callback with the RSC runtime that handles:
 * - Encoding action arguments
 * - Sending action requests to the server
 * - Processing responses and updating UI
 * - Managing concurrent action requests via event controller
 * - HMR resilience (refetching if segments are missing)
 *
 * @param config - Bridge configuration
 * @returns ServerActionBridge instance
 */
export function createServerActionBridge(
  config: ServerActionBridgeConfigWithController
): ServerActionBridge {
  const { store, client, eventController, deps, onUpdate, renderSegments, version, onNavigate } =
    config;

  let isRegistered = false;

  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
    version,
  });

  /**
   * Refetch current route via a navigation transaction.
   * Encapsulates the repeated pattern of creating a navTx + fetchPartialUpdate
   * used by navigated-away, hmr-missing, and consolidation-needed scenarios.
   */
  async function refetchRoute(opts?: {
    segments?: string[];
    interceptSourceUrl?: string | null;
  }): Promise<void> {
    const src = opts?.interceptSourceUrl ?? null;
    using navTx = createNavigationTransaction(
      store,
      eventController,
      window.location.href,
      { replace: true, skipLoadingState: true },
    );
    await fetchPartialUpdate(
      window.location.href,
      opts?.segments ?? [],
      false,
      navTx.handle.signal,
      navTx.with({
        url: window.location.href,
        storeOnly: true,
        ...(src ? { intercept: true, interceptSourceUrl: src } : {}),
      }),
      {
        isAction: true,
        ...(src ? { interceptSourceUrl: src } : {}),
      },
    );
  }

  /**
   * Server action callback handler
   */
  async function handleServerAction(id: string, args: any[]): Promise<unknown> {
    const tx = isBrowserDebugEnabled()
      ? startBrowserTransaction("action")
      : null;
    const log = (msg: string, details?: Record<string, unknown>) => {
      if (tx) browserDebugLog(tx, msg, details);
    };

    const locationKey = window.history.state?.key;
    log("action start", { id, argsCount: args.length });

    // Start action in event controller - handles lifecycle tracking
    using handle = eventController.startAction(id, args);

    const segmentState = store.getSegmentState();

    // Mark cache as stale immediately when action starts
    // This ensures SWR pattern kicks in if user navigates away during action
    store.markCacheAsStaleAndBroadcast();

    // Create temporary references for serialization
    const temporaryReferences = deps.createTemporaryReferenceSet();

    // Capture URL pathname at action start to detect navigation during action
    // Must use window.location (not store.path) because intercepts change URL
    // without changing store.path (e.g., /kanban -> /kanban/card/1)
    const actionStartPathname = window.location.pathname;

    // Build action request URL with current segments
    const url = new URL(window.location.href);
    url.searchParams.set("_rsc_action", id);
    url.searchParams.set(
      "_rsc_segments",
      segmentState.currentSegmentIds.join(",")
    );
    // Add version param for version mismatch detection
    if (version) {
      url.searchParams.set("_rsc_v", version);
    }

    // Encode arguments
    const encodedBody = await deps.encodeReply(args, { temporaryReferences });

    log("sending action request", {
      url: url.href,
      bodyType: typeof encodedBody,
      isFormData: encodedBody instanceof FormData,
      segmentCount: segmentState.currentSegmentIds.length,
    });

    // Track when the stream completes
    let resolveStreamComplete: () => void;
    const streamComplete = new Promise<void>((resolve) => {
      resolveStreamComplete = resolve;
    });

    // Get intercept source URL if in intercept context
    const interceptSourceUrl = store.getInterceptSourceUrl();

    // Track streaming token - will be set when response arrives
    let streamingToken: { end(): void } | null = null;

    // Send action request with stream tracking
    const responsePromise = fetch(url, {
      method: "POST",
      headers: {
        "rsc-action": id,
        "X-RSC-Router-Client-Path": segmentState.currentUrl,
        ...(tx && { "X-RSC-Router-Request-Id": tx.requestId }),
        // Send intercept source URL so server can maintain intercept context
        ...(interceptSourceUrl && {
          "X-RSC-Router-Intercept-Source": interceptSourceUrl,
        }),
      },
      body: encodedBody,
    }).then(async (response) => {
      // Check for version mismatch - server wants us to reload
      const reloadUrl = response.headers.get("X-RSC-Reload");
      if (reloadUrl) {
        log("version mismatch on action, reloading", { reloadUrl });
        window.location.href = reloadUrl;
        // Return a never-resolving promise to prevent further processing
        return new Promise<Response>(() => {});
      }

      // Simple redirect from action (no state, no RSC payload).
      // Short-circuits before createFromFetch — no Flight deserialization needed.
      // Check handle.signal.aborted to avoid redirecting from a stale action
      // when the user has already navigated away.
      const simpleRedirectUrl = response.headers.get("X-RSC-Redirect");
      if (simpleRedirectUrl && !handle.signal.aborted) {
        if (tx) {
          browserDebugLog(tx, "action simple redirect", { url: simpleRedirectUrl });
        }
        handle.complete(undefined);
        if (onNavigate) {
          await onNavigate(simpleRedirectUrl, { replace: true });
        } else {
          window.location.href = simpleRedirectUrl;
        }
        return new Promise<Response>(() => {});
      }

      // Start streaming immediately when response arrives
      if (!handle.signal.aborted) {
        streamingToken = handle.startStreaming();
      }

      if (!response.body) {
        // No body means stream is already complete
        streamingToken?.end();
        resolveStreamComplete();
        return response;
      }

      // Tee the stream: one for RSC runtime, one for tracking completion
      const [rscStream, trackingStream] = response.body.tee();

      // Consume the tracking stream to detect when it closes
      (async () => {
        const reader = trackingStream.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
          log("stream complete");
          streamingToken?.end();
          resolveStreamComplete();
        }
      })().catch((error) => {
        console.error("[STREAMING] Error reading tracking stream:", error);
        streamingToken?.end();
      });

      // Return response with the RSC stream
      return new Response(rscStream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    });

    // Deserialize response (MUST use same temporaryReferences)
    let payload: RscPayload;
    try {
      payload = await deps.createFromFetch<RscPayload>(responsePromise, {
        temporaryReferences,
      });
    } catch (error) {
      // Clean up streaming token on error (may be null if fetch failed before .then() ran)
      // The token is assigned in .then() callback which runs before this catch block,
      // but TypeScript doesn't track cross-async assignments, so use type assertion
      (streamingToken as { end(): void } | null)?.end();
      // resolveStreamComplete is assigned in the Promise constructor so it's safe to call
      resolveStreamComplete!();

      // Convert network-level errors to NetworkError for proper handling
      const networkError = toNetworkError(error, {
        url: url.toString(),
        operation: "action",
      });
      if (networkError) {
        handle.fail(networkError);
        emitNetworkError(onUpdate, networkError, segmentState.currentUrl);
        throw networkError;
      }
      throw error;
    }

    log("action response received", {
      isPartial: payload.metadata?.isPartial,
      isError: payload.metadata?.isError,
      matchedCount: payload.metadata?.matched?.length ?? 0,
      diffCount: payload.metadata?.diff?.length ?? 0,
    });

    // Process response
    const { metadata, returnValue } = payload;

    // Handle action redirect: server converted the redirect to a Flight payload
    // so we can perform SPA navigation instead of a full page reload.
    // Check handle.signal.aborted to avoid redirecting from a stale action
    // when the user has already navigated away.
    if (metadata?.redirect && !handle.signal.aborted) {
      const { url: redirectUrl } = metadata.redirect;
      const redirectState = metadata.locationState;
      console.log(`[Browser] Action redirect to ${redirectUrl}`);
      handle.complete(returnValue?.data);
      if (onNavigate) {
        await onNavigate(redirectUrl, {
          state: redirectState,
          replace: true,
        });
      } else {
        window.location.href = redirectUrl;
      }
      return returnValue?.data;
    }

    const { matched, diff, segments, isPartial, isError } = metadata || {};

    // Log action result
    if (returnValue && !returnValue.ok) {
      console.error(`[Browser] Action failed:`, returnValue.data);
    }

    // Handle error responses with error boundary UI
    if (isError && isPartial && segments && diff) {
      log("processing error boundary response");

      // Abort all other pending action requests - error takes precedence
      // This prevents other actions from completing and overwriting the error UI
      eventController.abortAllActions();

      // Clear concurrent action tracking - no consolidation needed when showing error
      handle.clearConsolidation();

      // Get current page's cached segments
      const currentKey = store.getHistoryKey();
      const cached = store.getCachedSegments(currentKey);
      const cachedSegments = cached?.segments || [];

      // Reconcile error segments with cached tree
      const errorResult = reconcileErrorSegments(cachedSegments, segments);

      // Render the full tree with error segment merged with parent layouts
      const errorTree = await renderSegments(errorResult.mainSegments, {
        isAction: true,
        interceptSegments:
          errorResult.interceptSegments.length > 0
            ? errorResult.interceptSegments
            : undefined,
      });

      // Update UI with error boundary
      startTransition(() => {
        onUpdate({ root: errorTree, metadata: metadata! });
      });

      // Update segment tracking to exclude error segment IDs
      const errorSegmentIds = new Set(diff);
      const segmentIdsAfterError = segmentState.currentSegmentIds.filter(
        (id) => !errorSegmentIds.has(id)
      );

      // Update store state
      store.setSegmentIds(segmentIdsAfterError);
      const currentHandleData = eventController.getHandleState().data;
      store.cacheSegmentsForHistory(
        currentKey,
        errorResult.segments,
        currentHandleData,
      );

      // Throw the error so the action promise rejects
      if (returnValue && !returnValue.ok) {
        handle.fail(returnValue.data);
        throw returnValue.data;
      }

      // No error in returnValue (shouldn't happen with isError: true)
      handle.complete(undefined);
      return undefined;
    }

    if (!isPartial) {
      // Full update not supported for actions
      throw new Error(
        `[Browser] Full update after action is not supported yet`
      );
    }

    log("processing partial update", {
      serverSegments: segments?.length ?? 0,
      diff: diff?.join(", ") ?? "",
      matched: matched?.join(", ") ?? "",
    });

    // Record revalidated segments for concurrent action tracking
    if (diff) {
      handle.recordRevalidatedSegments(diff);
    }

    // Get current page's cached segments for merging
    const currentKey = store.getHistoryKey();
    const cached = store.getCachedSegments(currentKey);
    const cachedSegments = cached?.segments || [];

    if (!matched) {
      throw new Error("No matched segments in response");
    }

    // Reconcile server segments with cached segments (single source of truth)
    const reconciled = reconcileSegments({
      actor: "action",
      matched,
      diff: diff || [],
      serverSegments: segments || [],
      cachedSegments,
    });
    const fullSegments = reconciled.segments;

    const returnData = returnValue?.data;

    if (returnValue && !returnValue.ok) {
      handle.fail(returnValue.data);
      throw returnValue.data;
    }

    // Classify the post-reconciliation scenario
    const consolidationSegments = handle.getConsolidationSegments();
    const otherFetchingActions = [
      ...eventController.getInflightActions().values(),
    ].filter((a) => a.phase === "fetching" && a.id !== handle.id);

    const scenario = classifyActionResponse({
      actionStartPathname,
      currentPathname: window.location.pathname,
      actionStartLocationKey: locationKey,
      currentLocationKey: window.history.state?.key,
      reconciledSegmentCount: fullSegments.length,
      matchedCount: matched.length,
      consolidationSegments: consolidationSegments || null,
      otherFetchingActionCount: otherFetchingActions.length,
      currentInterceptSource: store.getInterceptSourceUrl(),
    });

    switch (scenario.type) {
      case "navigated-away": {
        log("user navigated away during action", {
          from: actionStartPathname,
          to: window.location.pathname,
          historyKeyChanged: scenario.historyKeyChanged,
        });
        // Clear concurrent action tracking - don't consolidate for old route's segments
        handle.clearConsolidation();

        if (scenario.historyKeyChanged) {
          if (!scenario.onInterceptRoute) {
            store.markCacheAsStaleAndBroadcast();
            refetchRoute().catch((error) => {
              if (isBackgroundSuppressible(error)) return;
              console.error("[Browser] Background revalidation failed:", error);
            });
          }
          break;
        }

        // Same history key but different pathname - safe to refetch current route
        store.markCacheAsStaleAndBroadcast();
        await refetchRoute({
          interceptSourceUrl: store.getInterceptSourceUrl(),
        });
        break;
      }

      case "hmr-missing": {
        console.warn(`[Browser] Missing segments after action (HMR detected), refetching...`);
        await refetchRoute({ interceptSourceUrl });
        store.broadcastCacheInvalidation();
        break;
      }

      case "consolidation-needed": {
        log("consolidation fetch needed", { segmentIds: scenario.segmentIds });
        // Calculate segments to send (exclude the ones we want fresh)
        const currentSegmentIds = store.getSegmentState().currentSegmentIds;
        const segmentsToSend = currentSegmentIds.filter(
          (sid) => !scenario.segmentIds.includes(sid)
        );

        // Clear consolidation tracking before fetch
        handle.clearConsolidation();

        await refetchRoute({
          segments: segmentsToSend,
          interceptSourceUrl,
        });
        store.broadcastCacheInvalidation();
        break;
      }

      case "concurrent-skip": {
        log("skipping UI update, other actions fetching", {
          otherCount: scenario.otherFetchingCount,
        });
        // Only update store if history key hasn't changed (user didn't navigate away)
        const currentKeyNow = store.getHistoryKey();
        if (currentKeyNow === currentKey) {
          store.setSegmentIds(matched);
          const currentHandleData = eventController.getHandleState().data;
          store.cacheSegmentsForHistory(
            currentKey,
            fullSegments,
            currentHandleData,
          );
        }
        break;
      }

      case "normal": {
        // Prepare client loaders: put pending Promises in loaderData
        prepareClientLoaders(fullSegments, new URL(window.location.href), undefined, window.history.state);

        // Prepare new tree (await loader data resolution)
        const newTree = await renderSegments(reconciled.mainSegments, {
          isAction: true,
          interceptSegments:
            reconciled.interceptSegments.length > 0
              ? reconciled.interceptSegments
              : undefined,
        });

        // Re-check if user navigated away (could happen during async renderSegments)
        if (window.location.pathname !== actionStartPathname) {
          log("user navigated during render, skipping");
          break;
        }

        // Verify the store's current key still matches what we captured at action start
        // If they differ, user navigated away and we should NOT cache under the old key
        const currentKeyNow = store.getHistoryKey();
        if (currentKeyNow !== currentKey) {
          log("history key changed during action, skipping cache update");
          break;
        }

        startTransition(() => {
          onUpdate({ root: newTree, metadata: metadata! });
        });

        // Update store state
        store.setSegmentIds(matched);
        const currentHandleData = eventController.getHandleState().data;
        store.cacheSegmentsForHistory(
          currentKey,
          fullSegments,
          currentHandleData,
        );
        store.markCacheAsStaleAndBroadcast();
        break;
      }
    }

    handle.complete(returnData);
    return returnData;
  }

  return {
    /**
     * Register the server action callback with the RSC runtime
     */
    register(): void {
      if (isRegistered) {
        console.warn("[Browser] Server action bridge already registered");
        return;
      }
      deps.setServerCallback(handleServerAction);
      isRegistered = true;
    },

    /**
     * Unregister the server action callback
     */
    unregister(): void {
      if (!isRegistered) {
        return;
      }
      isRegistered = false;
    },
  };
}

export { createServerActionBridge as default };
