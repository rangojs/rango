import type {
  NavigateOptions,
  NavigationStore,
  ResolvedSegment,
  StreamingToken,
} from "./types.js";
import { generateHistoryKey } from "./navigation-store.js";
import {
  handleNavigationStart,
  handleNavigationEnd,
  ensureHistoryKey,
} from "./scroll-restoration.js";
import type { EventController, NavigationHandle } from "./event-controller.js";
import { debugLog } from "./logging.js";
import { buildHistoryState } from "./history-state.js";

// Re-export for consumers that import from navigation-transaction
export { resolveNavigationState } from "./history-state.js";

// Polyfill Symbol.dispose for Safari and older browsers
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
  commit(
    segmentIds: string[],
    segments: ResolvedSegment[],
    overrides?: BoundCommitOverrides,
  ): void;
}

/**
 * Navigation transaction for managing state during navigation
 * Uses the event controller handle for lifecycle management
 */
interface NavigationTransaction extends Disposable {
  commit(options: CommitOptions): void;
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

  // Start navigation in event controller (this sets loading state)
  const handle = eventController.startNavigation(url, options);

  /**
   * Commit the navigation - updates store and URL atomically
   */
  function commit(opts: CommitOptions): void {
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

    // Generate history key from URL (with intercept suffix for separate caching)
    const historyKey = generateHistoryKey(url, { intercept });

    // For cache-only commits (stale revalidation), only update cache and return
    // Don't touch store state or history - user may have navigated elsewhere
    if (cacheOnly) {
      const currentHandleData = eventController.getHandleState().data;
      store.cacheSegmentsForHistory(historyKey, segments, currentHandleData);
      // Complete the navigation handle so currentNavigation is cleared.
      // Without this, the entry lingers and weakens state-machine invariants.
      handle.complete(parsedUrl);
      debugLog("[Browser] Cache-only commit, historyKey:", historyKey);
      return;
    }

    // Save current scroll position before navigating
    handleNavigationStart();

    // Update segment state atomically
    store.setSegmentIds(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    store.setHistoryKey(historyKey);

    // Cache segments with current handleData for this history entry
    const currentHandleData = eventController.getHandleState().data;
    store.cacheSegmentsForHistory(historyKey, segments, currentHandleData);

    // For server actions, skip URL/history updates but still complete navigation
    if (storeOnly) {
      debugLog("[Browser] Store updated (action)");
      // Complete navigation to clear loading state
      handle.complete(parsedUrl);
      return;
    }

    // Build history state - include user state, intercept info, and server-set state
    const historyState = buildHistoryState(
      opts.state,
      { intercept, sourceUrl: interceptSourceUrl },
      serverState,
    );

    // Update browser URL
    if (replace) {
      window.history.replaceState(historyState, "", url);
    } else {
      window.history.pushState(historyState, "", url);
    }
    // Ensure new history entry has a scroll restoration key
    ensureHistoryKey();

    // Notify location state hooks that history.state changed.
    // Needed for same-page navigations where components don't remount and
    // useState initializers don't re-run. Dispatched unconditionally so hooks
    // also clear stale values when navigating away from a state-carrying entry.
    window.dispatchEvent(new Event("__rsc_locationstate"));

    // Complete the navigation in event controller (sets idle state, updates location)
    handle.complete(parsedUrl);

    // Handle scroll after navigation
    handleNavigationEnd({ scroll });

    debugLog(
      "[Browser] Navigation committed, historyKey:",
      historyKey,
      intercept ? "(intercept)" : "",
    );
  }

  return {
    handle,
    commit,

    /**
     * Create a bound transaction with pre-configured URL options
     * segmentIds and segments provided at commit time (after they're resolved)
     */
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
          // Allow overrides to disable scroll (e.g., for intercepts)
          const finalScroll =
            overrides?.scroll !== undefined ? overrides.scroll : opts.scroll;
          // Allow overrides to force replace (e.g., for intercepts)
          const finalReplace =
            overrides?.replace !== undefined ? overrides.replace : opts.replace;
          // Intercept info: overrides take precedence, fallback to opts
          const intercept =
            overrides?.intercept !== undefined
              ? overrides.intercept
              : opts.intercept;
          const interceptSourceUrl =
            overrides?.interceptSourceUrl !== undefined
              ? overrides.interceptSourceUrl
              : opts.interceptSourceUrl;
          // Cache-only mode: overrides take precedence, fallback to opts
          const cacheOnly =
            overrides?.cacheOnly !== undefined
              ? overrides.cacheOnly
              : opts.cacheOnly;
          // User state: overrides take precedence, fallback to opts
          const state =
            overrides?.state !== undefined ? overrides.state : opts.state;
          // Server-set location state: only from overrides (set by partial-update)
          const serverState = overrides?.serverState;
          commit({
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
      // Superseded: another navigation took over.
      if (handle.signal.aborted) {
        return;
      }

      // Failed (not committed): keep the target URL -- the error UI owns it.
      // Just reset the event controller to idle.
      if (!committed) {
        handle[Symbol.dispose]();
      }
    },
  };
}
