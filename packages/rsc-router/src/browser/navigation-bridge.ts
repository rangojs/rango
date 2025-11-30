import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  NavigationStore,
} from "./types.js";
import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}

/**
 * History state stored for back/forward navigation caching
 */
interface NavigationHistoryState {
  __rsc_router_segmentIds: string[];
}

/**
 * Options for committing a navigation transaction
 */
interface CommitOptions {
  url: string;
  segmentIds: string[];
  replace?: boolean;
  scroll?: boolean;
  /** If true, only update store without changing URL/history (for server actions) */
  storeOnly?: boolean;
}

/**
 * Bound transaction with pre-configured commit options (without segmentIds)
 */
interface BoundTransaction {
  commit(segmentIds: string[]): void;
}

/**
 * Navigation transaction for managing state during navigation
 */
interface NavigationTransaction extends Disposable {
  commit(options: CommitOptions): void;
  with(options: Omit<CommitOptions, "segmentIds">): BoundTransaction;
}

/**
 * Creates a disposable transaction for navigation state management.
 * Handles loading state transitions and cleanup on completion/abort.
 *
 * With non-optimistic navigation, we don't need URL rollback since
 * URL is only updated after successful fetch via commit().
 */
function createNavigationTransaction(store: NavigationStore, signal: AbortSignal): NavigationTransaction {
  let committed = false;

  store.setState({ state: "loading" });

  /**
   * Commit the navigation - updates store and URL atomically
   */
  function commit(options: CommitOptions): void {
    committed = true;

    const { url, segmentIds, replace, scroll, storeOnly } = options;
    const parsedUrl = new URL(url, window.location.origin);

    // Update segment state atomically
    store.setSegmentIds(segmentIds);
    store.pruneSegments(segmentIds);
    store.setCurrentUrl(url);
    store.setPath(parsedUrl.pathname);

    // For server actions, skip URL/history updates
    if (storeOnly) {
      console.log("[Browser] Store updated (action), segments:", segmentIds);
      return;
    }

    // Store segment IDs in history state for back/forward caching
    const historyState: NavigationHistoryState = { __rsc_router_segmentIds: segmentIds };

    // Update browser URL
    if (replace) {
      window.history.replaceState(historyState, "", url);
    } else {
      window.history.pushState(historyState, "", url);
    }

    // Update store with new location and idle state
    store.setState({
      state: "idle",
      location: parsedUrl,
    });

    // Scroll to top if requested
    if (scroll !== false) {
      window.scrollTo(0, 0);
    }

    console.log("[Browser] Navigation committed, cached segments:", segmentIds);
  }

  return {
    commit,

    /**
     * Create a bound transaction with pre-configured URL options
     * segmentIds provided at commit time (after they're resolved)
     */
    with(options: Omit<CommitOptions, "segmentIds">): BoundTransaction {
      return {
        commit: (segmentIds: string[]) => commit({ ...options, segmentIds }),
      };
    },

    [Symbol.dispose]() {
      // If aborted, another navigation took over - don't touch state
      if (signal.aborted) return;

      // If not committed, reset to idle (error case)
      if (!committed) {
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
     */
    async navigate(url: string, options?: NavigateOptions): Promise<void> {
      requestController.abortAll();
      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(store, disposable.controller.signal);

      try {
        await fetchPartialUpdate(
          url,
          undefined,
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
      using tx = createNavigationTransaction(store, disposable.controller.signal);

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
      const historyState = window.history.state as NavigationHistoryState | null;
      const cachedSegmentIds = historyState?.__rsc_router_segmentIds;

      // Update location from browser URL
      store.setState({
        state: "loading",
        location: new URL(url),
      });

      // Check if we can restore from cache
      if (cachedSegmentIds && cachedSegmentIds.length > 0) {
        const segmentCache = store.getSegmentState().storedSegments;
        const allCached = cachedSegmentIds.every((id) => segmentCache.has(id));

        if (allCached) {
          console.log("[Browser] Restoring from cache:", cachedSegmentIds);

          // Collect cached segments
          const segments = cachedSegmentIds
            .map((id) => segmentCache.get(id))
            .filter((s): s is NonNullable<typeof s> => s !== undefined);

          // Update segment state
          store.setSegmentIds(cachedSegmentIds);
          store.setCurrentUrl(url);
          store.setPath(new URL(url).pathname);

          // Render from cache
          try {
            const root = await renderSegments(segments);
            onUpdate({
              root,
              metadata: {
                pathname: new URL(url).pathname,
                segments,
                isPartial: true,
                matched: cachedSegmentIds,
                diff: [],
              },
            });
            store.setState({ state: "idle" });
            return;
          } catch (error) {
            console.warn("[Browser] Failed to render from cache, fetching:", error);
            // Fall through to fetch
          }
        } else {
          console.log("[Browser] Cache miss, fetching. Missing segments:",
            cachedSegmentIds.filter((id) => !segmentCache.has(id)));
        }
      }

      // Fetch if not cached
      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(store, disposable.controller.signal);

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
