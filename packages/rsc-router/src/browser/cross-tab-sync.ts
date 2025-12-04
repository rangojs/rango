/**
 * Cross-Tab Sync Utility
 *
 * A standalone utility that uses the navigation store's event emitter
 * to synchronize cache invalidation across browser tabs.
 *
 * This is a reference implementation showing how to use the store's
 * event-driven API for cross-tab communication.
 */

import type { NavigationStore } from "./types.js";

/**
 * Options for cross-tab sync
 */
export interface CrossTabSyncOptions {
  /**
   * BroadcastChannel name (default: "rsc-router-cache-invalidation")
   */
  channelName?: string;

  /**
   * Auto-refresh when cache is invalidated by another tab (default: true)
   */
  autoRefresh?: boolean;

  /**
   * Custom invalidation logic.
   * Override to change when cache invalidation applies.
   *
   * @param mutatedPath - The path where mutation occurred
   * @param currentPath - The current tab's path
   * @param actionId - The action ID that triggered the invalidation
   *
   * Default: related paths (exact match or parent/child relationship)
   */
  shouldInvalidate?: (
    mutatedPath: string,
    currentPath: string,
    actionId?: string
  ) => boolean;
}

/**
 * Default path matching: related paths (exact match or parent/child relationship)
 */
export function defaultShouldInvalidate(
  mutatedPath: string,
  currentPath: string,
  _actionId?: string
): boolean {
  return (
    mutatedPath === currentPath ||
    currentPath.startsWith(mutatedPath + "/") ||
    mutatedPath.startsWith(currentPath + "/")
  );
}

/**
 * Cross-tab message format
 */
interface CrossTabMessage {
  type: "invalidate";
  path: string;
  actionId?: string;
}

/**
 * Set up cross-tab cache synchronization.
 *
 * Listens for action:idle events and broadcasts cache invalidation
 * to other tabs. Also listens for invalidation messages from other
 * tabs and clears cache accordingly.
 *
 * @param store - The navigation store instance
 * @param options - Configuration options
 * @returns Cleanup function to stop synchronization
 *
 * @example
 * ```typescript
 * const store = createNavigationStore();
 * const cleanup = setupCrossTabSync(store);
 *
 * // Later, when unmounting:
 * cleanup();
 * ```
 *
 * @example
 * ```typescript
 * // Custom invalidation logic
 * setupCrossTabSync(store, {
 *   shouldInvalidate: (mutatedPath, currentPath) => {
 *     // Only invalidate exact matches
 *     return mutatedPath === currentPath;
 *   },
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Disable auto-refresh (just clear cache)
 * setupCrossTabSync(store, {
 *   autoRefresh: false,
 * });
 * ```
 */
export function setupCrossTabSync(
  store: NavigationStore,
  options?: CrossTabSyncOptions
): () => void {
  const channelName = options?.channelName ?? "rsc-router-cache-invalidation";
  const autoRefresh = options?.autoRefresh !== false;
  const shouldInvalidate = options?.shouldInvalidate ?? defaultShouldInvalidate;

  // BroadcastChannel not available in SSR or older browsers
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => {};
  }

  const channel = new BroadcastChannel(channelName);

  // When an action completes, broadcast invalidation to other tabs
  const unsubscribeActionIdle = store.on("action:idle", (event) => {
    const message: CrossTabMessage = {
      type: "invalidate",
      path: store.getState().location.pathname,
      actionId: event.actionId,
    };
    channel.postMessage(message);
    console.log("[CrossTabSync] Broadcast sent for path:", message.path);
  });

  // Listen for invalidation messages from other tabs
  const handleMessage = (event: MessageEvent<CrossTabMessage>) => {
    if (event.data?.type !== "invalidate") return;

    const mutatedPath = event.data.path;
    const actionId = event.data.actionId;
    const currentPath = store.getState().location.pathname;

    // Use custom or default invalidation logic
    if (!shouldInvalidate(mutatedPath, currentPath, actionId)) {
      return;
    }

    console.log(
      "[CrossTabSync] Cache invalidated by another tab",
      actionId ? `(action: ${actionId})` : ""
    );
    store.clearHistoryCache();

    // Trigger refresh if enabled
    if (autoRefresh) {
      window.dispatchEvent(
        new CustomEvent("rsc-router:cross-tab-refresh", {
          detail: { path: mutatedPath },
        })
      );
    }
  };

  channel.addEventListener("message", handleMessage);

  // Cleanup function
  return () => {
    unsubscribeActionIdle();
    channel.removeEventListener("message", handleMessage);
    channel.close();
  };
}

/**
 * Create a cross-tab event channel for custom events.
 *
 * Allows broadcasting and receiving custom events between tabs.
 * Useful for things like logout synchronization, real-time updates, etc.
 *
 * @param channelName - The BroadcastChannel name
 * @returns Object with send, subscribe, and cleanup methods
 *
 * @example
 * ```typescript
 * const channel = createCrossTabChannel("my-app-events");
 *
 * // Subscribe to events
 * channel.subscribe((event) => {
 *   if (event.name === "user-logout") {
 *     // Handle logout from another tab
 *   }
 * });
 *
 * // Send an event to other tabs
 * channel.send("user-logout", { userId: "123" });
 *
 * // Cleanup
 * channel.close();
 * ```
 */
export function createCrossTabChannel(channelName: string): {
  send: (name: string, payload: unknown) => void;
  subscribe: (
    callback: (event: { name: string; payload: unknown }) => void
  ) => () => void;
  close: () => void;
} {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return {
      send: () => {},
      subscribe: () => () => {},
      close: () => {},
    };
  }

  const channel = new BroadcastChannel(channelName);
  const listeners = new Set<(event: { name: string; payload: unknown }) => void>();

  channel.onmessage = (event) => {
    if (event.data?.type === "custom") {
      listeners.forEach((listener) => {
        listener({ name: event.data.name, payload: event.data.payload });
      });
    }
  };

  return {
    send(name: string, payload: unknown) {
      channel.postMessage({ type: "custom", name, payload });
    },

    subscribe(callback: (event: { name: string; payload: unknown }) => void) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    close() {
      listeners.clear();
      channel.close();
    },
  };
}
