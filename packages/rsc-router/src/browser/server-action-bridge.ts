import type {
  ServerActionBridge,
  ServerActionBridgeConfig,
  RscPayload,
  ResolvedSegment,
} from "./types.js";
import { createPartialUpdater } from "./partial-update.js";
import { createNavigationTransaction } from "./navigation-bridge.js";
import { mergeSegmentLoaders, needsLoaderMerge } from "./merge-segment-loaders.js";
import { startTransition } from "react";

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
 * Create a server action bridge for handling RSC server actions
 *
 * The bridge registers a callback with the RSC runtime that handles:
 * - Encoding action arguments
 * - Sending action requests to the server
 * - Processing responses and updating UI
 * - Managing concurrent action requests
 * - HMR resilience (refetching if segments are missing)
 *
 * @param config - Bridge configuration
 * @returns ServerActionBridge instance
 *
 * @example
 * ```typescript
 * const bridge = createServerActionBridge({
 *   store,
 *   client,
 *   requestController,
 *   deps: { setServerCallback, encodeReply, createTemporaryReferenceSet, createFromFetch },
 *   onUpdate: (update) => store.emit(update),
 *   renderSegments,
 * });
 *
 * bridge.register();
 * ```
 */
export function createServerActionBridge(
  config: ServerActionBridgeConfig
): ServerActionBridge {
  const { store, client, requestController, deps, onUpdate, renderSegments } =
    config;

  let isRegistered = false;

  // Track segments revalidated by concurrent actions
  // When multiple actions run concurrently, we collect all revalidated segments
  // and do a consolidation fetch after the last one completes
  const concurrentRevalidatedSegments = new Set<string>();
  let pendingActionCount = 0;
  let hadAnyConcurrentActions = false; // True if any concurrent actions occurred

  /**
   * Creates an async disposable scope for tracking stream state.
   * Releases the reader lock, resets streaming state, and signals completion when disposed.
   */
  function createStreamScope(
    stream: ReadableStream,
    signal: AbortSignal,
    actionId?: string,
    onComplete?: () => void
  ) {
    const reader = stream.getReader();
    if (!signal.aborted) {
      store.setState({ isStreaming: true });
      // Emit action state: streaming (if tracking an action)
      if (actionId) {
        store.setActionState(actionId, { state: "streaming" });
      }
    }
    return {
      reader,
      async [Symbol.asyncDispose]() {
        reader.releaseLock();
        if (!signal.aborted) {
          store.setState({ isStreaming: false });
        }
        onComplete?.();
      },
    };
  }

  /**
   * Creates a disposable transaction for action state and inflight tracking.
   * Tracks the action as inflight, sets loading state, and cleans up on disposal.
   * Only sets idle state when ALL actions are complete (supports concurrent actions).
   *
   * For concurrent actions: tracks revalidated segments and triggers consolidation
   * fetch after all actions complete to ensure data consistency.
   */
  function createActionTransaction(
    actionId: string,
    args: any[],
    signal: AbortSignal
  ) {
    const id = `${actionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let status: "pending" | "completed" | "error" = "pending";

    // Track if this action started while others were pending (concurrent)
    const hadConcurrentActions = pendingActionCount > 0;
    if (hadConcurrentActions) {
      hadAnyConcurrentActions = true;
    }
    pendingActionCount++;

    const startedAt = Date.now();

    // Add to inflight actions
    store.addInflightAction({
      id,
      actionId,
      payload: args,
      startedAt,
    });

    store.setActionInProgress(true);
    store.setState({ state: "loading" });

    // Emit action state: loading
    store.setActionState(actionId, {
      state: "loading",
      payload: args,
      error: null,
      result: null,
    });

    // Mark cache as stale immediately when action starts
    // This ensures SWR pattern kicks in if user navigates away during action
    store.markCacheAsStaleAndBroadcast();

    return {
      id,
      hadConcurrentActions,
      /**
       * Record segments that were revalidated by this action
       * Used for consolidation fetch when actions are concurrent
       */
      recordRevalidatedSegments(diff: string[]) {
        if (diff && diff.length > 0) {
          diff.forEach((segId) => concurrentRevalidatedSegments.add(segId));
        }
      },
      /**
       * Check if consolidation fetch is needed and return segments to refresh
       * Returns null if no consolidation needed, or array of segment IDs to exclude
       */
      getConsolidationSegments(): string[] | null {
        // Only consolidate if this was the last action AND there were concurrent actions
        if (pendingActionCount > 1) {
          return null; // More actions still pending
        }
        if (!hadAnyConcurrentActions) {
          return null; // No concurrent actions occurred
        }
        if (concurrentRevalidatedSegments.size === 0) {
          return null; // No segments to consolidate
        }
        // Return segments that need fresh data
        const segments = Array.from(concurrentRevalidatedSegments);
        return segments;
      },
      /**
       * Clear consolidation tracking (call after consolidation fetch)
       */
      clearConsolidation() {
        concurrentRevalidatedSegments.clear();
        hadAnyConcurrentActions = false;
      },
      commit(
        segmentIds?: string[],
        segments?: ResolvedSegment[],
        skipCacheClear?: boolean,
        result?: unknown
      ) {
        status = "completed";
        // Update segment state if provided
        if (segmentIds) {
          store.setSegmentIds(segmentIds);
        }
        // Mark cache as stale (SWR pattern) - allows instant back/forward with background revalidation
        // Skip if consolidation fetch already handled the cache
        if (!skipCacheClear) {
          store.markCacheAsStaleAndBroadcast();
        }
        if (segments) {
          const currentKey = store.getHistoryKey();
          store.cacheSegmentsForHistory(currentKey, segments);
        }
        // Emit action state: idle with result (preserves payload)
        store.setActionState(actionId, {
          state: "idle",
          result,
          error: null,
        });
      },
      error(err?: unknown) {
        status = "error";
        // Emit action state: idle with error (preserves payload)
        store.setActionState(actionId, {
          state: "idle",
          error: err,
          result: null,
        });
      },
      get signal() {
        return signal;
      },
      [Symbol.dispose]() {
        // Decrement pending count
        pendingActionCount--;

        // Remove from inflight actions
        store.removeInflightAction(id);

        // Only set idle if no other actions in flight
        if (store.getState().inflightActions.length === 0) {
          store.setState({ state: "idle" });
          store.setActionInProgress(false);
        }
      },
    };
  }

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
    const actionId = normalizeActionId(id);
    console.log("ID", { id, actionId, args });

    // Create action-specific disposable controller
    // Actions use separate tracking - NOT aborted by navigation
    using disposable = requestController.createActionDisposable();
    const abortController = disposable.controller;

    const segmentState = store.getSegmentState();
    console.log(`[Browser] Args:`, args);

    // Transaction for action state and inflight tracking (cleanup on scope exit)
    using tx = createActionTransaction(actionId, args, abortController.signal);

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
      if (!response.body) {
        // No body means stream is already complete
        resolveStreamComplete();
        return response;
      }

      // Tee the stream: one for RSC runtime, one for tracking completion
      const [rscStream, trackingStream] = response.body.tee();

      // Consume the tracking stream to detect when it closes
      (async () => {
        await using streamScope = createStreamScope(
          trackingStream,
          tx.signal,
          actionId, // Pass normalized action ID for state tracking
          () => {
            console.log("[STREAMING] RSC stream complete");
            resolveStreamComplete();
          }
        );
        const { reader } = streamScope;

        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
        await reader.closed;
        // All cleanup (releaseLock, isStreaming: false, resolveStreamComplete) happens on scope exit
      })().catch((error) => {
        console.error("[STREAMING] Error reading tracking stream:", error);
      });

      // Return response with the RSC stream
      return new Response(rscStream, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    });

    // Deserialize response (MUST use same temporaryReferences)
    const payload = await deps.createFromFetch<RscPayload>(responsePromise, {
      temporaryReferences,
    });

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
      requestController.abortAllActions();

      // Clear concurrent action tracking - no consolidation needed when showing error
      tx.clearConsolidation();

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
      // Same logic as partial-update.ts to ensure intercepts render in correct slots
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
      // This ensures the next navigation will re-fetch these segments
      // instead of assuming they're still cached
      const errorSegmentIds = new Set(diff);
      const segmentIdsAfterError = segmentState.currentSegmentIds.filter(
        (id) => !errorSegmentIds.has(id)
      );
      tx.commit(segmentIdsAfterError, fullSegments);
      console.log(
        `[Browser] Segment IDs updated (excluding error segments):`,
        segmentIdsAfterError
      );

      // Throw the error so the action promise rejects
      // This allows the calling component to catch it if needed
      if (returnValue && !returnValue.ok) {
        tx.error(returnValue.data);
        throw returnValue.data;
      }

      // No error in returnValue (shouldn't happen with isError: true, but handle gracefully)
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
        tx.recordRevalidatedSegments(diff);
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

      if (returnValue && !returnValue.ok) {
        tx.error(returnValue.data);
        throw returnValue.data;
      }

      // Check if user navigated away during the action
      // IMPORTANT: This check MUST come before HMR resilience check because:
      // - If user navigated away, the current cache has segments for the NEW route
      // - The action response expects segments from the OLD route
      // - Missing segments are NOT due to HMR, but due to navigation
      // - HMR refetch would use window.location.href (new route), causing mismatch
      // We compare window.location.pathname (not store.path) because:
      // - For intercepts, store.path stays as base route while URL changes
      // - For regular routes, both change but pathname is the source of truth
      const currentPathname = window.location.pathname;
      const userNavigatedAway = currentPathname !== actionStartPathname;

      if (userNavigatedAway) {
        console.log(
          `[Browser] User navigated away during action (${actionStartPathname} -> ${currentPathname}), refetching current route`
        );
        // Clear concurrent action tracking - don't consolidate for old route's segments
        tx.clearConsolidation();
        // Refetch current route to show fresh data. This is correct for all cases:
        // - Intercepts: action on /kanban/card/1 may update data visible on /kanban
        // - Regular routes: action on /page-a may update shared data visible on /page-b
        // Mark cache as stale (SWR pattern) - current page gets fresh data from refetch,
        // other pages will revalidate on next access
        store.markCacheAsStaleAndBroadcast();
        const navTx = createNavigationTransaction(
          store,
          abortController.signal
        );
        await fetchPartialUpdate(
          window.location.href,
          [], // Empty array = refetch all segments for current route
          false,
          abortController.signal,
          navTx.with({ url: window.location.href, storeOnly: true }),
          { isAction: true }
        );
        console.log(`[Browser] Refetch after navigation complete`);
        return returnData;
      }

      // HMR resilience check - only runs if user DIDN'T navigate away
      // At this point we know user is still on the same route, but segments are missing
      // This indicates actual HMR (module hot reload cleared the segment modules)
      if (fullSegments.length < matched.length) {
        console.warn(
          `[Browser] Missing segments after action (HMR detected), refetching...`
        );

        // Refetch and update UI FIRST (storeOnly - don't change URL)
        const navTx = createNavigationTransaction(
          store,
          abortController.signal
        );
        await fetchPartialUpdate(
          window.location.href,
          [],
          false,
          abortController.signal,
          navTx.with({ url: window.location.href, storeOnly: true }),
          { isAction: true }
        );
        console.log(
          `[Browser] Refetch complete (HMR), now returning action result`
        );

        // Broadcast to other tabs (local cache has fresh data from navTx.commit)
        store.broadcastCacheInvalidation();
        // Skip cache clear since we just refetched fresh data
        tx.commit(undefined, undefined, true, returnData);
        return returnData;
      }

      // Check if we need a consolidation fetch due to concurrent actions
      const consolidationSegments = tx.getConsolidationSegments();

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
        tx.clearConsolidation();

        // Do consolidation fetch to get fresh data for all revalidated segments
        // This will handle the UI update via onUpdate in partial-update
        // NOTE: Don't clear cache before fetch - it's needed for segment merging
        const navTx = createNavigationTransaction(
          store,
          abortController.signal
        );
        console.warn("Fetch partial", id);
        await fetchPartialUpdate(
          window.location.href,
          segmentsToSend,
          false,
          abortController.signal,
          navTx.with({ url: window.location.href, storeOnly: true }),
          { isAction: true }
        );

        console.log(`[Browser] Consolidation fetch complete`);
        // Broadcast to other tabs (local cache has fresh data from navTx.commit)
        store.broadcastCacheInvalidation();
        console.log(`[Browser] Returning to React:`, returnData);
        // Skip the normal tx cache clear since we just cleared it
        tx.commit(undefined, undefined, true, returnData);
        return returnData;
      }

      // Check if there are still other actions pending
      // If so, skip UI update and cache broadcast - the last action will handle consolidation
      if (pendingActionCount > 1) {
        console.log(
          `[Browser] Skipping UI update - ${pendingActionCount - 1} other action(s) still pending`
        );
        console.log(`[Browser] Returning to React:`, returnData);
        tx.commit(matched, fullSegments, true, returnData); // Skip cache clear - last action will broadcast
        return returnData;
      }

      // No concurrent actions - normal flow with single action
      // INTERCEPT HANDLING: Separate intercept segments for explicit injection
      // Same logic as partial-update.ts to ensure intercepts render in correct slots
      const isInterceptSegment = (s: ResolvedSegment) =>
        s.namespace?.startsWith("intercept:") ||
        (s.type === "parallel" && s.id.includes(".@"));

      const interceptSegments = fullSegments.filter(isInterceptSegment);
      const mainSegments = fullSegments.filter((s) => !isInterceptSegment(s));

      // Prepare new tree (await loader data resolution)
      // Pass isAction: true to await component promises on client
      // Pass intercept segments separately for explicit slot injection
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
        return;
      }
      console.log("Update", id);
      startTransition(() => {
        onUpdate({ root: newTree, metadata: metadata! });
      });
      console.log(
        `[Browser] Action complete - UI updated (after action state committed)`
      );

      console.log(`[Browser] Returning to React:`, returnData);
      tx.commit(matched, fullSegments, false, returnData);
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
      // Note: setServerCallback doesn't have an unregister API
      // We just mark as unregistered to prevent duplicate registration
      isRegistered = false;
      console.log("[Browser] Server action bridge unregistered");
    },
  };
}

export { createServerActionBridge as default };
