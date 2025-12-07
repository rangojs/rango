import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  NavigationStore,
  ResolvedSegment,
} from "./types.js";
import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";
import { generateHistoryKey } from "./navigation-store.js";
import {
  handleNavigationStart,
  handleNavigationEnd,
  ensureHistoryKey,
} from "./scroll-restoration.js";

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
  // If any segment is an intercept segment, treat the whole cache as intercept-only
  // because we can't reuse it - interception depends on source page context
  return segments.some(isInterceptSegment);
}

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
  /** Mark this as an intercept route */
  intercept?: boolean;
  /** Source URL where intercept was triggered from */
  interceptSourceUrl?: string;
  /** If true, only update cache (for stale revalidation) */
  cacheOnly?: boolean;
}

/**
 * Bound transaction with pre-configured commit options (without segmentIds/segments)
 */
export interface BoundTransaction {
  readonly currentUrl: string;
  commit(
    segmentIds: string[],
    segments: ResolvedSegment[],
    overrides?: BoundCommitOverrides
  ): void;
}

/**
 * Options for creating a navigation transaction
 */
interface TransactionOptions {
  /** If true, skip setting loading state (for optimistic renders with cache) */
  skipLoadingState?: boolean;
}

/**
 * Navigation transaction for managing state during navigation
 */
interface NavigationTransaction extends Disposable {
  /** Optimistically commit from cache - instant render before revalidation */
  optimisticCommit(options: CommitOptions): void;
  /** Final commit with server data (or reconciliation after optimistic) */
  commit(options: CommitOptions): void;
  with(
    options: Omit<CommitOptions, "segmentIds" | "segments">
  ): BoundTransaction;
}

/**
 * Creates a disposable transaction for navigation state management.
 * Handles loading state transitions and cleanup on completion/abort.
 *
 * Supports optimistic navigation: render from cache immediately,
 * then revalidate in background and reconcile if data changed.
 */
function createNavigationTransaction(
  store: NavigationStore,
  signal: AbortSignal,
  options?: TransactionOptions
): NavigationTransaction {
  let committed = false;
  let optimisticallyCommitted = false;
  const currentUrl = window.location.href;
  // Only set loading state if not doing optimistic render from cache
  if (!options?.skipLoadingState) {
    store.setState({ state: "loading" });
  }
  // handle abort
  // we need to cleanup just before new navigation starts
  signal.onabort = () => {
    store.setState({ state: "idle", isStreaming: false });
  };

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

    // Cache segments (will be overwritten by fresh data on final commit)
    store.cacheSegmentsForHistory(historyKey, segments);

    // Update browser URL
    if (replace) {
      window.history.replaceState(null, "", url);
    } else {
      window.history.pushState(null, "", url);
    }

    // Ensure new history entry has a scroll restoration key
    ensureHistoryKey();

    // Set idle state (content is visible from cache)
    store.setState({
      state: "idle",
      location: parsedUrl,
    });

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
      store.cacheSegmentsForHistory(historyKey, segments);
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

    // Cache segments for this history entry (fresh data overwrites optimistic)
    store.cacheSegmentsForHistory(historyKey, segments);

    // For server actions, skip URL/history updates
    if (storeOnly) {
      console.log("[Browser] Store updated (action)");
      return;
    }

    // Build history state - include intercept info for popstate handling
    const historyState = intercept
      ? { intercept: true, sourceUrl: interceptSourceUrl }
      : null;

    // Update browser URL (skip if reconciliation - already done in optimisticCommit)
    if (!isReconciliation) {
      if (replace) {
        window.history.replaceState(historyState, "", url);
      } else {
        window.history.pushState(historyState, "", url);
      }
      // Ensure new history entry has a scroll restoration key
      ensureHistoryKey();
    }

    // Update store with new location and idle state
    store.setState({
      state: "idle",
      location: parsedUrl,
    });

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
          // This ensures stale revalidation preserves intercept state from opts
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
          commit({
            ...opts,
            segmentIds,
            segments,
            scroll: finalScroll,
            replace: finalReplace,
            intercept,
            interceptSourceUrl,
            cacheOnly,
          });
        },
      };
    },

    [Symbol.dispose]() {
      // If aborted, another navigation took over - don't touch state
      if (signal.aborted) return;

      // If not committed (and not optimistically committed), reset to idle
      if (!committed && !optimisticallyCommitted) {
        store.setState({ state: "idle" });
      }
    },
  };
}

