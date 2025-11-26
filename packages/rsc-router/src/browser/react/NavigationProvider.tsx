"use client";

import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
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

  /**
   * Children to render (optional, defaults to payload.root)
   */
  children?: ReactNode;
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
  children,
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

  // Track initial RSC stream completion (runs after hydration is complete)
  useEffect(() => {
    // Check if the initial stream is still open
    // The rsc-html-stream closes on DOMContentLoaded
    if (
      document.readyState === "complete" ||
      document.readyState === "interactive"
    ) {
      // DOMContentLoaded already fired - stream is closed, keep isStreaming: false
      console.log(
        "[Browser] Initial stream already complete (DOMContentLoaded already fired)"
      );
    } else {
      // Stream is still open - set isStreaming: true now (after hydration)
      store.setState({ isStreaming: true });
      console.log("[Browser] RSC stream still open, tracking completion...");

      // Wait for DOMContentLoaded to mark stream as complete
      const handleDOMContentLoaded = () => {
        store.setState({ isStreaming: false });
        console.log("[Browser] Initial stream complete (DOMContentLoaded)");
      };

      document.addEventListener("DOMContentLoaded", handleDOMContentLoaded, {
        once: true,
      });

      return () => {
        document.removeEventListener(
          "DOMContentLoaded",
          handleDOMContentLoaded
        );
      };
    }
  }, [store]);

  return (
    <NavigationStoreContext.Provider value={contextValue}>
      {children ?? payload.root}
    </NavigationStoreContext.Provider>
  );
}
