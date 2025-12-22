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
  RscPayload,
  NavigateOptions,
  NavigationBridge,
} from "../types.js";
import { updateHandleData } from "./use-handle.js";
import type { EventController } from "../event-controller.js";

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
   * Initial RSC payload from server
   */
  initialPayload: RscPayload;

  /**
   * Navigation bridge for handling navigation
   */
  bridge: NavigationBridge;
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
    []
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
    []
  );

  // Subscribe to UI updates (for re-rendering the tree)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      setPayload({
        root: update.root,
        metadata: update.metadata,
      });

      // Update handle data if present (async, doesn't block UI update)
      if (update.metadata.handles) {
        update.metadata.handles.then((handleData) => {
          updateHandleData(
            handleData,
            update.metadata.matched,
            update.metadata.isPartial
          );
        });
      }
    });

    console.log("[Browser] NavigationProvider ready");

    return unsubscribe;
  }, []);

  // Note: We intentionally do NOT set isStreaming: true for the initial page load.
  // The initial RSC stream is already rendered via SSR, so the content is visible.
  // Setting isStreaming: true during hydration would cause a hydration mismatch
  // because the server rendered with isStreaming: false.
  // isStreaming is only set to true during client-side navigations and HMR updates.
  useEffect(() => {
    console.log(
      "[Browser] Initial page load - isStreaming stays false (SSR content already visible)"
    );

    // Initialize handle data from initial payload
    if (initialPayload.metadata?.handles) {
      initialPayload.metadata.handles.then((handleData) => {
        updateHandleData(handleData, initialPayload.metadata?.matched);
      });
    }
  }, []);

  // Handle promise case - use() will suspend until resolved
  const root =
    payload.root instanceof Promise ? use(payload.root) : payload.root;

  return (
    <NavigationStoreContext.Provider value={contextValue}>
      {root}
    </NavigationStoreContext.Provider>
  );
}
