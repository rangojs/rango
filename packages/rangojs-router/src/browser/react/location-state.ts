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
  type LocationStateOptions,
} from "./location-state-shared.js";

/**
 * Hook to read location state from history.state
 *
 * Behavior depends on the definition:
 * - Normal state: persists across navigations, reactive to popstate
 * - Flash state (created with { flash: true }): read once, cleared after paint
 *
 * Overloaded:
 * - With definition: Returns typed state from the specific key
 * - With type param only: Returns legacy state from history.state.state (backwards compat)
 *
 * @example
 * ```typescript
 * // Persistent state
 * const ProductState = createLocationState<{ name: string }>();
 * const state = useLocationState(ProductState);
 *
 * // Flash state (auto-clears after paint)
 * const FlashMsg = createLocationState<{ text: string }>({ flash: true });
 * const flash = useLocationState(FlashMsg);
 *
 * // Legacy typed access (backwards compatible)
 * const legacyState = useLocationState<{ from?: string }>();
 * ```
 */
export function useLocationState<TArgs extends unknown[], TState>(
  definition: LocationStateDefinition<TArgs, TState>,
): TState | undefined;
export function useLocationState<T = unknown>(): T | undefined;
export function useLocationState<TArgs extends unknown[], TState>(
  definition?: LocationStateDefinition<TArgs, TState>,
): TState | undefined {
  const key = definition?.__rsc_ls_key;
  const isFlash = definition?.__rsc_ls_flash ?? false;

  const [state, setState] = useState<TState | undefined>(() => {
    if (typeof window === "undefined") return undefined;
    if (key) {
      return window.history.state?.[key] as TState | undefined;
    }
    // Legacy: return history.state.state for backwards compatibility
    return window.history.state?.state as TState | undefined;
  });

  // Subscribe to popstate and programmatic state changes
  useEffect(() => {
    const handlePopstate = () => {
      if (key) {
        setState(window.history.state?.[key] as TState | undefined);
      } else {
        setState(window.history.state?.state as TState | undefined);
      }
    };

    // Handle programmatic state changes (same-page navigation with
    // ctx.setLocationState where components don't remount)
    const handleLocationState = () => {
      if (key) {
        const val = window.history.state?.[key] as TState | undefined;
        if (isFlash) {
          // For flash state, only update if there's a new value
          if (val !== undefined) {
            setState(val);
          }
        } else {
          setState(val);
        }
      }
    };

    window.addEventListener("popstate", handlePopstate);
    window.addEventListener("__rsc_locationstate", handleLocationState);
    return () => {
      window.removeEventListener("popstate", handlePopstate);
      window.removeEventListener("__rsc_locationstate", handleLocationState);
    };
  }, [key, isFlash]);

  // Flash: clear from history.state after paint so subsequent navigations don't see it.
  // Depends on `state` so it re-runs when state is set via the event listener.
  useEffect(() => {
    if (isFlash && key && state !== undefined) {
      const cleaned = { ...window.history.state };
      delete cleaned[key];
      window.history.replaceState(cleaned, "", window.location.href);
    }
  }, [isFlash, key, state]);

  return state;
}