// Export for use by server-action-bridge
export { createNavigationTransaction };

/**
 * Create a navigation bridge for handling client-side navigation
 *
 * The bridge coordinates all navigation operations:
 * - Link click interception
 * - Browser back/forward (popstate)
 * - Programmatic navigation
 *
 * @param config - Bridge configuration
 * @returns NavigationBridge instance
 *
 * @example
 * ```typescript
 * const bridge = createNavigationBridge({
 *   store,
 *   client,
 *   requestController,
 *   onUpdate: (update) => store.emit(update),
 *   renderSegments,
 * });
 *
 * bridge.registerLinkInterception();
 * ```
 */
export function createNavigationBridge(
  config: NavigationBridgeConfig
): NavigationBridge {
  const { store, client, requestController, onUpdate, renderSegments } = config;

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
      // Only abort pending requests when navigating to a different route
      // Same-route navigation (e.g., /todos -> /todos) should not cancel in-flight actions
      const currentPath = new URL(window.location.href).pathname;
      const targetPath = new URL(url, window.location.origin).pathname;
      if (currentPath !== targetPath) {
        requestController.abortAll();
      }

      // Check if we have cached segments for target URL
      const historyKey = generateHistoryKey(url);
      const cached = store.getCachedSegments(historyKey);
      const cachedSegments = cached?.segments;
      // Skip optimistic rendering for intercept caches - interception depends on
      // source page context, so we can't reliably reuse intercept responses
      const hasUsableCache =
        cachedSegments &&
        cachedSegments.length > 0 &&
        !isInterceptOnlyCache(cachedSegments);

      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(
        store,
        disposable.controller.signal,
        { skipLoadingState: hasUsableCache } // Skip loading state if we have usable cache
      );

      // // OPTIMISTIC: If we have usable cache, render immediately
      // if (false && hasUsableCache && cachedSegments) {
      //   console.log("[Browser] Optimistic render from cache for:", historyKey);

      //   // Render cached segments
      //   const root = renderSegments(cachedSegments);
      //   onUpdate({
      //     root,
      //     metadata: {
      //       pathname: new URL(url, window.location.origin).pathname,
      //       segments: cachedSegments,
      //       isPartial: true,
      //       matched: cachedSegments.map((s) => s.id),
      //       diff: [],
      //     },
      //   });

      //   // Commit optimistically (updates URL, store, scrolls)
      //   tx.optimisticCommit({
      //     url,
      //     segmentIds: cachedSegments.map((s) => s.id),
      //     segments: cachedSegments,
      //     replace: options?.replace,
      //     scroll: options?.scroll,
      //   });
      // }

      // REVALIDATE: Fetch fresh data from server
      // If optimistic, this reconciles; if not, this is the first fetch
      try {
        await fetchPartialUpdate(
          url,
          hasUsableCache ? cachedSegments!.map((s) => s.id) : undefined,
          false,
          disposable.controller.signal,
          tx.with({ url, replace: options?.replace, scroll: options?.scroll })
        );
      } catch (error) {
        // Ignore AbortError - navigation was cancelled by a newer navigation
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log("[Browser] Navigation aborted by newer navigation");
          return;
        }
        throw error;
      }
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      requestController.abortAll();
      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(
        store,
        disposable.controller.signal
      );

      // Refetch with empty segments to get everything fresh
      await fetchPartialUpdate(
        window.location.href,
        [],
        false,
        disposable.controller.signal,
        tx.with({ url: window.location.href, replace: true, scroll: false })
      );
    },

    /**
     * Handle browser back/forward navigation
     * Uses cached segments when available for instant restoration
     */
    async handlePopstate(): Promise<void> {
      // Abort any pending navigation to prevent race conditions
      requestController.abortAll();

      const url = window.location.href;

      // Check if this history entry is an intercept
      const historyState = window.history.state;
      const isIntercept = historyState?.intercept === true;
      const interceptSourceUrl = historyState?.sourceUrl;

      // Check if intercept context is changing (same URL, different intercept state)
      // If so, abort in-flight actions - their results would be for wrong context
      // Example: action on /shop/product/1 (non-intercepted) completes after user
      // navigated back to /shop/product/1 (intercepted) - action result is wrong
      const currentInterceptSource = store.getInterceptSourceUrl();
      const newInterceptSource = interceptSourceUrl ?? null;
      if (currentInterceptSource !== newInterceptSource) {
        console.log(
          `[Browser] Intercept context changing (${currentInterceptSource} -> ${newInterceptSource}), aborting in-flight actions`
        );
        requestController.abortAllActions();
      }

      // Compute history key from URL (with intercept suffix if applicable)
      const historyKey = generateHistoryKey(url, { intercept: isIntercept });

      console.log(
        "[Browser] Popstate -",
        isIntercept ? "intercept" : "normal",
        "key:",
        historyKey
      );

      // Update location from browser URL
      store.setState({
        state: "loading",
        location: new URL(url),
      });

      // If this is an intercept, restore the intercept context
      if (isIntercept && interceptSourceUrl) {
        store.setInterceptSourceUrl(interceptSourceUrl);
      } else {
        store.setInterceptSourceUrl(null);
      }

      // Helper to check if streaming is in progress
      const isStreaming = () => store.getState().isStreaming;

      // Check if we can restore from history cache
      const cached = store.getCachedSegments(historyKey);
      const cachedSegments = cached?.segments;
      const isStale = cached?.stale ?? false;

      if (cachedSegments && cachedSegments.length > 0) {
        console.log(
          "[Browser] Restoring from history cache, key:",
          historyKey,
          isStale ? "(stale)" : ""
        );

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
            },
          });
          store.setState({ state: "idle" });

          // Restore scroll position for back/forward navigation
          handleNavigationEnd({ restore: true, isStreaming });

          // SWR: If stale, trigger background revalidation
          if (isStale) {
            console.log("[Browser] Cache is stale, background revalidating...");
            // Background revalidation - don't await, just fire and forget
            // Send all segment IDs to let revalidators decide what to refetch
            // Pass staleRevalidation=true so server knows to force revalidators
            // For intercept routes, pass the source URL so server activates intercept
            // Also preserve intercept state in history when committing
            const segmentIds = cachedSegments.map((s) => s.id);
            using disposable = requestController.createDisposable();
            using tx = createNavigationTransaction(
              store,
              disposable.controller.signal,
              { skipLoadingState: true } // Don't show loading state
            );
            fetchPartialUpdate(
              url,
              segmentIds,
              false,
              disposable.controller.signal,
              tx.with({
                url,
                replace: true,
                scroll: false,
                // Preserve intercept state for cache key generation
                intercept: isIntercept,
                interceptSourceUrl,
                // Cache-only: don't touch store or history, user may have navigated away
                cacheOnly: true,
              }),
              { staleRevalidation: true, interceptSourceUrl }
            ).catch((error) => {
              // Ignore AbortError - navigation was cancelled
              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                console.log("[Browser] Background revalidation aborted");
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
      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(
        store,
        disposable.controller.signal
      );

      try {
        await fetchPartialUpdate(
          url,
          undefined,
          false,
          disposable.controller.signal,
          tx.with({ url, replace: true, scroll: false })
        );
        // Restore scroll position after fetch completes
        handleNavigationEnd({ restore: true, isStreaming });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          console.log("[Browser] Popstate navigation aborted");
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
