import type {
  ServerActionBridge,
  ServerActionBridgeConfig,
  RscPayload,
  ResolvedSegment,
  NavigationStore,
} from "./types.js";
import { createPartialUpdater } from "./partial-update.js";
import { createNavigationTransaction } from "./navigation-bridge.js";
import {
  mergeSegmentLoaders,
  needsLoaderMerge,
} from "./merge-segment-loaders.js";
import { startTransition, createElement } from "react";
import type { EventController, ActionHandle } from "./event-controller.js";
import { NetworkError, isNetworkError } from "../errors.js";
import { NetworkErrorThrower } from "../network-error-thrower.js";

// Polyfill Symbol.dispose/asyncDispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}
if (typeof Symbol.asyncDispose === "undefined") {
  (Symbol as any).asyncDispose = Symbol("Symbol.asyncDispose");
}

/**
 * Extract function name from full action ID
 * Server actions have IDs like "/src/handlers/shop/actions/shop.actions.ts#updateCartQuantity"
 * We normalize to just "updateCartQuantity" for store tracking
 */
function normalizeActionId(actionId: string): string {
  if (actionId.includes("#")) {
    return actionId.split("#").pop()!;
  }
  return actionId;
}

/**
 * Extended configuration for server action bridge with event controller
 */
export interface ServerActionBridgeConfigWithController
  extends ServerActionBridgeConfig {
  eventController: EventController;
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
  const { store, client, eventController, deps, onUpdate, renderSegments } =
    config;

  let isRegistered = false;

  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
  });

  /**
   * Server action callback handler
   */
  async function handleServerAction(id: string, args: any[]): Promise<unknown> {
    // Normalize action ID to just the function name for store tracking
    const locationKey = window.history.state?.key;
    const actionId = normalizeActionId(id);
    console.log("ID", { id, actionId, args });

    // Start action in event controller - handles lifecycle tracking
    using handle = eventController.startAction(actionId, args);

    const segmentState = store.getSegmentState();
    console.log(`[Browser] Args:`, args);

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

    // Encode arguments
    const encodedBody = await deps.encodeReply(args, { temporaryReferences });

    console.log(
      `[Browser] Encoded body type:`,
      typeof encodedBody,
      encodedBody instanceof FormData
    );
    console.log(`[Browser] Sending action request to: ${url.href}`);
    console.log(
      `[Browser] Current segments: ${segmentState.currentSegmentIds.join(", ")}`
    );

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
        // Send intercept source URL so server can maintain intercept context
        ...(interceptSourceUrl && {
          "X-RSC-Router-Intercept-Source": interceptSourceUrl,
        }),
      },
      body: encodedBody,
    }).then(async (response) => {
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
          console.log("[STREAMING] RSC stream complete");
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
      if (isNetworkError(error)) {
        const networkError = new NetworkError(
          "Unable to connect to server. Please check your connection.",
          {
            cause: error,
            url: url.toString(),
            operation: "action",
          }
        );

        // Mark action as failed
        handle.fail(networkError);

        // Emit the network error so the root error boundary can catch it
        // NetworkErrorThrower throws during render to trigger the error boundary
        startTransition(() => {
          onUpdate({
            root: createElement(NetworkErrorThrower, { error: networkError }),
            metadata: {
              pathname: segmentState.currentUrl,
              segments: [],
              isError: true,
            },
          });
        });

        throw networkError;
      }
      throw error;
    }

    console.log(`[Browser] Action response received:`, payload.metadata);

    // Process response
    const { metadata, returnValue } = payload;
    const { matched, diff, segments, isPartial, isError } = metadata || {};

    // Log action result
    if (returnValue) {
      console.log(`[Browser] Action result:`, returnValue);
      if (!returnValue.ok) {
        console.error(`[Browser] Action failed:`, returnValue.data);
      }
    }

    // Handle error responses with error boundary UI
    if (isError && isPartial && segments && diff) {
      console.log(`[Browser] Processing error boundary response`);

      // Abort all other pending action requests - error takes precedence
      // This prevents other actions from completing and overwriting the error UI
      eventController.abortAllActions();

      // Clear concurrent action tracking - no consolidation needed when showing error
      handle.clearConsolidation();

      // Get current page's cached segments
      const currentKey = store.getHistoryKey();
      const cached = store.getCachedSegments(currentKey);
      const cachedSegments = cached?.segments || [];

      // Create lookup for error segment from server
      const errorSegmentMap = new Map<string, ResolvedSegment>();
      segments.forEach((s: ResolvedSegment) => errorSegmentMap.set(s.id, s));

      // For error responses, use ALL cached segments but replace the errored one
      // This preserves sibling layouts that aren't in the parent chain
      const fullSegments = cachedSegments.map((cached) => {
        // Replace the error segment with the one from server
        const fromServer = errorSegmentMap.get(cached.id);
        if (fromServer) return fromServer;
        return cached;
      });

      // INTERCEPT HANDLING: Separate intercept segments for explicit injection
      const isInterceptSegment = (s: ResolvedSegment) =>
        s.namespace?.startsWith("intercept:") ||
        (s.type === "parallel" && s.id.includes(".@"));

      const interceptSegments = fullSegments.filter(isInterceptSegment);
      const mainSegments = fullSegments.filter((s) => !isInterceptSegment(s));

      // Render the full tree with error segment merged with parent layouts
      const errorRenderOptions = {
        isAction: true,
        interceptSegments:
          interceptSegments.length > 0 ? interceptSegments : undefined,
      };
      const errorTree = await renderSegments(mainSegments, errorRenderOptions);

      // Update UI with error boundary
      startTransition(() => {
        onUpdate({ root: errorTree, metadata: metadata! });
      });

      console.log(`[Browser] Error boundary UI rendered`);

      // Update segment tracking to exclude error segment IDs
      const errorSegmentIds = new Set(diff);
      const segmentIdsAfterError = segmentState.currentSegmentIds.filter(
        (id) => !errorSegmentIds.has(id)
      );

      // Update store state
      store.setSegmentIds(segmentIdsAfterError);
      store.cacheSegmentsForHistory(currentKey, fullSegments);

      console.log(
        `[Browser] Segment IDs updated (excluding error segments):`,
        segmentIdsAfterError
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

    if (isPartial) {
      console.log(`[Browser] Processing partial update`);
      console.log(
        `[Browser] Server sent ${segments?.length || 0} segments in diff:`,
        diff
      );
      console.log(`[Browser] Server expects client to have:`, matched);

      // Record revalidated segments for concurrent action tracking
      if (diff) {
        handle.recordRevalidatedSegments(diff);
      }

      // Get current page's cached segments for merging
      const currentKey = store.getHistoryKey();
      const cached = store.getCachedSegments(currentKey);
      const cachedSegments = cached?.segments || [];
      const currentSegmentMap = new Map<string, ResolvedSegment>();
      cachedSegments.forEach((s) => currentSegmentMap.set(s.id, s));

      console.log(
        `[Browser] Client cache has ${currentSegmentMap.size} entries:`,
        Array.from(currentSegmentMap.keys())
      );

      // Create lookup for new segments from server
      const newSegmentMap = new Map<string, ResolvedSegment>();
      (segments || []).forEach((s: ResolvedSegment) =>
        newSegmentMap.set(s.id, s)
      );

      if (!matched) {
        console.log(`[Browser] Matched segments: ${matched}`);
        throw new Error("No matched segments in response");
      }

      // Rebuild from matched: merge server segments with cached, or use cached as fallback
      const fullSegments = matched
        .map((segId: string) => {
          const fromServer = newSegmentMap.get(segId);
          const fromCache = currentSegmentMap.get(segId);

          if (fromServer) {
            // Server returned this segment - check if we need to merge partial loaders
            if (needsLoaderMerge(fromServer, fromCache)) {
              return mergeSegmentLoaders(fromServer, fromCache);
            }
            return fromServer;
          }

          // Fall back to current page's cached segments
          if (!fromCache) {
            console.error(`[Browser] MISSING SEGMENT: ${segId} not in cache!`);
          }
          return fromCache;
        })
        .filter(Boolean) as ResolvedSegment[];

      console.log(
        `[Browser] Rebuilt ${fullSegments.length} segments from matched array`
      );

      const returnData = returnValue?.data;

      console.log(
        `[Browser] Action complete - UI updated (after action state committed)`
      );

      if (returnValue && !returnValue.ok) {
        handle.fail(returnValue.data);
        throw returnValue.data;
      }

      // Check if user navigated away during the action
      const currentPathname = window.location.pathname;
      const currentLocationKey = window.history.state?.key;
      const userNavigatedAway =
        currentPathname !== actionStartPathname ||
        currentLocationKey !== locationKey;

      if (userNavigatedAway) {
        console.log(
          `[Browser] User navigated away during action (${actionStartPathname} -> ${currentPathname})`
        );
        // Clear concurrent action tracking - don't consolidate for old route's segments
        handle.clearConsolidation();

        // Check if the history key changed (different cache entry)
        // This happens when navigating between intercept and non-intercept routes
        // In this case, we should NOT refetch - let the stale-while-revalidate handle it
        // Refetching here would corrupt the current route's cache with wrong segments
        if (currentLocationKey !== locationKey) {
          console.log(
            `[Browser] History key changed (${locationKey} -> ${currentLocationKey}), skipping refetch to avoid cache corruption`
          );
          // Just complete the action - cache is already marked stale
          handle.complete(returnData);
          return returnData;
        }

        // Same history key but different pathname (e.g., same-page navigation)
        // Safe to refetch current route
        console.log(`[Browser] Same history key, refetching current route`);
        store.markCacheAsStaleAndBroadcast();
        using navTx = createNavigationTransaction(
          store,
          eventController,
          window.location.href,
          { replace: true, skipLoadingState: true }
        );
        // Preserve intercept context
        const currentInterceptSource = store.getInterceptSourceUrl();
        await fetchPartialUpdate(
          window.location.href,
          [], // Empty array = refetch all segments for current route
          false,
          navTx.handle.signal,
          navTx.with({
            url: window.location.href,
            storeOnly: true,
            intercept: !!currentInterceptSource,
            interceptSourceUrl: currentInterceptSource ?? undefined,
          }),
          {
            isAction: true,
            interceptSourceUrl: currentInterceptSource ?? undefined,
          }
        );
        console.log(`[Browser] Refetch after navigation complete`);
        handle.complete(returnData);
        return returnData;
      }

      // HMR resilience check - only runs if user DIDN'T navigate away
      if (fullSegments.length < matched.length) {
        console.warn(
          `[Browser] Missing segments after action (HMR detected), refetching...`
        );

        using navTx = createNavigationTransaction(
          store,
          eventController,
          window.location.href,
          { replace: true, skipLoadingState: true }
        );
        await fetchPartialUpdate(
          window.location.href,
          [],
          false,
          navTx.handle.signal,
          navTx.with({
            url: window.location.href,
            storeOnly: true,
            intercept: !!interceptSourceUrl,
            interceptSourceUrl: interceptSourceUrl ?? undefined,
          }),
          {
            isAction: true,
            interceptSourceUrl: interceptSourceUrl ?? undefined,
          }
        );
        console.log(
          `[Browser] Refetch complete (HMR), now returning action result`
        );

        // Broadcast to other tabs
        store.broadcastCacheInvalidation();
        handle.complete(returnData);
        return returnData;
      }

      // Check if we need a consolidation fetch due to concurrent actions
      const consolidationSegments = handle.getConsolidationSegments();

      if (consolidationSegments && consolidationSegments.length > 0) {
        // This is the last concurrent action - do consolidation fetch
        console.log(
          `[Browser] Concurrent actions detected - consolidation fetch needed for:`,
          consolidationSegments
        );
        // Calculate segments to send (exclude the ones we want fresh)
        const currentSegmentIds = store.getSegmentState().currentSegmentIds;
        const segmentsToSend = currentSegmentIds.filter(
          (id) => !consolidationSegments.includes(id)
        );

        console.log(
          `[Browser] Sending segments (excluding revalidated):`,
          segmentsToSend
        );

        // Clear consolidation tracking before fetch
        handle.clearConsolidation();

        using navTx = createNavigationTransaction(
          store,
          eventController,
          window.location.href,
          { replace: true, skipLoadingState: true }
        );

        console.warn("Fetch partial", id);
        await fetchPartialUpdate(
          window.location.href,
          segmentsToSend,
          false,
          navTx.handle.signal,
          navTx.with({
            url: window.location.href,
            storeOnly: true,
            intercept: !!interceptSourceUrl,
            interceptSourceUrl: interceptSourceUrl ?? undefined,
          }),
          {
            isAction: true,
            interceptSourceUrl: interceptSourceUrl ?? undefined,
          }
        );

        console.log(`[Browser] Consolidation fetch complete`);
        // Broadcast to other tabs
        store.broadcastCacheInvalidation();
        console.log(
          `[Browser] Consolidate/Reconcile - Returning to React:`,
          returnData
        );

        handle.complete(returnData);
        return returnData;
      }

      // Check if there are OTHER actions still fetching (waiting for server response)
      // Exclude the current action since we already have our response
      // We don't need to wait for streaming to complete - just for the response to arrive
      const otherFetchingActions = [...eventController.getInflightActions().values()].filter(
        (a) => a.phase === "fetching" && a.id !== handle.id
      );
      if (otherFetchingActions.length > 0) {
        console.log(
          `[Browser] Skipping UI update - ${otherFetchingActions.length} other action(s) still fetching`
        );
        console.log(
          `[Browser] Multi actions - Returning to React (no cache clear):`,
          returnData
        );
        // Only update store if history key hasn't changed (user didn't navigate away)
        const currentKeyNow = store.getHistoryKey();
        if (currentKeyNow === currentKey) {
          store.setSegmentIds(matched);
          store.cacheSegmentsForHistory(currentKey, fullSegments);
        } else {
          console.log(
            `[Browser] History key changed during multi-action (${currentKey} -> ${currentKeyNow}), skipping cache update`
          );
        }
        handle.complete(returnData);
        return returnData;
      }

      // No concurrent actions - normal flow with single action
      // INTERCEPT HANDLING: Separate intercept segments for explicit injection
      const isInterceptSegment = (s: ResolvedSegment) =>
        s.namespace?.startsWith("intercept:") ||
        (s.type === "parallel" && s.id.includes(".@"));

      const interceptSegments = fullSegments.filter(isInterceptSegment);
      const mainSegments = fullSegments.filter((s) => !isInterceptSegment(s));

      // Prepare new tree (await loader data resolution)
      const renderOptions = {
        isAction: true,
        interceptSegments:
          interceptSegments.length > 0 ? interceptSegments : undefined,
      };
      const newTree = renderSegments(mainSegments, renderOptions);

      // Re-check if user navigated away (could happen during async wait)
      const currentPathnameNow = window.location.pathname;
      if (currentPathnameNow !== actionStartPathname) {
        console.log(
          `[Browser] User navigated during UI update scheduling, skipping`
        );
        handle.complete(returnData);
        return returnData;
      }

      // Verify the store's current key still matches what we captured at action start
      // If they differ, user navigated away and we should NOT cache under the old key
      const currentKeyNow = store.getHistoryKey();
      if (currentKeyNow !== currentKey) {
        console.log(
          `[Browser] History key changed during action (${currentKey} -> ${currentKeyNow}), skipping cache update`
        );
        handle.complete(returnData);
        return returnData;
      }

      console.log("Update", id);

      startTransition(() => {
        onUpdate({ root: newTree, metadata: metadata! });
      });

      // Update store state
      store.setSegmentIds(matched);
      store.cacheSegmentsForHistory(currentKey, fullSegments);
      store.markCacheAsStaleAndBroadcast();

      console.log(`[Browser] Normal - Returning to React:`, returnData);
      handle.complete(returnData);
      return returnData;
    } else {
      // Full update not supported for actions
      throw new Error(
        `[Browser] Full update after action is not supported yet`
      );
    }
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
      console.log("[Browser] Server action callback registered");
    },

    /**
     * Unregister the server action callback
     */
    unregister(): void {
      if (!isRegistered) {
        return;
      }
      isRegistered = false;
      console.log("[Browser] Server action bridge unregistered");
    },
  };
}

export { createServerActionBridge as default };
