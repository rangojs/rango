import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  NavigationStore,
  ResolvedSegment,
} from "./types.js";
import {
  isLocationStateEntry,
  resolveLocationStateEntries,
} from "./react/location-state-shared.js";

/**
 * Check if state is from typed LocationStateEntry[] (has __rsc_ls_ keys)
 */
function isTypedLocationState(state: unknown): state is Record<string, unknown> {
  if (state === null || typeof state !== "object") return false;
  return Object.keys(state).some((key) => key.startsWith("__rsc_ls_"));
}

/**
 * Resolve navigation state - handles both LocationStateEntry[] and legacy formats
 */
function resolveNavigationState(state: unknown): unknown {
  // Check if it's an array of LocationStateEntry
  if (Array.isArray(state) && state.length > 0 && isLocationStateEntry(state[0])) {
    return resolveLocationStateEntries(state);
  }
  // Return as-is for legacy formats
  return state;
}

/**
 * Build history state object from user state
 * - Typed state: spread directly into history.state
 * - Legacy state: store in history.state.state
 */
function buildHistoryState(
  userState: unknown,
  routerState?: { intercept?: boolean; sourceUrl?: string }
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
      // Legacy state: store in .state
      result.state = userState;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}
import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";
import { generateHistoryKey } from "./navigation-store.js";
import {
  handleNavigationStart,
  handleNavigationEnd,
  ensureHistoryKey,
} from "./scroll-restoration.js";
import type { EventController, NavigationHandle } from "./event-controller.js";
import { NetworkError, isNetworkError } from "../errors.js";
import { NetworkErrorThrower } from "../network-error-thrower.js";
import { createElement, startTransition } from "react";

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

/**
 * Check if a segment is an intercept segment
 * Intercept segments have namespace starting with "intercept:" or ID containing .@
 */
function isInterceptSegment(s: ResolvedSegment): boolean {
  return (
    s.namespace?.startsWith("intercept:") ||
    (s.type === "parallel" && s.id.includes(".@"))
  );
}

/**
 * Check if cached segments are intercept-only (no main route segments)
 * Intercept responses shouldn't be used for optimistic rendering since
 * whether interception happens depends on the current page context
 */
function isInterceptOnlyCache(segments: ResolvedSegment[]): boolean {
  return segments.some(isInterceptSegment);
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
}

/**
 * Token for tracking an active stream - call end() when stream completes
 */
export interface StreamingToken {
  end(): void;
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
    overrides?: BoundCommitOverrides
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
    options: Omit<CommitOptions, "segmentIds" | "segments">
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
function createNavigationTransaction(
  store: NavigationStore,
  eventController: EventController,
  url: string,
  options?: NavigateOptions & { skipLoadingState?: boolean }
): NavigationTransaction {
  let committed = false;
  let optimisticallyCommitted = false;
  let earlyStatePushed = false;
  const currentUrl = window.location.href;

  // Start navigation in event controller (this sets loading state)
  const handle = eventController.startNavigation(url, options);

  // If state is provided, push it to history immediately so loading UI can access it
  // This enables "optimistic state" - showing product names in skeletons etc.
  if (options?.state !== undefined && !options?.replace) {
    const earlyHistoryState = buildHistoryState(options.state);
    window.history.pushState(earlyHistoryState, "", url);
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

    console.log(
      "[Browser] Optimistic commit from cache, historyKey:",
      historyKey
    );
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
      console.log("[Browser] Cache-only commit, historyKey:", historyKey);
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
      console.log("[Browser] Store updated (action)");
      // Complete navigation to clear loading state
      handle.complete(parsedUrl);
      return;
    }

    // Build history state - include user state and intercept info for popstate handling
    const historyState = buildHistoryState(opts.state, {
      intercept,
      sourceUrl: interceptSourceUrl,
    });

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
    }

    // Complete the navigation in event controller (sets idle state, updates location)
    handle.complete(parsedUrl);

    // Handle scroll after navigation (skip if reconciliation)
    if (!isReconciliation) {
      handleNavigationEnd({ scroll });
    }

