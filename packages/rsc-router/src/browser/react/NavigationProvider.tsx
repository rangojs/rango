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

/**
 * Props for NavigationProvider
 */
export interface NavigationProviderProps {
  /**
   * Navigation store instance
   */
  store: NavigationStore;

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
 * - Providing stable store reference (never re-renders consumers)
 * - Subscribing to UI updates to re-render the tree
 * - Providing navigate/refresh methods (delegated to bridge)
 *
 * State subscriptions happen via useNavigation hook, not via context.
 * This means context consumers don't re-render on state changes.
 *
 * @example
 * ```tsx
 * <NavigationProvider
 *   store={store}
 *   initialPayload={payload}
 *   bridge={navigationBridge}
 * />
 * ```
 */
export function NavigationProvider({
  store,
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
    [bridge]
  );

  /**
   * Refresh current route (delegates to bridge)
   */
  const refresh = useCallback(async (): Promise<void> => {
    await bridge.refresh();
  }, [bridge]);

  // Context value is stable (store, navigate, refresh never change)
  const contextValue = useMemo<NavigationStoreContextValue>(
    () => ({
      store,
      navigate,
      refresh,
    }),
    [store, navigate, refresh]
  );

  // Subscribe to UI updates (for re-rendering the tree)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      setPayload({
        root: update.root,
        metadata: update.metadata,
      });
    });

    console.log("[Browser] NavigationProvider ready");

    return unsubscribe;
  }, [store]);

  // Note: We intentionally do NOT set isStreaming: true for the initial page load.
  // The initial RSC stream is already rendered via SSR, so the content is visible.
  // Setting isStreaming: true during hydration would cause a hydration mismatch
  // because the server rendered with isStreaming: false.
  // isStreaming is only set to true during client-side navigations and HMR updates.
  useEffect(() => {
    console.log(
      "[Browser] Initial page load - isStreaming stays false (SSR content already visible)"
    );
  }, []);

  // Handle promise case - use() will suspend until resolved
  const root = payload.root instanceof Promise ? use(payload.root) : payload.root;

  return (
    <NavigationStoreContext.Provider value={contextValue}>
      {root}
    </NavigationStoreContext.Provider>
  );
}
