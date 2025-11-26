"use client";

import { useContext, useState, useEffect } from "react";
import { NavigationStoreContext } from "./context.js";
import type { NavigationState, NavigateOptions } from "../types.js";

// SSR-safe default state
const SSR_DEFAULT_STATE: NavigationState = {
  state: "idle",
  isStreaming: false,
  location: { pathname: "", search: "", hash: "", href: "" },
  formData: null,
  formAction: null,
  inflightActions: [],
};

// No-op functions for SSR
const noopNavigate = async () => {};
const noopRefresh = async () => {};

/**
 * Navigation methods returned by useNavigation
 */
export interface NavigationMethods {
  navigate: (url: string, options?: NavigateOptions) => Promise<void>;
  refresh: () => Promise<void>;
}

/**
 * Full value returned when no selector is provided
 */
export type NavigationValue = NavigationState & NavigationMethods;

/**
 * Hook to access navigation state with optional selector for performance
 *
 * @example
 * ```tsx
 * const state = useNavigation(nav => nav.state);
 * const hasInflightActions = useNavigation(nav => nav.inflightActions.length > 0);
 * ```
 */
export function useNavigation(): NavigationValue;
export function useNavigation<T>(selector: (state: NavigationState) => T): T;
export function useNavigation<T>(
  selector?: (state: NavigationState) => T
): T | NavigationValue {
  const ctx = useContext(NavigationStoreContext);

  // Initialize with SSR-safe default (useState initializer runs on server too)
  const [value, setValue] = useState<T | NavigationState>(() => {
    if (typeof document === "undefined" || !ctx) {
      return selector ? selector(SSR_DEFAULT_STATE) : SSR_DEFAULT_STATE;
    }
    const state = ctx.store.getState();
    return selector ? selector(state) : state;
  });

  // Subscribe to store changes (only runs on client)
  useEffect(() => {
    if (!ctx) return;

    // Sync immediately in case state changed between render and effect
    const current = ctx.store.getState();
    setValue(selector ? selector(current) : current);

    // Subscribe to updates
    return ctx.store.subscribe(() => {
      const next = ctx.store.getState();
      setValue(selector ? selector(next) : next);
    });
  }, [ctx, selector]);

  // If no selector, include navigation methods
  if (!selector) {
    return {
      ...(value as NavigationState),
      navigate: ctx?.navigate ?? noopNavigate,
      refresh: ctx?.refresh ?? noopRefresh,
    };
  }

  return value as T;
}