    if (isReconciliation) {
      console.log("[Browser] Reconciliation commit, historyKey:", historyKey);
    } else {
      console.log(
        "[Browser] Navigation committed, historyKey:",
        historyKey,
        intercept ? "(intercept)" : ""
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
      opts: Omit<CommitOptions, "segmentIds" | "segments">
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
          overrides?: BoundCommitOverrides
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
          });
        },
      };
    },

    [Symbol.dispose]() {
      // If aborted, another navigation took over - don't touch state
      if (handle.signal.aborted) return;

      // If not committed (and not optimistically committed), the handle's dispose
      // will reset state to idle via the event controller
      if (!committed && !optimisticallyCommitted) {
        handle[Symbol.dispose]();
        // The NavigationHandle's [Symbol.dispose] handles this
      }
    },
  };
}

// Export for use by server-action-bridge
export { createNavigationTransaction };

/**
 * Extended configuration for navigation bridge with event controller
 */
export interface NavigationBridgeConfigWithController extends NavigationBridgeConfig {
  eventController: EventController;
}

/**
 * Create a navigation bridge for handling client-side navigation
 *
 * The bridge coordinates all navigation operations:
 * - Link click interception
 * - Browser back/forward (popstate)
 * - Programmatic navigation
 *
 * Uses the event controller for reactive state management.
 *
 * @param config - Bridge configuration
 * @returns NavigationBridge instance
 */
