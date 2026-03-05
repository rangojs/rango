import type {
  NavigateOptions,
  NavigationStore,
  ResolvedSegment,
  StreamingToken,
} from "./types.js";
import {
  isLocationStateEntry,
  resolveLocationStateEntries,
} from "./react/location-state-shared.js";
import { generateHistoryKey } from "./navigation-store.js";
import {
  handleNavigationStart,
  handleNavigationEnd,
  ensureHistoryKey,
} from "./scroll-restoration.js";
import type { EventController, NavigationHandle } from "./event-controller.js";
import { debugLog } from "./logging.js";

/**
 * Check if state is from typed LocationStateEntry[] (has __rsc_ls_ keys)
 */
function isTypedLocationState(
  state: unknown,
): state is Record<string, unknown> {
  if (state === null || typeof state !== "object") return false;
  return Object.keys(state).some((key) => key.startsWith("__rsc_ls_"));
}

/**
 * Resolve navigation state - handles both LocationStateEntry[] and plain formats
 */
export function resolveNavigationState(state: unknown): unknown {
  // Check if it's an array of LocationStateEntry
  if (
    Array.isArray(state) &&
    state.length > 0 &&
    isLocationStateEntry(state[0])
  ) {
    return resolveLocationStateEntries(state);
  }
  // Return as-is for plain state formats
  return state;
}

/**
 * Build history state object from user state
 * - Typed state: spread directly into history.state
 * - Plain state: store in history.state.state
 */
