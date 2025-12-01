import type {
  ServerActionBridge,
  ServerActionBridgeConfig,
  RscPayload,
  ResolvedSegment,
} from "./types.js";
import { createPartialUpdater } from "./partial-update.js";
import { createNavigationTransaction } from "./navigation-bridge.js";
import { startTransition } from "react";

// Polyfill Symbol.dispose/asyncDispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}
if (typeof Symbol.asyncDispose === "undefined") {
  (Symbol as any).asyncDispose = Symbol("Symbol.asyncDispose");
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
  function createStreamScope(stream: ReadableStream, onComplete?: () => void) {
    const reader = stream.getReader();
    store.setState({ isStreaming: true });
    return {
      reader,
      async [Symbol.asyncDispose]() {
        reader.releaseLock();
        store.setState({ isStreaming: false });
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
  function createActionTransaction(actionId: string, args: any[]) {
    const id = `${actionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    let status: "pending" | "completed" | "error" = "pending";

    // Track if this action started while others were pending (concurrent)
    const hadConcurrentActions = pendingActionCount > 0;
    if (hadConcurrentActions) {
      hadAnyConcurrentActions = true;
    }
    pendingActionCount++;

    // Add to inflight actions
    store.addInflightAction({
      id,
      actionId,
      payload: args,
      startedAt: Date.now(),
    });

    store.setActionInProgress(true);
    store.setState({ state: "loading" });

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
      commit(segmentIds?: string[], segments?: ResolvedSegment[], skipCacheClear?: boolean) {
        status = "completed";
        // Update segment state if provided
        if (segmentIds) {
          store.setSegmentIds(segmentIds);
        }
        // Clear old cache and store new segments for next navigation's merging
        // Skip if consolidation fetch already handled the cache
        if (!skipCacheClear) {
          store.clearHistoryCache();
        }
        if (segments) {
          const currentKey = store.getHistoryKey();
          store.cacheSegmentsForHistory(currentKey, segments);
        }
      },
      error() {
        status = "error";
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
    console.log("ID", { id, args });

    // Create new disposable controller (allow concurrent actions)
    using disposable = requestController.createDisposable();
    const abortController = disposable.controller;

    const segmentState = store.getSegmentState();
    console.log(`[Browser] Args:`, args);

    // Transaction for action state and inflight tracking (cleanup on scope exit)
    using tx = createActionTransaction(id, args);

    // Create temporary references for serialization
    const temporaryReferences = deps.createTemporaryReferenceSet();

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

    // Send action request with stream tracking
    const responsePromise = fetch(url, {
      method: "POST",
      headers: {
        "rsc-action": id,
        "X-RSC-Router-Client-Path": segmentState.currentUrl,
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
        await using streamScope = createStreamScope(trackingStream, () => {
          console.log("[STREAMING] RSC stream complete");
          resolveStreamComplete();
        });
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
      requestController.abortAll();

      // Clear concurrent action tracking - no consolidation needed when showing error
      tx.clearConsolidation();

      // Get current page's cached segments
      const currentKey = store.getHistoryKey();
      const cachedSegments = store.getCachedSegments(currentKey) || [];

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

      // Render the full tree with error segment merged with parent layouts
      const errorTree = await renderSegments(fullSegments, { isAction: true });

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
        tx.error();
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
      const cachedSegments = store.getCachedSegments(currentKey) || [];
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

      // Rebuild from matched: server segments first, then cached segments
      const fullSegments = matched
        .map((segId: string) => {
          // First check server response (new/updated segments)
          const fromServer = newSegmentMap.get(segId);
          if (fromServer) return fromServer;
          // Fall back to current page's cached segments
          const fromCache = currentSegmentMap.get(segId);
          if (!fromCache) {
            console.error(`[Browser] MISSING SEGMENT: ${segId} not in cache!`);
          }
          return fromCache;
        })
        .filter(Boolean) as ResolvedSegment[];

      console.log(
        `[Browser] Rebuilt ${fullSegments.length} segments from matched array`
      );

      // HMR resilience check
      if (fullSegments.length < matched.length) {
        console.warn(`[Browser] Missing segments after action, refetching...`);
        console.log(`[Browser] returnValue before refetch:`, returnValue);

        // Save return value before refetch
        const savedReturnValue = returnValue;

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
        console.log(`[Browser] Refetch complete, now returning action result`);

        // Return action result AFTER UI is refreshed
        if (savedReturnValue && !savedReturnValue.ok) {
          throw savedReturnValue.data;
        }

        const dataToReturn = savedReturnValue?.data;
        console.log(`[Browser] Returning to React (HMR case):`, dataToReturn);
        tx.commit();
        return dataToReturn;
      }

      if (segmentState.path !== metadata?.pathname) {
        console.warn(
          `[Browser] Path changed during action, skipping UI update`
        );
      }

      const returnData = returnValue?.data;

      if (returnValue && !returnValue.ok) {
        throw returnValue.data;
      }

      if (abortController.signal.aborted) {
        console.log(`[Browser] Action aborted - skipping UI update`);
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
        console.log(`[Browser] Returning to React:`, returnData);
        // Skip cache clear - consolidation fetch already handled the cache via navTx
        tx.commit(undefined, undefined, true);
        return returnData;
      }

      // Check if there are still other actions pending
      // If so, skip UI update - the last action will handle consolidation
      if (pendingActionCount > 1) {
        console.log(
          `[Browser] Skipping UI update - ${pendingActionCount - 1} other action(s) still pending`
        );
        console.log(`[Browser] Returning to React:`, returnData);
        tx.commit(matched, fullSegments);
        return returnData;
      }

      // No concurrent actions - normal flow with single action
      // Prepare new tree (await loader data resolution)
      // Pass isAction: true to await component promises on client
      const newTree = await renderSegments(fullSegments, { isAction: true });

      // Schedule UI update after React processes the action return value.
      // queueMicrotask: waits for React's synchronous work + promise callbacks
      // double queueMicrotask + requestAnimationFrame ensures we yield to React
      queueMicrotask(() => {
        queueMicrotask(() => {
          requestAnimationFrame(() => {
            if (!abortController.signal.aborted) {
              console.warn("Update", id);
              startTransition(() => {
                onUpdate({ root: newTree, metadata: metadata! });
              });
            }
          });
        });
      });
      console.log(
        `[Browser] Action complete - UI updated (after action state committed)`
      );

      console.log(`[Browser] Returning to React:`, returnData);
      tx.commit(matched, fullSegments);
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
