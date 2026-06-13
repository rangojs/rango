import type {
  NavigateOptions,
  NavigationStore,
  ResolvedSegment,
  StreamingToken,
} from "./types.js";
import { generateHistoryKey } from "./navigation-store.js";
import {
  handleNavigationStart,
  ensureHistoryKey,
} from "./scroll-restoration.js";
import type { EventController, NavigationHandle } from "./event-controller.js";
import { debugLog } from "./logging.js";
import { buildHistoryState, pushHistoryWithIdx } from "./history-state.js";

export { resolveNavigationState } from "./history-state.js";

/** Check if a history state object contains location state keys. */
function hasLocationState(state: unknown): boolean {
  if (!state || typeof state !== "object") return false;
  return (
    "state" in state ||
    Object.keys(state).some((k) => k.startsWith("__rsc_ls_"))
  );
}

if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

/**
 * Options for committing a navigation transaction
 */
interface CommitOptions {
  url: string;
  segmentIds: string[];
  segments: ResolvedSegment[];
  replace?: boolean;
  scroll?: boolean;
  /** User-provided state to store in history.state */
  state?: unknown;
  /** If true, only update store without changing URL/history (for server actions) */
  storeOnly?: boolean;
  /** If true, this is an intercept route - store in history.state for popstate handling */
  intercept?: boolean;
  /** Source URL where the intercept was triggered from (stored in history.state) */
  interceptSourceUrl?: string;
  /** If true, only update cache without touching store or history (for background stale revalidation) */
  cacheOnly?: boolean;
  /** Server-set location state to merge into history.pushState */
  serverState?: Record<string, unknown>;
}

/**
 * Options that can override the pre-configured commit settings
 */
interface BoundCommitOverrides {
  /** Override scroll behavior (e.g., disable for intercepts) */
  scroll?: boolean;
  /** Override replace behavior (e.g., force replace for intercepts) */
  replace?: boolean;
  /** Override user-provided state */
  state?: unknown;
  /** Mark this as an intercept route */
  intercept?: boolean;
  /** Source URL where intercept was triggered from */
  interceptSourceUrl?: string;
  /** If true, only update cache (for stale revalidation) */
  cacheOnly?: boolean;
  /** Server-set location state to merge into history.pushState */
  serverState?: Record<string, unknown>;
}

/**
 * Bound transaction with pre-configured commit options (without segmentIds/segments)
 */
export interface BoundTransaction {
  readonly currentUrl: string;
  /** Start streaming and get a token to end it when the stream completes */
  startStreaming(): StreamingToken;
  /** Commit the navigation. Returns the effective scroll option for the caller to handle. */
  commit(
    segmentIds: string[],
    segments: ResolvedSegment[],
    overrides?: BoundCommitOverrides,
  ): { scroll?: boolean };
}

/**
 * Navigation transaction for managing state during navigation
 * Uses the event controller handle for lifecycle management
 */
interface NavigationTransaction extends Disposable {
  commit(options: CommitOptions): { scroll?: boolean };
  with(
    options: Omit<CommitOptions, "segmentIds" | "segments">,
  ): BoundTransaction;
  /** The navigation handle from the event controller */
  handle: NavigationHandle;
}

/**
 * Creates a navigation transaction that coordinates with the event controller.
 * Handles loading state transitions and cleanup on completion/abort.
 */
export function createNavigationTransaction(
  store: NavigationStore,
  eventController: EventController,
  url: string,
  options?: NavigateOptions & { skipLoadingState?: boolean },
): NavigationTransaction {
  let committed = false;
  const currentUrl = window.location.href;

  const handle = eventController.startNavigation(url, options);

  /**
   * Commit the navigation - updates store and URL atomically
   */
  function commit(opts: CommitOptions): { scroll?: boolean } {
    committed = true;

    const {
      url,
      segmentIds,
      segments,
      replace,
      scroll,
      storeOnly,
      intercept,
      interceptSourceUrl,
      cacheOnly,
      serverState,
    } = opts;

    const parsedUrl = new URL(url, window.location.origin);

    const historyKey = generateHistoryKey(url, { intercept });

    if (cacheOnly) {
      const currentHandleData = eventController.getHandleState().data;
      store.cacheSegmentsForHistory(historyKey, segments, currentHandleData);
      handle.complete(parsedUrl);
      debugLog("[Browser] Cache-only commit, historyKey:", historyKey);
      return { scroll: false };
    }

    handleNavigationStart();

    store.setSegmentIds(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    store.setHistoryKey(historyKey);

    const currentHandleData = eventController.getHandleState().data;
    store.cacheSegmentsForHistory(historyKey, segments, currentHandleData);

    if (storeOnly) {
      debugLog("[Browser] Store updated (action)");
      handle.complete(parsedUrl);
      return { scroll: false };
    }

    const historyState = buildHistoryState(
      opts.state,
      { intercept, sourceUrl: interceptSourceUrl },
      serverState,
    );

    const oldState = window.history.state;

    pushHistoryWithIdx(historyState, url, replace ?? false);
    ensureHistoryKey();

    if (hasLocationState(oldState) || hasLocationState(historyState)) {
      window.dispatchEvent(new Event("__rsc_locationstate"));
    }

    handle.complete(parsedUrl);

    debugLog(
      "[Browser] Navigation committed, historyKey:",
      historyKey,
      intercept ? "(intercept)" : "",
    );

    return { scroll };
  }

  return {
    handle,
    commit,

    with(
      opts: Omit<CommitOptions, "segmentIds" | "segments">,
    ): BoundTransaction {
      return {
        get currentUrl() {
          return currentUrl;
        },
        startStreaming() {
          return handle.startStreaming();
        },
        commit: (
          segmentIds: string[],
          segments: ResolvedSegment[],
          overrides?: BoundCommitOverrides,
        ) => {
          const finalScroll = overrides?.scroll ?? opts.scroll;
          const finalReplace = overrides?.replace ?? opts.replace;
          const intercept = overrides?.intercept ?? opts.intercept;
          const interceptSourceUrl =
            overrides?.interceptSourceUrl ?? opts.interceptSourceUrl;
          const cacheOnly = overrides?.cacheOnly ?? opts.cacheOnly;
          // state is `unknown` (null is meaningful) so `??` would wrongly drop a
          // null override; serverState always comes from overrides, never opts.
          const state =
            overrides?.state !== undefined ? overrides.state : opts.state;
          const serverState = overrides?.serverState;
          return commit({
            ...opts,
            segmentIds,
            segments,
            scroll: finalScroll,
            replace: finalReplace,
            state,
            intercept,
            interceptSourceUrl,
            cacheOnly,
            serverState,
          });
        },
      };
    },

    [Symbol.dispose]() {
      if (handle.signal.aborted) {
        return;
      }

      if (!committed) {
        handle[Symbol.dispose]();
      }
    },
  };
}