export function createNavigationBridge(
  config: NavigationBridgeConfigWithController
): NavigationBridge {
  const { store, client, eventController, onUpdate, renderSegments } = config;

  // Create shared partial updater
  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
  });

  return {
    /**
     * Navigate to a URL
     * Uses optimistic rendering from cache when available (SWR pattern)
     */
    async navigate(url: string, options?: NavigateOptions): Promise<void> {
      // Resolve LocationStateEntry[] to flat object if needed
      const resolvedState = options?.state !== undefined
        ? resolveNavigationState(options.state)
        : undefined;

      // Only abort pending requests when navigating to a different route
      // Same-route navigation (e.g., /todos -> /todos) should not cancel in-flight actions
      const currentPath = new URL(window.location.href).pathname;
      const targetPath = new URL(url, window.location.origin).pathname;
      if (currentPath !== targetPath) {
        eventController.abortNavigation();
      }

      // Before navigating away, update the source page's cache with the latest handleData.
      // This ensures the cache has correct handleData even if handles were streaming.
      const sourceHistoryKey = store.getHistoryKey();
      const sourceCached = store.getCachedSegments(sourceHistoryKey);
      if (sourceCached?.segments && sourceCached.segments.length > 0) {
        const currentHandleData = eventController.getHandleState().data;
        store.cacheSegmentsForHistory(
          sourceHistoryKey,
          sourceCached.segments,
          currentHandleData
        );
      }

      // Check if we have cached segments for target URL
      const historyKey = generateHistoryKey(url);
      const cached = store.getCachedSegments(historyKey);

      // For shared segments (same ID on current and target), use current page's version
      // since it may have fresher data after an action revalidation.
      // This avoids unnecessary server round-trips for shared layout loaders.
      let cachedSegments = cached?.segments;
      if (cachedSegments && sourceCached?.segments) {
        const sourceSegmentMap = new Map(
          sourceCached.segments.map((s) => [s.id, s])
        );
        cachedSegments = cachedSegments.map((targetSeg) => {
          const sourceSeg = sourceSegmentMap.get(targetSeg.id);
          // Use source (current page) version for shared segments - it's fresher
          return sourceSeg || targetSeg;
        });
      }

      // Also check if there's an intercept cache entry for this URL
      // If so, this URL CAN be intercepted, and we shouldn't use the non-intercept cache
      // because the navigation might result in an intercept (depending on source URL)
      const interceptHistoryKey = generateHistoryKey(url, { intercept: true });
      const hasInterceptCache = store.hasHistoryCache(interceptHistoryKey);

      // Skip optimistic rendering for:
      // 1. intercept caches - interception depends on source page context
      // 2. routes that CAN be intercepted - we don't know if this navigation will intercept
      const hasUsableCache =
        cachedSegments &&
        cachedSegments.length > 0 &&
        !isInterceptOnlyCache(cachedSegments) &&
        !hasInterceptCache;

      using tx = createNavigationTransaction(store, eventController, url, {
        ...options,
        state: resolvedState,
        skipLoadingState: hasUsableCache,
      });

      // REVALIDATE: Fetch fresh data from server
      try {
        await fetchPartialUpdate(
          url,
          hasUsableCache ? cachedSegments!.map((s) => s.id) : undefined,
          false,
          tx.handle.signal,
          tx.with({ url, replace: options?.replace, scroll: options?.scroll, state: resolvedState }),
          // Pass cached segments (merged with current page's fresh segments for shared IDs)
          // so the segment map is consistent with what we tell the server we have.
          // Server decides what needs revalidation based on route matching and custom functions.
          // No need for staleRevalidation flag - we're sending the freshest segments we have.
          hasUsableCache ? { targetCacheSegments: cachedSegments } : undefined
        );
        tx;
      } catch (error) {
        // Ignore AbortError - navigation was cancelled by a newer navigation
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log("[Browser] Navigation aborted by newer navigation");
          return;
        }

        // Handle network errors by triggering root error boundary
        if (error instanceof NetworkError || isNetworkError(error)) {
          const networkError =
            error instanceof NetworkError
              ? error
              : new NetworkError(
                  "Unable to connect to server. Please check your connection.",
                  { cause: error, url, operation: "navigation" }
                );

          console.error(
            "[Browser] Network error during navigation:",
            networkError
          );

          // Emit update with NetworkErrorThrower to trigger root error boundary
          startTransition(() => {
            onUpdate({
              root: createElement(NetworkErrorThrower, { error: networkError }),
              metadata: {
                pathname: url,
                segments: [],
                isError: true,
              },
            });
          });
          return;
        }

        throw error;
      }
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      eventController.abortNavigation();

      using tx = createNavigationTransaction(
        store,
        eventController,
        window.location.href,
        { replace: true }
      );

      try {
        // Refetch with empty segments to get everything fresh
        await fetchPartialUpdate(
          window.location.href,
          [],
          false,
          tx.handle.signal,
          tx.with({ url: window.location.href, replace: true, scroll: false })
        );
      } catch (error) {
        // Handle network errors by triggering root error boundary
        if (error instanceof NetworkError || isNetworkError(error)) {
          const networkError =
            error instanceof NetworkError
              ? error
              : new NetworkError(
                  "Unable to connect to server. Please check your connection.",
                  {
                    cause: error,
                    url: window.location.href,
                    operation: "revalidation",
                  }
                );

          console.error(
            "[Browser] Network error during refresh:",
            networkError
          );

          startTransition(() => {
            onUpdate({
              root: createElement(NetworkErrorThrower, { error: networkError }),
              metadata: {
                pathname: window.location.href,
                segments: [],
                isError: true,
              },
            });
          });
          return;
        }
        throw error;
      }
    },

    /**
     * Handle browser back/forward navigation
     * Uses cached segments when available for instant restoration
     */
    async handlePopstate(): Promise<void> {
      // Abort any pending navigation to prevent race conditions
      eventController.abortNavigation();

      const url = window.location.href;

      // Check if this history entry is an intercept
      const historyState = window.history.state;
      const isIntercept = historyState?.intercept === true;
      const interceptSourceUrl = historyState?.sourceUrl;

      // Check if intercept context is changing (same URL, different intercept state)
      // If so, abort in-flight actions - their results would be for wrong context
      const currentInterceptSource = store.getInterceptSourceUrl();
      const newInterceptSource = interceptSourceUrl ?? null;
      if (currentInterceptSource !== newInterceptSource) {
        console.log(
          `[Browser] Intercept context changing (${currentInterceptSource} -> ${newInterceptSource}), aborting in-flight actions`
        );
        eventController.abortAllActions();
      }

      // Compute history key from URL (with intercept suffix if applicable)
      const historyKey = generateHistoryKey(url, { intercept: isIntercept });

      console.log(
        "[Browser] Popstate -",
        isIntercept ? "intercept" : "normal",
        "key:",
        historyKey
      );

      // Update location in event controller
      eventController.setLocation(new URL(url));

      // If this is an intercept, restore the intercept context
      if (isIntercept && interceptSourceUrl) {
        store.setInterceptSourceUrl(interceptSourceUrl);
      } else {
        store.setInterceptSourceUrl(null);
      }

      // Helper to check if streaming is in progress
      const isStreaming = () => eventController.getState().isStreaming;

      // Check if we can restore from history cache
      const cached = store.getCachedSegments(historyKey);
      const cachedSegments = cached?.segments;
      const cachedHandleData = cached?.handleData;
      const isStale = cached?.stale ?? false;

      if (cachedSegments && cachedSegments.length > 0) {
        // Update store to point to this history entry
        store.setHistoryKey(historyKey);
        store.setSegmentIds(cachedSegments.map((s) => s.id));
        store.setCurrentUrl(url);
        store.setPath(new URL(url).pathname);

        // Render from cache - force await to skip loading fallbacks
        try {
          const root = renderSegments(cachedSegments, {
            forceAwait: true,
          });
          onUpdate({
            root,
            metadata: {
              pathname: new URL(url).pathname,
              segments: cachedSegments,
              isPartial: true,
              matched: cachedSegments.map((s) => s.id),
              diff: [],
              cachedHandleData,
            },
          });

          // Restore scroll position for back/forward navigation
          handleNavigationEnd({ restore: true, isStreaming });

          // SWR: If stale, trigger background revalidation
          if (isStale) {
            console.log("[Browser] Cache is stale, background revalidating...");
            // Background revalidation - don't await, just fire and forget
            const segmentIds = cachedSegments.map((s) => s.id);

            using tx = createNavigationTransaction(
              store,
              eventController,
              url,
              { skipLoadingState: true, replace: true }
            );

            fetchPartialUpdate(
              url,
              segmentIds,
              false,
              tx.handle.signal,
              tx.with({
                url,
                replace: true,
                scroll: false,
                intercept: isIntercept,
                interceptSourceUrl,
                cacheOnly: true,
              }),
              { staleRevalidation: true, interceptSourceUrl }
            ).catch((error) => {
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                console.log("[Browser] Background revalidation aborted");
                return;
              }
              // For background revalidation, network errors are logged but don't trigger error boundary
              // since the user is already seeing cached content
              if (error instanceof NetworkError || isNetworkError(error)) {
                console.warn(
                  "[Browser] Background revalidation network error (cached content preserved):",
                  error.message
                );
                return;
              }
              console.error("[Browser] Background revalidation failed:", error);
            });
          }
          return;
        } catch (error) {
          console.warn(
            "[Browser] Failed to render from cache, fetching:",
            error
          );
          // Fall through to fetch
        }
      } else {
        console.log("[Browser] History cache miss for key:", historyKey);
      }

      // Fetch if not cached
      using tx = createNavigationTransaction(store, eventController, url, {
        replace: true,
      });

      try {
        await fetchPartialUpdate(
          url,
          undefined,
          false,
          tx.handle.signal,
          tx.with({ url, replace: true, scroll: false })
        );
        // Restore scroll position after fetch completes
        handleNavigationEnd({ restore: true, isStreaming });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log("[Browser] Popstate navigation aborted");
          return;
        }

        // Handle network errors by triggering root error boundary
        if (error instanceof NetworkError || isNetworkError(error)) {
          const networkError =
            error instanceof NetworkError
              ? error
              : new NetworkError(
                  "Unable to connect to server. Please check your connection.",
                  { cause: error, url, operation: "navigation" }
                );

          console.error(
            "[Browser] Network error during popstate navigation:",
            networkError
          );

          startTransition(() => {
            onUpdate({
              root: createElement(NetworkErrorThrower, { error: networkError }),
              metadata: {
                pathname: url,
                segments: [],
                isError: true,
              },
            });
          });
          return;
        }

        throw error;
      }
    },

    /**
     * Register link interception
     * @returns Cleanup function
     */
    registerLinkInterception(): () => void {
      const cleanupLinks = setupLinkInterception((url, options) => {
        this.navigate(url, options);
      });

      const handlePopstate = () => {
        this.handlePopstate();
      };

      // Register cross-tab refresh callback with the store
      store.setCrossTabRefreshCallback(() => {
        this.refresh();
      });

      window.addEventListener("popstate", handlePopstate);
      console.log("[Browser] Navigation bridge ready");

      return () => {
        cleanupLinks();
        window.removeEventListener("popstate", handlePopstate);
      };
    },
  };
}

export { createNavigationBridge as default };
