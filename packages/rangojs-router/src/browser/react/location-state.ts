"use client";

import { useState, useEffect } from "react";
import type { LocationStateDefinition } from "./location-state-shared.js";

// Re-export shared utilities and types
export {
  createLocationState,
  isLocationStateEntry,
  resolveLocationStateEntries,
  type LocationStateEntry,
  type LocationStateDefinition,
} from "./location-state-shared.js";

/**
 * Hook to read location state from history.state
 *
 * Overloaded:
 * - With definition: Returns typed state from the specific key
 * - With type param only: Returns legacy state from history.state.state (backwards compat)
 *
 * @example
 * ```typescript
 * // Typed access with definition (recommended)
 * const ProductState = createLocationState<{ name: string }>("product");
 * const state = useLocationState(ProductState);
 * // state: { name: string } | undefined
 *
 * // Legacy typed access (backwards compatible)
 * const legacyState = useLocationState<{ from?: string }>();
 * ```
 */
export function useLocationState<TArgs extends unknown[], TState>(
  definition: LocationStateDefinition<TArgs, TState>
): TState | undefined;
export function useLocationState<T = unknown>(): T | undefined;
export function useLocationState<TArgs extends unknown[], TState>(
  definition?: LocationStateDefinition<TArgs, TState>
): TState | undefined {
  const [state, setState] = useState<TState | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    if (definition) {
      return window.history.state?.[definition.__rsc_ls_key] as TState | undefined;
    }
    // Legacy: return history.state.state for backwards compatibility
    return window.history.state?.state as TState | undefined;
  });

  useEffect(() => {
    const handlePopstate = () => {
      if (definition) {
        setState(window.history.state?.[definition.__rsc_ls_key] as TState | undefined);
      } else {
        setState(window.history.state?.state as TState | undefined);
      }
    };
    // Also handle programmatic state changes (same-page navigation with
    // ctx.setLocationState where components don't remount)
    const handleLocationState = () => {
      if (definition) {
        setState(window.history.state?.[definition.__rsc_ls_key] as TState | undefined);
      }
    };
    window.addEventListener("popstate", handlePopstate);
    window.addEventListener("__rsc_locationstate", handleLocationState);
    return () => {
      window.removeEventListener("popstate", handlePopstate);
      window.removeEventListener("__rsc_locationstate", handleLocationState);
    };
  }, [definition]);

  return state;
}

/**
 * Hook to read location state once (flash message pattern)
 *
 * Reads the value from history.state on mount and automatically clears
 * it via replaceState after paint. This means:
 * - All components that call useFlashState(SameDef) during the same render
 *   will see the value (React renders before running effects)
 * - After paint, the value is removed from history.state
 * - Pressing back/forward won't re-show the flash since it was cleared
 *
 * Also handles same-page redirects where components don't remount:
 * the navigation bridge dispatches "__rsc_locationstate" after pushState,
 * and this hook subscribes to re-read the value.
 *
 * @example
 * ```typescript
 * const Flash = createLocationState<{ text: string }>();
 *
 * // In a component on the target page:
 * const flash = useFlashState(Flash);
 * // flash: { text: "Item saved!" } | undefined
 * ```
 */
export function useFlashState<TArgs extends unknown[], TState>(
  definition: LocationStateDefinition<TArgs, TState>
): TState | undefined {
  const key = definition.__rsc_ls_key;

  const [state, setState] = useState<TState | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    return window.history.state?.[key] as TState | undefined;
  });

  // Subscribe to programmatic location state changes. Needed for same-page
  // redirects where the component doesn't remount and the useState initializer
  // doesn't re-run, even though history.state has been updated.
  useEffect(() => {
    const handleStateChange = () => {
      const val = window.history.state?.[key] as TState | undefined;
      if (val !== undefined) {
        setState(val);
      }
    };
    window.addEventListener("__rsc_locationstate", handleStateChange);
    return () => window.removeEventListener("__rsc_locationstate", handleStateChange);
  }, [key]);

  // On popstate (back/forward), reset to whatever is in history.state.
  // Since flash is cleared via replaceState after being read, going back
  // will find undefined, preventing the flash from re-appearing.
  useEffect(() => {
    const handlePopstate = () => {
      setState(window.history.state?.[key] as TState | undefined);
    };
    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, [key]);

  // Clear from history.state after paint so subsequent navigations don't see it.
  // Depends on `state` so it re-runs when state is set via the event listener.
  useEffect(() => {
    if (state !== undefined) {
      const cleaned = { ...window.history.state };
      delete cleaned[key];
      window.history.replaceState(cleaned, "", window.location.href);
    }
  }, [key, state]);

  return state;
}
