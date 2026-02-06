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
    window.addEventListener("popstate", handlePopstate);
    return () => window.removeEventListener("popstate", handlePopstate);
  }, [definition]);

  return state;
}
