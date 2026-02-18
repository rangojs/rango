/**
 * Client Segment Runtime - Command Executor
 *
 * Logic-free translator: RuntimeCommand → browser API call.
 * Zero conditional logic. Any decision here is a bug — move it to the reducer.
 *
 * Async commands (FETCH) start the operation and dispatch events when results arrive.
 */

import type { RuntimeCommand, RuntimeEvent, FetchCommand } from "./types.js";
import type { NavigationClient, RscPayload } from "../types.js";
import { payloadToPatch } from "./snapshot-adapter.js";
import { NetworkError } from "../../errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutorContext {
  /** RSC fetch client */
  client: NavigationClient;
  /** Active abort controllers by txId */
  abortControllers: Map<string, AbortController>;
  /** RSC version string for cache invalidation */
  version?: string;
  /** Scroll restoration handlers */
  scroll: {
    savePosition: () => void;
    scrollToTop: () => void;
    restorePosition: () => void;
  };
  /** BroadcastChannel for cross-tab sync (null if not available) */
  broadcastChannel: BroadcastChannel | null;
  /** Callback for history state (intercept source URL) */
  getInterceptSourceUrl: () => string | null;
}

// ---------------------------------------------------------------------------
// Execute commands
// ---------------------------------------------------------------------------

/**
 * Execute a batch of commands. Called by the store after each reduce step.
 * RENDER commands are handled by the store (via onRender callbacks), not here.
 */
export function executeCommands(
  commands: RuntimeCommand[],
  dispatch: (event: RuntimeEvent) => void,
  ctx: ExecutorContext
): void {
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "FETCH":
        executeFetch(cmd.payload, dispatch, ctx);
        break;
      case "ABORT_FETCH":
        executeAbortFetch(cmd.payload.txId, ctx);
        break;
      case "PUSH_HISTORY":
        window.history.pushState(
          { key: cmd.payload.key, ...cmd.payload.state as object },
          "",
          cmd.payload.url
        );
        break;
      case "REPLACE_HISTORY":
        window.history.replaceState(
          { key: cmd.payload.key, ...cmd.payload.state as object },
          "",
          cmd.payload.url
        );
        break;
      case "BROADCAST_INVALIDATION":
        if (ctx.broadcastChannel) {
          ctx.broadcastChannel.postMessage({
            type: "cache-invalidation",
            path: cmd.payload.path,
            segmentIds: cmd.payload.segmentIds,
          });
        }
        break;
      case "SCROLL":
        executeScroll(cmd.payload.behavior, ctx);
        break;
      case "HARD_RELOAD":
        window.location.href = cmd.payload.url;
        break;
      // RENDER is handled by the store, not the executor
    }
  }
}

// ---------------------------------------------------------------------------
// FETCH executor
// ---------------------------------------------------------------------------

function executeFetch(
  payload: FetchCommand,
  dispatch: (event: RuntimeEvent) => void,
  ctx: ExecutorContext
): void {
  // Create abort controller for this fetch
  const abortController = new AbortController();
  ctx.abortControllers.set(payload.txId, abortController);

  const fetchOptions = {
    targetUrl: payload.url,
    segmentIds: payload.segmentIds,
    previousUrl: payload.previousUrl,
    signal: abortController.signal,
    staleRevalidation: payload.mode === "revalidate",
    interceptSourceUrl: ctx.getInterceptSourceUrl() ?? undefined,
    version: ctx.version,
    hmr: payload.mode === "hmr",
  };

  // Start async fetch
  (async () => {
    try {
      const { payload: rscPayload, streamComplete } = await ctx.client.fetchPartial(fetchOptions);

      // Check for version mismatch (handled by client via X-RSC-Reload header)
      const reloadUrl = (rscPayload as any)?.metadata?.reloadUrl;
      if (reloadUrl) {
        dispatch({ type: "VERSION_MISMATCH", reloadUrl });
        return;
      }

      // Convert RSC payload to ServerPatch
      const patch = payloadToPatch(rscPayload);

      // Dispatch stream start
      dispatch({ type: "STREAM_START", txId: payload.txId });

      // Dispatch response based on mode
      switch (payload.mode) {
        case "nav":
        case "hmr":
          dispatch({
            type: "NAV_RESPONSE",
            txId: payload.txId,
            patch,
          });
          break;
        case "action":
          dispatch({
            type: "ACTION_RESPONSE",
            txId: payload.txId,
            patch,
            returnValue: rscPayload.returnValue ?? undefined,
          });
          break;
        case "revalidate":
          dispatch({
            type: "REVALIDATE_DONE",
            txId: payload.txId,
            patch,
          });
          break;
      }

      // Process handles if present (async generator)
      if (patch.handles) {
        try {
          for await (const handleData of patch.handles) {
            dispatch({
              type: "HANDLES_UPDATE",
              txId: payload.txId,
              handles: handleData,
              matched: patch.matched,
            });
          }
        } catch {
          // Handle generator errors silently (stream may be aborted)
        }
      }

      // Wait for stream completion
      await streamComplete;

      // Dispatch stream end
      dispatch({ type: "STREAM_END", txId: payload.txId });

      // Check for missing segments
      if (patch.matched && patch.matched.length > 0) {
        const segmentIds = new Set(patch.segments.map((s) => s.id));
        const missing = patch.matched.filter(
          (id) => patch.diff?.includes(id) && !segmentIds.has(id)
        );
        if (missing.length > 0) {
          dispatch({
            type: "SEGMENTS_MISSING",
            txId: payload.txId,
            missing,
          });
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return; // Intentional abort

      dispatch({
        type: "NETWORK_ERROR",
        txId: payload.txId,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    } finally {
      ctx.abortControllers.delete(payload.txId);
    }
  })();
}

// ---------------------------------------------------------------------------
// ABORT_FETCH executor
// ---------------------------------------------------------------------------

function executeAbortFetch(txId: string, ctx: ExecutorContext): void {
  const controller = ctx.abortControllers.get(txId);
  if (controller) {
    controller.abort();
    ctx.abortControllers.delete(txId);
  }
}

// ---------------------------------------------------------------------------
// SCROLL executor
// ---------------------------------------------------------------------------

function executeScroll(
  behavior: "top" | "restore" | "none",
  ctx: ExecutorContext
): void {
  switch (behavior) {
    case "top":
      ctx.scroll.scrollToTop();
      break;
    case "restore":
      ctx.scroll.restorePosition();
      break;
    case "none":
      break;
  }
}
