import type {
  ServerActionBridge,
  ServerActionBridgeConfig,
  RscPayload,
  ResolvedSegment,
} from "./types.js";

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

  /**
   * Fetch partial update for HMR recovery or navigation
   * Returns a promise that resolves when the RSC stream is fully consumed
   */
  async function fetchPartialUpdate(
    targetUrl: string,
    segmentIds: string[],
    isRetry = false
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

    // Fetch partial payload
    const { payload, streamComplete } = await client.fetchPartial({
      targetUrl: url,
      segmentIds: segments,
      previousUrl: segmentState.currentUrl,
    });

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
        return fetchPartialUpdate(url, [], true);
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

  /**
   * Server action callback handler
   */
  async function handleServerAction(
    id: string,
    args: any[]
  ): Promise<unknown> {
    console.log("ID", { id, args });

    // Abort previous requests first, then create new disposable controller
    requestController.abortAll();
    using disposable = requestController.createDisposable();
    const abortController = disposable.controller;

    const segmentState = store.getSegmentState();
    console.log(`[Browser] Args:`, args);

    // Generate unique ID for this action invocation
    const actionInvocationId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Track this action as inflight
    store.addInflightAction({
      id: actionInvocationId,
      actionId: id,
      payload: args,
      startedAt: Date.now(),
    });

    // Set streaming state
    store.setState({ isStreaming: true });

    // Create temporary references for serialization
    const temporaryReferences = deps.createTemporaryReferenceSet();

    // Build action request URL with current segments
    const url = new URL(window.location.href);
    url.searchParams.set("_rsc_action", id);
    url.searchParams.set("_rsc_segments", segmentState.currentSegmentIds.join(","));

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
        resolveStreamComplete!();
        return response;
      }

      // Tee the stream: one for RSC runtime, one for tracking completion
      const [rscStream, trackingStream] = response.body.tee();

      // Consume the tracking stream to detect when it closes
      (async () => {
        const reader = trackingStream.getReader();
        try {
          
          while (true) {
            const { done ,value} = await reader.read();
            if (done) break;
          }
          await reader.closed
        } finally {
          
          resolveStreamComplete!();
        }
      })();

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
    const { matched, diff, segments, isPartial } = metadata || {};

    // Log action result
    if (returnValue) {
      console.log(`[Browser] Action result:`, returnValue);
      if (!returnValue.ok) {
        console.error(`[Browser] Action failed:`, returnValue.data);
      }
    }

    if (isPartial) {
      console.log(`[Browser] Processing partial update`);
      console.log(
        `[Browser] Server sent ${segments?.length || 0} segments in diff:`,
        diff
      );
      console.log(`[Browser] Server expects client to have:`, matched);
      console.log(
        `[Browser] Client storedSegments has ${segmentState.storedSegments.size} entries:`,
        Array.from(segmentState.storedSegments.keys())
      );

      // Store new segments
      store.storeSegments(segments || []);

      console.log(
        `[Browser] After storing, storedSegments has ${store.getSegmentState().storedSegments.size} entries`
      );

      if (!matched) {
        console.log(`[Browser] Matched segments: ${matched}`);
        throw new Error("No matched segments in response");
      }

      // Rebuild from matched (source of truth)
      const fullSegments = matched
        .map((segId: string) => {
          const segment = store.getSegmentState().storedSegments.get(segId);
          if (!segment) {
            console.error(
              `[Browser] MISSING SEGMENT: ${segId} not in storedSegments!`
            );
          }
          return segment;
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

        // Refetch and update UI FIRST
        await fetchPartialUpdate(window.location.href, []);
        console.log(`[Browser] Refetch complete, now returning action result`);

        // Wait for stream to complete before resetting state
        await streamComplete;
        // Remove from inflight actions and reset streaming
        store.removeInflightAction(actionInvocationId);
        store.setState({ isStreaming: false });

        // Return action result AFTER UI is refreshed
        if (savedReturnValue && !savedReturnValue.ok) {
          throw savedReturnValue.data;
        }

        const dataToReturn = savedReturnValue?.data;
        console.log(`[Browser] Returning to React (HMR case):`, dataToReturn);
        return dataToReturn;
      }

      if (segmentState.path !== metadata?.pathname) {
        console.warn(`[Browser] Path changed during action, skipping UI update`);
      }

      // Update segment state
      store.setSegmentIds(matched);

      const returnData = returnValue?.data;

      if (returnValue && !returnValue.ok) {
        // Wait for stream to complete before resetting state
        await streamComplete;
        // Remove from inflight actions and reset streaming
        store.removeInflightAction(actionInvocationId);
        store.setState({ isStreaming: false });
        throw returnValue.data;
      }

      if (abortController.signal.aborted) {
        await streamComplete;
        store.removeInflightAction(actionInvocationId);
        store.setState({ isStreaming: false });
        console.log(`[Browser] Action aborted - skipping UI update`);
        return returnData;
      }

      // Prepare new tree
      const newTree = renderSegments(fullSegments);

      // Wait for stream to complete before updating UI
      await streamComplete;

      if (!abortController.signal.aborted) {
        // Remove from inflight actions and reset streaming
        store.removeInflightAction(actionInvocationId);
        store.setState({ isStreaming: false });

        onUpdate({ root: newTree, metadata: metadata! });
        console.log(
          `[Browser] Action complete - UI updated (after action state committed)`
        );
      } else {
        // Remove from inflight actions on abort
        store.removeInflightAction(actionInvocationId);
        store.setState({ isStreaming: false });
        console.log(`[Browser] Action aborted - skipping UI update`);
      }

      console.log(`[Browser] Returning to React:`, returnData);

      return returnData;
    } else {
      // Full update
      store.setSegmentIds(matched || []);
      throw new Error(`[Browser] Full update after action is not supported yet`);
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
