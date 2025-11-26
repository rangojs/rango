"use client";

import { useState, useEffect, useContext, useRef, useCallback } from "react";
import { NavigationStoreContext } from "./context.js";
import { shallow } from "../shallow.js";
import type { NavigationState, NavigateOptions } from "../types.js";

/**
 * Navigation methods returned by useNavigation
 */
export interface NavigationMethods {
  /**
   * Navigate to a new URL
   *
   * @param url - The URL to navigate to
   * @param options - Navigation options (replace, scroll)
   * @returns Promise that resolves when navigation is complete
   */
  navigate: (url: string, options?: NavigateOptions) => Promise<void>;

  /**
   * Refresh the current route
   *
   * @returns Promise that resolves when refresh is complete
   */
  refresh: () => Promise<void>;
}

/**
 * Full value returned when no selector is provided
 */
export type NavigationValue = NavigationState & NavigationMethods;

/**
 * Hook to access navigation state with optional selector for performance
 *
 * Uses a Zustand-style selector pattern. Components only re-render when
 * their selected slice of state changes.
 *
 * @param selector - Optional selector function to pick state slice
 * @returns Selected state value, or full navigation value if no selector
 *
 * @example
 * ```tsx
 * // Get everything (re-renders on any change)
 * const nav = useNavigation();
 *
 * // Only re-render when state changes
 * const state = useNavigation(nav => nav.state);
 *
 * // Only re-render when pathname changes
 * const pathname = useNavigation(nav => nav.location.pathname);
 *
 * // Derive computed values
 * const isSubmitting = useNavigation(nav => nav.state === 'submitting');
 * ```
 */
export function useNavigation(): NavigationValue;
export function useNavigation<T>(
  selector: (state: NavigationState) => T
): T;
export function useNavigation<T>(
  selector?: (state: NavigationState) => T
): T | NavigationValue {
  const ctx = useContext(NavigationStoreContext);
  if (!ctx) {
    throw new Error(
      "useNavigation must be used within NavigationProvider. " +
        "Ensure your app is wrapped with <NavigationProvider>."
    );
  }

  const { store, navigate, refresh } = ctx;

  // Memoize selector to avoid useEffect re-runs
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Get initial value
  const getSelectedValue = useCallback(() => {
    const state = store.getState();
    return selectorRef.current ? selectorRef.current(state) : state;
  }, [store]);

  // Initialize state with current store value
  const [value, setValue] = useState<T | NavigationState>(getSelectedValue);

  // Subscribe to store changes
  useEffect(() => {
    // Sync immediately in case store changed between render and effect
    const current = getSelectedValue();
    setValue((prev) => (shallow(prev, current) ? prev : current));

    const unsubscribe = store.subscribe(() => {
      const next = getSelectedValue();
      setValue((prev) => (shallow(prev, next) ? prev : next));
    });

    return unsubscribe;
  }, [store, getSelectedValue]);

  // If no selector, include methods in returned value
  if (!selector) {
    return {
      ...(value as NavigationState),
      navigate,
      refresh,
    };
  }

  return value as T;
}
