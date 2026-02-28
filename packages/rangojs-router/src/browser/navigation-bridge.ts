import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  NavigateOptionsInternal,
  NavigationStore,
  ResolvedSegment,
} from "./types.js";
import * as React from "react";
import { startTransition } from "react";
import {
  isLocationStateEntry,
  resolveLocationStateEntries,
} from "./react/location-state-shared.js";

// addTransitionType is only available in React experimental
const addTransitionType: ((type: string) => void) | undefined =
  "addTransitionType" in React ? (React as any).addTransitionType : undefined;

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
 * Resolve navigation state - handles both LocationStateEntry[] and legacy formats
 */
function resolveNavigationState(state: unknown): unknown {
  // Check if it's an array of LocationStateEntry
  if (
    Array.isArray(state) &&
    state.length > 0 &&
    isLocationStateEntry(state[0])
  ) {
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
      // Legacy state: store in .state
      result.state = userState;
    }
  }

  // Merge server-set location state (from ctx.setLocationState on non-redirect responses)
  if (serverState) {
    Object.assign(result, serverState);
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
import { isInterceptOnlyCache } from "./intercept-utils.js";
import {
  toNetworkError,
  emitNetworkError,
  isBackgroundSuppressible,
} from "./network-error-handler.js";
import { debugLog } from "./logging.js";
import { ServerRedirect } from "../errors.js";

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
function createNavigationTransaction(
  store: NavigationStore,
  eventController: EventController,
  url: string,
  options?: NavigateOptions & { skipLoadingState?: boolean },
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

      // Notify location state hooks when history state includes typed entries.
      // Needed for same-page redirects where components don't remount and
      // useState initializers don't re-run, even though history.state was updated.
      if (
        historyState &&
        Object.keys(historyState).some((k) => k.startsWith("__rsc_ls_"))
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
  /** RSC version from initial payload metadata */
  version?: string;
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
  config: NavigationBridgeConfigWithController,
): NavigationBridge {
  const { store, client, eventController, onUpdate, renderSegments, version } =
    config;

  // Create shared partial updater
  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
    renderSegments,
    version,
  });

  return {
    /**
     * Navigate to a URL
     * Uses optimistic rendering from cache when available (SWR pattern)
     */
    async navigate(
      url: string,
      options?: NavigateOptionsInternal,
    ): Promise<void> {
      // Resolve LocationStateEntry[] to flat object if needed
      const resolvedState =
        options?.state !== undefined
          ? resolveNavigationState(options.state)
          : undefined;

      // Only abort pending requests when navigating to a different route
      // Same-route navigation (e.g., /todos -> /todos) should not cancel in-flight actions
      const currentPath = new URL(window.location.href).pathname;
      const targetPath = new URL(url, window.location.origin).pathname;
      if (currentPath !== targetPath) {
        eventController.abortNavigation();
      }

      // Check if we're "leaving intercept" - navigating from intercept to same URL without intercept
      // This happens when clicking "View Full Details" in an intercept modal
      const currentHistoryState = window.history.state;
      const isCurrentlyIntercept = currentHistoryState?.intercept === true;
      const isSamePathNavigation = currentPath === targetPath;
      const isLeavingIntercept = isCurrentlyIntercept && isSamePathNavigation;

      if (isLeavingIntercept) {
        debugLog(
          "[Browser] Leaving intercept - same URL navigation from intercept",
        );
        // Clear intercept source URL to ensure server doesn't treat this as intercept
        store.setInterceptSourceUrl(null);
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
          currentHandleData,
        );
      }

      // Check if we have cached segments for target URL
      const historyKey = generateHistoryKey(url);
      const cached = store.getCachedSegments(historyKey);

      // For shared segments (same ID on current and target), use current page's version
      // since it may have fresher data after an action revalidation.
      // This avoids unnecessary server round-trips for shared layout loaders.
      let cachedSegments = cached?.segments;
      const cachedHandleData = cached?.handleData;
      if (cachedSegments && sourceCached?.segments) {
        const sourceSegmentMap = new Map(
          sourceCached.segments.map((s) => [s.id, s]),
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
      // 3. when leaving intercept - we need fresh non-intercept segments from server
      // 4. redirect-with-state - force re-render so hooks read fresh state
      const hasUsableCache =
        cachedSegments &&
        cachedSegments.length > 0 &&
        !isInterceptOnlyCache(cachedSegments) &&
        !hasInterceptCache &&
        !isLeavingIntercept &&
        !options?._skipCache;

      using tx = createNavigationTransaction(store, eventController, url, {
        ...options,
        state: resolvedState,
        skipLoadingState: hasUsableCache,
      });

      // REVALIDATE: Fetch fresh data from server
      try {
        await fetchPartialUpdate(
          url,
          hasUsableCache
            ? cachedSegments!
                .filter((s) => s.type !== "loader")
                .map((s) => s.id)
            : undefined,
          false,
          tx.handle.signal,
          tx.with({
            url,
            replace: options?.replace,
            scroll: options?.scroll,
            state: resolvedState,
          }),
          // Pass cached segments (merged with current page's fresh segments for shared IDs)
          // so the segment map is consistent with what we tell the server we have.
          // Server decides what needs revalidation based on route matching and custom functions.
          // No need for staleRevalidation flag - we're sending the freshest segments we have.
          // Also pass cached handle data for restoring breadcrumbs when server returns empty diff.
          // When leaving intercept, pass the flag so fetchPartialUpdate knows to filter segments.
          hasUsableCache
            ? {
                targetCacheSegments: cachedSegments,
                targetCacheHandleData: cachedHandleData,
              }
            : isLeavingIntercept
              ? { leavingIntercept: true }
              : undefined,
        );
      } catch (error) {
        // Server-side redirect with location state: the current transaction's
        // `using` cleanup resets loading state. Re-navigate to the redirect
        // target carrying the server-set state into history.pushState.
        if (error instanceof ServerRedirect) {
          return this.navigate(error.url, {
            state: error.state,
            replace: options?.replace,
            _skipCache: true,
          } as NavigateOptionsInternal);
        }

        if (error instanceof DOMException && error.name === "AbortError") {
          debugLog("[Browser] Navigation aborted by newer navigation");
          return;
        }

        const networkError = toNetworkError(error, {
          url,
          operation: "navigation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during navigation:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, url);
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
        { replace: true },
      );

      try {
        // Refetch with empty segments to get everything fresh
        await fetchPartialUpdate(
          window.location.href,
          [],
          false,
          tx.handle.signal,
          tx.with({ url: window.location.href, replace: true, scroll: false }),
        );
      } catch (error) {
        const networkError = toNetworkError(error, {
          url: window.location.href,
          operation: "revalidation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during refresh:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, window.location.href);
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
        debugLog(
          `[Browser] Intercept context changing (${currentInterceptSource} -> ${newInterceptSource}), aborting in-flight actions`,
        );
        eventController.abortAllActions();
      }

      // Compute history key from URL (with intercept suffix if applicable)
      const historyKey = generateHistoryKey(url, { intercept: isIntercept });

      debugLog(
        "[Browser] Popstate -",
        isIntercept ? "intercept" : "normal",
        "key:",
        historyKey,
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
          const root = await renderSegments(cachedSegments, {
            forceAwait: true,
          });
          // Merge params from cached segments for useParams restoration.
          // Set params on event controller before onUpdate so both location
          // and params are current when the debounced notify() fires.
          const cachedParams: Record<string, string> = {};
          for (const s of cachedSegments) {
            if (s.params) Object.assign(cachedParams, s.params);
          }
          eventController.setParams(cachedParams);

          const popstateUpdate = {
            root,
            metadata: {
              pathname: new URL(url).pathname,
              segments: cachedSegments,
              isPartial: true,
              matched: cachedSegments.map((s) => s.id),
              diff: [],
              cachedHandleData,
              params: cachedParams,
            },
          };
          const hasTransition = cachedSegments.some((s) => s.transition);
          if (hasTransition) {
            startTransition(() => {
              if (addTransitionType) {
                addTransitionType("navigation-back");
              }
              onUpdate(popstateUpdate);
            });
          } else {
            onUpdate(popstateUpdate);
          }

          // Restore scroll position for back/forward navigation
          handleNavigationEnd({ restore: true, isStreaming });

          // SWR: If stale, trigger background revalidation
          if (isStale) {
            debugLog("[Browser] Cache is stale, background revalidating...");
            // Background revalidation - don't await, just fire and forget
            const segmentIds = cachedSegments
              .filter((s) => s.type !== "loader")
              .map((s) => s.id);

            const tx = createNavigationTransaction(
              store,
              eventController,
              url,
              { skipLoadingState: true, replace: true },
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
              { staleRevalidation: true, interceptSourceUrl },
            )
              .catch((error) => {
                if (isBackgroundSuppressible(error)) return;
                console.error(
                  "[Browser] Background revalidation failed:",
                  error,
                );
              })
              .finally(() => {
                tx[Symbol.dispose]();
              });
          }
          return;
        } catch (error) {
          console.warn(
            "[Browser] Failed to render from cache, fetching:",
            error,
          );
          // Fall through to fetch
        }
      } else {
        debugLog("[Browser] History cache miss for key:", historyKey);
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
          tx.with({ url, replace: true, scroll: false }),
        );
        // Restore scroll position after fetch completes
        handleNavigationEnd({ restore: true, isStreaming });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          debugLog("[Browser] Popstate navigation aborted");
          return;
        }

        const networkError = toNetworkError(error, {
          url,
          operation: "navigation",
        });
        if (networkError) {
          console.error(
            "[Browser] Network error during popstate:",
            networkError,
          );
          emitNetworkError(onUpdate, networkError, url);
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

      // When the browser restores a page from bfcache (back-forward cache),
      // any in-flight navigation state is stale. This happens when:
      // 1. A navigation triggers X-RSC-Reload (e.g., response route hit via SPA)
      // 2. window.location.href does a hard navigation
      // 3. The user presses back and the browser restores from bfcache
      // At that point, currentNavigation is still set from step 1, so
      // getState() returns "loading" and the progress bar shows.
      // Abort the stale navigation to reset state to idle.
      const handlePageShow = (event: PageTransitionEvent) => {
        if (event.persisted) {
          debugLog(
            "[Browser] Page restored from bfcache, resetting navigation state",
          );
          eventController.abortNavigation();
        }
      };

      // Register cross-tab refresh callback with the store
      store.setCrossTabRefreshCallback(() => {
        this.refresh();
      });

      window.addEventListener("popstate", handlePopstate);
      window.addEventListener("pageshow", handlePageShow);
      debugLog("[Browser] Navigation bridge ready");

      return () => {
        cleanupLinks();
        window.removeEventListener("popstate", handlePopstate);
        window.removeEventListener("pageshow", handlePageShow);
      };
    },
  };
}

export { createNavigationBridge as default };
