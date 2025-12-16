"use client";

import {
  useContext,
  useState,
  useEffect,
  useOptimistic,
  startTransition,
  useRef,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type { PublicNavigationState, NavigateOptions } from "../types.js";
import type { DerivedNavigationState } from "../event-controller.js";

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

// SSR-safe default state (public version without internal properties)
const SSR_DEFAULT_STATE: PublicNavigationState = {
  state: "idle",
  isStreaming: false,
  location: new URL("/", "http://localhost"),
};

/**
 * Convert derived state to public version (strips inflightActions)
 */
function toPublicState(state: DerivedNavigationState): PublicNavigationState {
  const { inflightActions: _, ...publicState } = state;
  return publicState;
}

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
export type NavigationValue = PublicNavigationState & NavigationMethods;

/**
 * Hook to access navigation state with optional selector for performance
 *
 * Uses the event controller for reactive state management.
 * State is derived from source of truth (currentNavigation, inflightActions).
 *
 * @example
 * ```tsx
 * const state = useNavigation(nav => nav.state);
 * const isLoading = useNavigation(nav => nav.state === 'loading');
 * ```
 */
export function useNavigation(): NavigationValue;
export function useNavigation<T>(
  selector: (state: PublicNavigationState) => T
): T;
export function useNavigation<T>(
  selector?: (state: PublicNavigationState) => T
): T | NavigationValue {
  const ctx = useContext(NavigationStoreContext);

  // Base state for useOptimistic
  const [baseValue, setBaseValue] = useState<T | PublicNavigationState>(() => {
    if (typeof document === "undefined" || !ctx) {
      return selector ? selector(SSR_DEFAULT_STATE) : SSR_DEFAULT_STATE;
    }
    const publicState = toPublicState(ctx.eventController.getState());
    return selector ? selector(publicState) : publicState;
  });
  const prevState = useRef(baseValue);

  // useOptimistic allows immediate updates during transitions/actions
  const [value, setOptimisticValue] = useOptimistic(baseValue);

  // Subscribe to event controller state changes (only runs on client)
  useEffect(() => {
    if (!ctx) return;

    // Subscribe to updates from event controller
    return ctx.eventController.subscribe(() => {
      const currentState = ctx.eventController.getState();
      const publicState = toPublicState(currentState);
      const nextSelected = selector ? selector(publicState) : publicState;

      // Check if selected value has changed
      if (!shallowEqual(nextSelected, prevState.current)) {
        prevState.current = nextSelected;

        // Check if any actions are in progress for optimistic updates
        const hasInflightActions =
          ctx.eventController.getInflightActions().size > 0;

        if (hasInflightActions || publicState.state !== "idle") {
          // Use optimistic update for immediate feedback during transitions
          startTransition(() => {
            setOptimisticValue(nextSelected);
          });
        }

        // Always update base state so UI reflects current state
        setBaseValue(nextSelected);
      }
    });
  }, [selector]);

  // If no selector, include navigation methods
  if (!selector) {
    return {
      ...(value as PublicNavigationState),
      navigate: ctx?.navigate ?? noopNavigate,
      refresh: ctx?.refresh ?? noopRefresh,
    };
  }

  return value as T;
}
