/**
 * Client Segment Runtime - Top-level Wiring
 *
 * createRuntime() initializes the store, wires the executor, and connects
 * browser event sources (popstate, BroadcastChannel). This is the single
 * entry point that replaces the old initBrowserApp internals.
 */

import type { ResolvedSegment } from "../../types.js";
import type { NavigationClient, HandleData } from "../types.js";
import type {
  ClientRuntimeState,
  RuntimeEvent,
  CacheEntry,
  HandleState,
} from "./types.js";
import { createRuntimeStore, type RuntimeStore } from "./store.js";
import { executeCommands, type ExecutorContext } from "./executor.js";
import { buildInitialSnapshot, deriveCacheKey } from "./snapshot-adapter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  /** Current URL at initialization */
  initialUrl: string;
  /** Initial segments from SSR payload */
  initialSegments: ResolvedSegment[];
  /** Initial matched segment IDs */
  initialMatched: string[];
  /** RSC navigation client */
  client: NavigationClient;
  /** RSC version for cache invalidation */
  version?: string;
  /** Max cache entries */
  cacheMaxSize?: number;
  /** Initial handle data */
  initialHandleData?: HandleData;
  /** Scroll restoration callbacks */
  scroll?: {
    savePosition: () => void;
    scrollToTop: () => void;
    restorePosition: () => void;
  };
  /** Enable cross-tab cache sync */
  crossTabSync?: boolean;
}

export interface Runtime {
  /** The runtime store (for React integration) */
  store: RuntimeStore;
  /** Dispatch an event */
  dispatch: (event: RuntimeEvent) => void;
  /** Navigate to a URL */
  navigate: (url: string, options?: { replace?: boolean; scroll?: boolean; interceptSourceUrl?: string }) => void;
  /** Refresh current page */
  refresh: () => void;
  /** Handle popstate event */
  handlePopstate: (url: string, historyKey: string, interceptState?: { interceptSourceUrl: string }) => void;
  /** Cleanup listeners */
  destroy: () => void;
}

// ---------------------------------------------------------------------------
// Create runtime
// ---------------------------------------------------------------------------

export function createRuntime(config: RuntimeConfig): Runtime {
  const {
    initialUrl,
    initialSegments,
    initialMatched,
    client,
    version,
    cacheMaxSize = 20,
    initialHandleData,
    scroll = {
      savePosition: () => {},
      scrollToTop: () => window.scrollTo(0, 0),
      restorePosition: () => {},
    },
    crossTabSync = true,
  } = config;

  // Build initial snapshot
  const initialSnapshot = buildInitialSnapshot(
    initialUrl,
    initialSegments,
    initialMatched,
    {
      handleData: initialHandleData,
      version,
    }
  );

  // Build initial cache with current page
  const initialCache = new Map<string, CacheEntry>();
  initialCache.set(initialSnapshot.key, {
    snapshot: initialSnapshot,
    stale: false,
  });

  // Build initial state
  const initialState: ClientRuntimeState = {
    current: initialSnapshot,
    transactions: new Map(),
    navEpoch: 0,
    actionEpoch: 0,
    txCounter: 0,
    cache: initialCache,
    cacheMaxSize,
    phase: "idle",
    pendingUrl: null,
    handleState: {
      data: initialHandleData ?? {},
      segmentOrder: initialMatched,
    },
    interceptSourceUrl: null,
    networkError: null,
  };

  // Create store
  const store = createRuntimeStore(initialState);

  // Setup BroadcastChannel for cross-tab sync
  let broadcastChannel: BroadcastChannel | null = null;
  if (crossTabSync && typeof BroadcastChannel !== "undefined") {
    broadcastChannel = new BroadcastChannel("rsc-router-cache");
    broadcastChannel.onmessage = (event) => {
      if (event.data?.type === "cache-invalidation") {
        store.dispatch({
          type: "CROSS_TAB_INVALIDATION",
          path: event.data.path,
          segmentIds: event.data.segmentIds,
        });
      }
    };
  }

  // Setup executor context
  const executorCtx: ExecutorContext = {
    client,
    abortControllers: new Map(),
    version,
    scroll,
    broadcastChannel,
    getInterceptSourceUrl: () => store.getState().interceptSourceUrl,
  };

  // Wire executor to store
  store.setExecutor((commands, dispatch) => {
    executeCommands(commands, dispatch, executorCtx);
  });

  // Setup popstate listener
  const handlePopstateEvent = (event: PopStateEvent) => {
    const url = window.location.href;
    const historyKey = event.state?.key ?? deriveCacheKey(url);
    const interceptState = event.state?.interceptSourceUrl
      ? { interceptSourceUrl: event.state.interceptSourceUrl, slots: event.state.slots }
      : undefined;

    scroll.savePosition();

    store.dispatch({
      type: "POPSTATE",
      url,
      historyKey,
      interceptState,
    });
  };
  window.addEventListener("popstate", handlePopstateEvent);

  // Public API
  const dispatch = (event: RuntimeEvent) => store.dispatch(event);

  const navigate = (
    url: string,
    options?: { replace?: boolean; scroll?: boolean; interceptSourceUrl?: string }
  ) => {
    scroll.savePosition();
    store.dispatch({
      type: "NAV_START",
      url,
      options: {
        replace: options?.replace,
        scroll: options?.scroll,
        interceptSourceUrl: options?.interceptSourceUrl,
      },
    });
  };

  const refresh = () => {
    store.dispatch({
      type: "NAV_START",
      url: window.location.href,
      options: { replace: true },
    });
  };

  const handlePopstate = (
    url: string,
    historyKey: string,
    interceptState?: { interceptSourceUrl: string }
  ) => {
    store.dispatch({
      type: "POPSTATE",
      url,
      historyKey,
      interceptState,
    });
  };

  const destroy = () => {
    window.removeEventListener("popstate", handlePopstateEvent);
    if (broadcastChannel) {
      broadcastChannel.close();
    }
    // Abort all in-flight fetches
    for (const controller of executorCtx.abortControllers.values()) {
      controller.abort();
    }
    executorCtx.abortControllers.clear();
  };

  return {
    store,
    dispatch,
    navigate,
    refresh,
    handlePopstate,
    destroy,
  };
}
