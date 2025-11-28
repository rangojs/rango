import type {
  NavigationBridge,
  NavigationBridgeConfig,
  NavigateOptions,
  NavigationLocation,
  NavigationStore,
} from "./types.js";
import { setupLinkInterception } from "./link-interceptor.js";
import { createPartialUpdater } from "./partial-update.js";

/**
 * Creates a disposable transaction for navigation state management.
 * Handles state transitions and automatic rollback on error.
 */
function createNavigationTransaction(
  store: NavigationStore,
  signal: AbortSignal,
  originalLocation: NavigationLocation
) {
  let committed = false;

  store.setState({ state: "loading" });

  return {
    commit() {
      committed = true;
    },
    [Symbol.dispose]() {
      if (signal.aborted) return;

      if (!committed) {
        window.history.back();
        store.setState({
          state: "idle",
          location: originalLocation,
        });
      } else {
        store.setState({ state: "idle" });
      }
    },
  };
}

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
      using tx = createNavigationTransaction(
        store,
        disposable.controller.signal,
        store.getState().location
      );

      const parsedUrl = new URL(url, window.location.origin);

      // Update location optimistically
      store.setState({
        location: parsedUrl,
      });

      // Update browser URL optimistically
      if (options?.replace) {
        window.history.replaceState(window.history.state, "", url);
      } else {
        window.history.pushState(window.history.state, "", url);
      }

      await fetchPartialUpdate(url, undefined, false, disposable.controller.signal);

      // Scroll to top if requested
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }

      tx.commit();
      console.log("[Browser] RSC stream complete");
    },

    /**
     * Refresh current route
     */
    async refresh(): Promise<void> {
      requestController.abortAll();
      using disposable = requestController.createDisposable();
      using tx = createNavigationTransaction(
        store,
        disposable.controller.signal,
        store.getState().location
      );

      // Refetch with empty segments to get everything fresh
      await fetchPartialUpdate(window.location.href, [], false, disposable.controller.signal);

      tx.commit();
    },

    /**
     * Handle browser back/forward navigation
     */
    handlePopstate(): void {
      const url = window.location.href;

      // Update location from browser URL
      store.setState({
        state: "loading",
        location: new URL(url),
      });

      fetchPartialUpdate(url).finally(() => {
        store.setState({ state: "idle" });
      });
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
