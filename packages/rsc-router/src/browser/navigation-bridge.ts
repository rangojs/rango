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
}

/**
 * Options that can override the pre-configured commit settings
 */
interface BoundCommitOverrides {
  /** Override scroll behavior (e.g., disable for intercepts) */
  scroll?: boolean;
}

/**
 * Bound transaction with pre-configured commit options (without segmentIds/segments)
 */
interface BoundTransaction {
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

  // Only set loading state if not doing optimistic render from cache
  if (!options?.skipLoadingState) {
    store.setState({ state: "loading" });
  }

  /**
   * Optimistically commit from cache - renders immediately before revalidation
   * Sets optimisticallyCommitted flag so final commit() knows to reconcile
   */
  function optimisticCommit(opts: CommitOptions): void {
    optimisticallyCommitted = true;

    const { url, segmentIds, segments, replace, scroll } = opts;
    const parsedUrl = new URL(url, window.location.origin);

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

    // Set idle state (content is visible from cache)
    store.setState({
      state: "idle",
      location: parsedUrl,
    });

    // Scroll to top
    if (scroll !== false) {
      window.scrollTo(0, 0);
    }

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
    const { url, segmentIds, segments, storeOnly } = opts;
    // For reconciliation: always replace (URL already pushed), no scroll
    const replace = isReconciliation ? true : opts.replace;
    const scroll = isReconciliation ? false : opts.scroll;

    const parsedUrl = new URL(url, window.location.origin);

    // Update segment state atomically
    store.setSegmentIds(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    // Generate history key from URL
    const historyKey = generateHistoryKey(url);
    store.setHistoryKey(historyKey);

    // Cache segments for this history entry (fresh data overwrites optimistic)
    store.cacheSegmentsForHistory(historyKey, segments);

    // For server actions, skip URL/history updates
    if (storeOnly) {
      console.log("[Browser] Store updated (action)");
      return;
    }

    // Update browser URL (skip if reconciliation - already done in optimisticCommit)
    if (!isReconciliation) {
      if (replace) {
        window.history.replaceState(null, "", url);
      } else {
        window.history.pushState(null, "", url);
      }
    }

    // Update store with new location and idle state
    store.setState({
      state: "idle",
      location: parsedUrl,
    });

    // Scroll to top if requested (skip if reconciliation)
    if (!isReconciliation && scroll !== false) {
      window.scrollTo(0, 0);
    }

    if (isReconciliation) {
      console.log("[Browser] Reconciliation commit, historyKey:", historyKey);
    } else {
      console.log("[Browser] Navigation committed, historyKey:", historyKey);
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
        commit: (
          segmentIds: string[],
          segments: ResolvedSegment[],
          overrides?: BoundCommitOverrides
        ) => {
          // Allow overrides to disable scroll (e.g., for intercepts)
          const finalScroll =
            overrides?.scroll !== undefined ? overrides.scroll : opts.scroll;
          commit({ ...opts, segmentIds, segments, scroll: finalScroll });
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
 * V2: Instead of rendering segments to React tree, we pass segments directly
 * to onUpdate. NavigationProviderV2 updates the segment store and only
 * affected components re-render.
 *
 * @param config - Bridge configuration
 * @returns NavigationBridge instance
 */
export function createNavigationBridge(
  config: NavigationBridgeConfig
): NavigationBridge {
  const { store, client, requestController, onUpdate } = config;

  // Create shared partial updater (V2: no renderSegments needed)
  const fetchPartialUpdate = createPartialUpdater({
    store,
    client,
    onUpdate,
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
      const cachedSegments = store.getCachedSegments(historyKey);
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

      // OPTIMISTIC: If we have usable cache, emit segments immediately
      if (hasUsableCache) {
        console.log("[Browser] Optimistic render from cache for:", historyKey);

        // Emit cached segments (V2: no tree rendering)
        onUpdate({
          root: null,
          metadata: {
            pathname: new URL(url, window.location.origin).pathname,
            segments: cachedSegments,
            isPartial: true,
            matched: cachedSegments.map((s) => s.id),
            diff: [], // No diff for optimistic - segment store handles it
          },
        });

        // Commit optimistically (updates URL, store, scrolls)
        tx.optimisticCommit({
          url,
          segmentIds: cachedSegments.map((s) => s.id),
          segments: cachedSegments,
          replace: options?.replace,
          scroll: options?.scroll,
        });
      }

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
      // Compute history key from URL (deterministic hash)
      const historyKey = generateHistoryKey(url);

      // Update location from browser URL
      store.setState({
        state: "loading",
        location: new URL(url),
      });

      // Check if we can restore from history cache
      const cachedSegments = store.getCachedSegments(historyKey);

      if (cachedSegments && cachedSegments.length > 0) {
        console.log("[Browser] Restoring from history cache, key:", historyKey);

        // Update store to point to this history entry
        store.setHistoryKey(historyKey);
        store.setSegmentIds(cachedSegments.map((s) => s.id));
        store.setCurrentUrl(url);
        store.setPath(new URL(url).pathname);

        // Emit cached segments (V2: no tree rendering)
        onUpdate({
          root: null,
          metadata: {
            pathname: new URL(url).pathname,
            segments: cachedSegments,
            isPartial: true,
            matched: cachedSegments.map((s) => s.id),
            diff: [], // No diff - full replacement from cache
          },
        });
        store.setState({ state: "idle" });
        return;
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
      const cleanupLinks = setupLinkInterception((url) => {
        this.navigate(url);
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
