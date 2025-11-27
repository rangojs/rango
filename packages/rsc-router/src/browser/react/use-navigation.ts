"use client";

import { useContext, useState, useEffect, useRef, useEffectEvent } from "react";
import { flushSync } from "react-dom";
import { NavigationStoreContext } from "./context.js";
import type { NavigationState, NavigateOptions } from "../types.js";

/**
 * Shallow equality check for selector results
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is((a as any)[key], (b as any)[key])
    ) {
      return false;
    }
  }
  return true;
}

// SSR-safe default state
const SSR_DEFAULT_STATE: NavigationState = {
  state: "idle",
  isStreaming: false,
  location: new URL("/", "http://localhost"),
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
  const isSameValue = useEffectEvent((newValue: unknown) => {
    return shallowEqual(value, newValue);
  });

  // Subscribe to store changes (only runs on client)
  useEffect(() => {
    if (!ctx) return;

    // Sync immediately in case state changed between render and effect
    const current = ctx.store.getState();
    const selected = selector ? selector(current) : current;
    if (!isSameValue(selected)) {
      setValue(selected);
    }

    // Subscribe to updates
    return ctx.store.subscribe(() => {
      const next = ctx.store.getState();
      const nextSelected = selector ? selector(next) : next;

      // Skip update if value hasn't changed
      if (isSameValue(nextSelected)) {
        return;
      }

      if (ctx.store.isActionInProgress()) {
        flushSync(() => {
          setValue(nextSelected);
        });
      } else {
        setValue(nextSelected);
      }
    });
  }, [selector]);

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
