"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  use,
  type ReactNode,
} from "react";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./context.js";
import type {
  NavigationStore,
  NavigationUpdate,
  NavigateOptions,
  NavigationBridge,
} from "../types.js";
import type { EventController } from "../event-controller.js";
import { RootErrorBoundary } from "../../root-error-boundary.js";
import type { HandleData } from "../types.js";
import { ThemeProvider } from "../../theme/ThemeProvider.js";
import type { ResolvedThemeConfig, Theme } from "../../theme/types.js";

/**
 * Process handles from an async generator, updating the event controller
 * and cache as data streams in.
 *
 * This handles:
 * 1. Consuming the async generator and calling setHandleData on each yield
 * 2. Stopping early if user navigates away (historyKey changes)
 * 3. Cleaning up stale data when generator yields nothing
 * 4. Updating the cache after processing completes (if still on same page)
 */
async function processHandles(
  handlesGenerator: AsyncGenerator<HandleData>,
  opts: {
    eventController: EventController;
    store: NavigationStore;
    matched?: string[];
    isPartial?: boolean;
    historyKey: string;
  },
): Promise<void> {
  const { eventController, store, matched, isPartial, historyKey } = opts;

  let yieldCount = 0;
  for await (const handleData of handlesGenerator) {
    // Check if user navigated away before each update.
    // This prevents handle data from cancelled navigations polluting
    // the current route's breadcrumbs (e.g., quick popstate after clicking a link).
    if (historyKey !== store.getHistoryKey()) {
      console.log(
        "[NavigationProvider] Stopping handle processing - user navigated away",
      );
      return;
    }

    yieldCount++;
    eventController.setHandleData(handleData, matched, isPartial);
  }

  // Check again before final updates
  if (historyKey !== store.getHistoryKey()) {
    return;
  }

  // For partial updates where the generator yielded nothing (cached handlers),
  // we still need to update the segment order to clean up stale handle data.
  // This happens when navigating away from a route - the handlers for the new
  // route might not push any breadcrumbs, but we still need to remove the old ones.
  if (yieldCount === 0 && matched) {
    eventController.setHandleData({}, matched, true);
  }

  // After handles processing completes, update the cache's handleData.
  // This fixes a race condition where commit() caches stale handleData before
  // the async handles processing completes.
  // Only update if we're still on the same page (historyKey matches).
  if (historyKey === store.getHistoryKey()) {
    const finalHandleData = eventController.getHandleState().data;
    store.updateCacheHandleData(historyKey, finalHandleData);
  }
}

/**
 * Props for NavigationProvider
 */
export interface NavigationProviderProps {
  /**
   * Navigation store instance (for cache/segment management)
   */
  store: NavigationStore;

  /**
   * Event controller instance (for navigation/action state)
   */
  eventController: EventController;

  /**
   * Initial rendered tree + metadata from server payload
   */
  initialPayload: NavigationUpdate;

  /**
   * Navigation bridge for handling navigation
   */
  bridge: NavigationBridge;

  /**
   * Theme configuration (null if theme not enabled)
   * When provided, wraps content in ThemeProvider
   */
  themeConfig?: ResolvedThemeConfig | null;

  /**
   * Initial theme from server (from cookie)
   * Only used when themeConfig is provided
   */
  initialTheme?: Theme;

  /**
   * Whether connection warmup is enabled.
   * When true, keeps TLS alive by sending HEAD requests after idle periods.
   */
  warmupEnabled?: boolean;
}

/**
 * Navigation provider component
 *
 * Provides navigation context to the component tree and handles:
 * - Providing stable store and event controller references (never re-renders consumers)
 * - Subscribing to UI updates to re-render the tree
 * - Providing navigate/refresh methods (delegated to bridge)
 *
 * State subscriptions happen via useNavigation hook (via event controller), not via context.
 * This means context consumers don't re-render on state changes.
 *
 * @example
 * ```tsx
 * <NavigationProvider
 *   store={store}
 *   eventController={eventController}
 *   initialPayload={payload}
 *   bridge={navigationBridge}
 * />
 * ```
 */