function buildHistoryState(
  userState: unknown,
  routerState?: { intercept?: boolean; sourceUrl?: string },
  serverState?: Record<string, unknown>,
): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  // Add router internal state
  if (routerState?.intercept) {
    result.intercept = true;
    if (routerState.sourceUrl) {
      result.sourceUrl = routerState.sourceUrl;
    }
  }

  // Add user state
  if (userState !== undefined) {
    if (isTypedLocationState(userState)) {
      // Typed state: spread directly
      Object.assign(result, userState);
    } else {
      // Plain state: store in .state
      result.state = userState;
    }
  }

  // Merge server-set location state (from ctx.setLocationState on non-redirect responses)
  if (serverState) {
    Object.assign(result, serverState);
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

// Monotonic counter for tagging early-pushed history entries.
// Used by disposal to verify ownership without URL comparison,
// which breaks when two navigations target the same URL.
let navStamp = 0;

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
  /** Optimistically commit from cache - instant render before revalidation */
  optimisticCommit(options: CommitOptions): void;
  /** Final commit with server data (or reconciliation after optimistic) */
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
 *
 * Supports optimistic navigation: render from cache immediately,
 * then revalidate in background and reconcile if data changed.
 */
export function createNavigationTransaction(
  store: NavigationStore,
  eventController: EventController,
  url: string,
  options?: NavigateOptions & { skipLoadingState?: boolean },
): NavigationTransaction {
  let committed = false;
  let optimisticallyCommitted = false;
  let earlyStatePushed = false;
  let earlyStateStamp: number | null = null;
  const currentUrl = window.location.href;
  const currentHistoryState = window.history.state;

  // Start navigation in event controller (this sets loading state)
  const handle = eventController.startNavigation(url, options);

  // If state is provided, push it to history immediately so loading UI can access it
  // This enables "optimistic state" - showing product names in skeletons etc.
  if (options?.state !== undefined && !options?.replace) {
    earlyStateStamp = ++navStamp;
    const earlyHistoryState = buildHistoryState(options.state);
    if (earlyHistoryState) {
      (earlyHistoryState as any).__navStamp = earlyStateStamp;
    }
    window.history.pushState(
      earlyHistoryState ?? { __navStamp: earlyStateStamp },
      "",
      url,
    );
    earlyStatePushed = true;
  }

  /**
   * Optimistically commit from cache - renders immediately before revalidation
   * Sets optimisticallyCommitted flag so final commit() knows to reconcile
   */
  function optimisticCommit(opts: CommitOptions): void {
    optimisticallyCommitted = true;

    const { url, segmentIds, segments, replace, scroll } = opts;
    const parsedUrl = new URL(url, window.location.origin);

    // Save current scroll position before navigating
    handleNavigationStart();

    // Update segment state
    store.setSegmentIds(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    // Generate history key from URL
    const historyKey = generateHistoryKey(url);
    store.setHistoryKey(historyKey);

    // Cache segments with current handleData (will be overwritten by fresh data on final commit)
    const currentHandleData = eventController.getHandleState().data;
    store.cacheSegmentsForHistory(historyKey, segments, currentHandleData);

    // Build history state with user state if provided
    const historyState = buildHistoryState(opts.state);

    // Update browser URL
    // Use replaceState if we already pushed early (for optimistic state access)
    if (replace || earlyStatePushed) {
      window.history.replaceState(historyState, "", url);
    } else {
      window.history.pushState(historyState, "", url);
    }

    // Ensure new history entry has a scroll restoration key
    ensureHistoryKey();

    // Complete the navigation in event controller (sets idle state)
    handle.complete(parsedUrl);

    // Handle scroll after navigation
    handleNavigationEnd({ scroll });

    debugLog("[Browser] Optimistic commit from cache, historyKey:", historyKey);
  }

  /**
   * Commit the navigation - updates store and URL atomically
   * If optimisticCommit was called, this becomes a reconciliation
   */
  function commit(opts: CommitOptions): void {
    committed = true;

    // If optimistic commit already done, adjust options for reconciliation
    const isReconciliation = optimisticallyCommitted;
    const {
      url,
      segmentIds,
      segments,
      storeOnly,
      intercept,
      interceptSourceUrl,
      cacheOnly,
      serverState,
    } = opts;
    // For reconciliation: always replace (URL already pushed), no scroll
    const replace = isReconciliation ? true : opts.replace;
    const scroll = isReconciliation ? false : opts.scroll;

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

    // Save current scroll position before navigating (only for non-reconciliation)
    if (!isReconciliation) {
      handleNavigationStart();
    }

    // Update segment state atomically
    store.setSegmentIds(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    store.setHistoryKey(historyKey);

    // Cache segments with current handleData for this history entry (fresh data overwrites optimistic)
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

    // Update browser URL (skip if reconciliation - already done in optimisticCommit)
    if (!isReconciliation) {
      // Use replaceState if we already pushed early (for optimistic state access) or replace requested
      if (replace || earlyStatePushed) {
        window.history.replaceState(historyState, "", url);
      } else {
        window.history.pushState(historyState, "", url);
      }
      // Ensure new history entry has a scroll restoration key
      ensureHistoryKey();

      // Notify location state hooks when history state includes user state.
      // Needed for same-page redirects where components don't remount and
      // useState initializers don't re-run, even though history.state was updated.
      if (
        historyState &&
        (Object.keys(historyState).some((k) => k.startsWith("__rsc_ls_")) ||
          "state" in historyState)
      ) {
        window.dispatchEvent(new Event("__rsc_locationstate"));
      }
    }

    // Complete the navigation in event controller (sets idle state, updates location)
    handle.complete(parsedUrl);

    // Handle scroll after navigation (skip if reconciliation)
    if (!isReconciliation) {
      handleNavigationEnd({ scroll });
    }

    if (isReconciliation) {
      debugLog("[Browser] Reconciliation commit, historyKey:", historyKey);
    } else {
      debugLog(
        "[Browser] Navigation committed, historyKey:",
        historyKey,
        intercept ? "(intercept)" : "",
      );
    }
  }

  return {
    handle,
    optimisticCommit,
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
      // Superseded: another navigation took over. Roll back our early push
      // so the new navigation starts from a clean history position.
      // Guard: only rollback if our early-pushed state is still the current
      // history entry. Compare by stamp (monotonic counter embedded in state)
      // so that a newer navigation targeting the same URL is not clobbered.
      if (handle.signal.aborted) {
        if (
          earlyStatePushed &&
          !committed &&
          !optimisticallyCommitted &&
          earlyStateStamp !== null &&
          window.history.state?.__navStamp === earlyStateStamp
        ) {
          window.history.replaceState(currentHistoryState, "", currentUrl);
        }
        return;
      }

      // Failed (not committed): keep the target URL -- the error UI owns it.
      // Just reset the event controller to idle.
      if (!committed && !optimisticallyCommitted) {
        handle[Symbol.dispose]();
      }
    },
  };
}