export function NavigationProvider({
  store,
  eventController,
  initialPayload,
  bridge,
  themeConfig,
  initialTheme,
  warmupEnabled,
}: NavigationProviderProps): ReactNode {
  // Track current payload for rendering (this triggers re-renders)
  const [payload, setPayload] = useState(initialPayload);

  /**
   * Navigate to a URL (delegates to bridge)
   */
  const navigate = useCallback(
    async (url: string, options?: NavigateOptions): Promise<void> => {
      await bridge.navigate(url, options);
    },
    [],
  );

  /**
   * Refresh current route (delegates to bridge)
   */
  const refresh = useCallback(async (): Promise<void> => {
    await bridge.refresh();
  }, []);

  // Context value is stable (store, eventController, navigate, refresh never change)
  const contextValue = useMemo<NavigationStoreContextValue>(
    () => ({
      store,
      eventController,
      navigate,
      refresh,
    }),
    [],
  );

  // Connection warmup: keep TLS alive after idle periods.
  // After 60s of no user interaction, marks connection as "cold".
  // On next interaction or visibility change, sends a HEAD request to warm TLS
  // before the user actually clicks a link.
  useEffect(() => {
    if (!warmupEnabled) return;

    const IDLE_TIMEOUT = 60_000;
    const DEBOUNCE_DELAY = 150;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let isCold = false;
    let warmupListenersAttached = false;

    function sendWarmup() {
      isCold = false;
      fetch("/?_rsc_warmup", { method: "HEAD" }).catch(() => {});
    }

    function triggerWarmup() {
      if (!isCold) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        sendWarmup();
        detachWarmupListeners();
        resetIdleTimer();
      }, DEBOUNCE_DELAY);
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible" && isCold) {
        triggerWarmup();
      }
    }

    function attachWarmupListeners() {
      if (warmupListenersAttached) return;
      warmupListenersAttached = true;
      document.addEventListener("visibilitychange", onVisibilityChange);
      document.addEventListener("mousemove", triggerWarmup, { once: true });
      document.addEventListener("touchstart", triggerWarmup, { once: true });
    }

    function detachWarmupListeners() {
      warmupListenersAttached = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("mousemove", triggerWarmup);
      document.removeEventListener("touchstart", triggerWarmup);
    }

    function markCold() {
      isCold = true;
      attachWarmupListeners();
    }

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      isCold = false;
      idleTimer = setTimeout(markCold, IDLE_TIMEOUT);
    }

    // Activity events that reset the idle timer
    const activityEvents = [
      "mousemove",
      "keydown",
      "touchstart",
      "scroll",
    ] as const;
    const activityOptions: AddEventListenerOptions = { passive: true };

    for (const event of activityEvents) {
      document.addEventListener(event, resetIdleTimer, activityOptions);
    }

    resetIdleTimer();

    return () => {
      clearTimeout(idleTimer);
      clearTimeout(debounceTimer);
      detachWarmupListeners();
      for (const event of activityEvents) {
        document.removeEventListener(event, resetIdleTimer);
      }
    };
  }, [warmupEnabled]);

  // Subscribe to UI updates (for re-rendering the tree)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      setPayload({
        root: update.root,
        metadata: update.metadata,
      });

      // Update handle data progressively as it streams in
      if (update.metadata.handles) {
        // Capture historyKey now - by the time async processing completes,
        // the user might have navigated elsewhere
        const historyKey = store.getHistoryKey();

        processHandles(update.metadata.handles, {
          eventController,
          store,
          matched: update.metadata.matched,
          isPartial: update.metadata.isPartial,
          historyKey,
        }).catch((err) =>
          console.error("[NavigationProvider] Error consuming handles:", err),
        );
      } else if (update.metadata.cachedHandleData) {
        // For back/forward navigation from cache, restore the cached handleData
        // This restores breadcrumbs to the exact state they were when the page was cached
        eventController.setHandleData(
          update.metadata.cachedHandleData,
          update.metadata.matched,
          false, // full replace - restore entire cached state
        );
      } else if (update.metadata.matched) {
        // For cached navigations without handleData, update segmentOrder to clean up stale data
        eventController.setHandleData(
          {}, // Empty data - all existing data not in matched will be cleaned up
          update.metadata.matched,
          true, // partial update - will clean up segments not in matched
        );
      }
    });

    return unsubscribe;
  }, []);

  // Handle promise case - use() will suspend until resolved
  const root =
    payload.root instanceof Promise ? use(payload.root) : payload.root;

  // Wrap content in RootErrorBoundary to catch:
  // 1. Errors from NetworkErrorThrower (rendered during network failures)
  // 2. Client component errors that occur before/outside the segment tree's error boundary
  // 3. Errors during promise resolution or navigation state updates
  // This acts as a safety net - the segment tree has its own RootErrorBoundary that
  // catches most errors, but this outer boundary catches anything that slips through.

  // Build the content tree
  let content = <RootErrorBoundary>{root}</RootErrorBoundary>;

  // Wrap with ThemeProvider when theme is enabled
  if (themeConfig) {
    content = (
      <ThemeProvider config={themeConfig} initialTheme={initialTheme}>
        {content}
      </ThemeProvider>
    );
  }

  return (
    <NavigationStoreContext.Provider value={contextValue}>
      {content}
    </NavigationStoreContext.Provider>
  );
}
