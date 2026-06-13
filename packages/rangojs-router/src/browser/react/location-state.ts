"use client";

import { useState, useEffect, useRef } from "react";
import type { LocationStateDefinition } from "./location-state-shared.js";

export {
  createLocationState,
  isLocationStateEntry,
  resolveLocationStateEntries,
  type LocationStateEntry,
  type LocationStateDefinition,
  type LocationStateOptions,
} from "./location-state-shared.js";

function readLocationStateValue<TState>(
  key: string | undefined,
): TState | undefined {
  if (typeof window === "undefined") return undefined;
  if (key) {
    return window.history.state?.[key] as TState | undefined;
  }
  // Plain state: stored under history.state.state
  return window.history.state?.state as TState | undefined;
}

function hasHydrated(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.hasAttribute("data-hydrated")
  );
}

/**
 * Hook to read location state from history.state
 *
 * Behavior depends on the definition:
 * - Normal state: persists across navigations, reactive to popstate
 * - Flash state (created with { flash: true }): read once, cleared after paint
 *
 * Overloaded:
 * - With definition: Returns typed state from the specific key
 * - With type param only: Returns plain state from history.state.state
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
 * // Plain state access (reads from history.state.state)
 * const state = useLocationState<{ from?: string }>();
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

  // Track whether the initial render returned undefined because the page
  // hadn't hydrated yet. If so, the mount effect catches up by reading
  // history.state once. If not, we already have the right value and must
  // not re-read on mount — under StrictMode, the flash-cleanup effect runs
  // before the second setup pass, so a re-read would clobber the captured
  // value with the now-cleared `undefined`.
  const initialReadDeferredRef = useRef(false);

  const [state, setState] = useState<TState | undefined>(() => {
    if (!hasHydrated()) {
      initialReadDeferredRef.current = true;
      return undefined;
    }
    return readLocationStateValue<TState>(key);
  });

  // Subscribe to popstate and programmatic state changes
  useEffect(() => {
    const handlePopstate = () => {
      setState(readLocationStateValue<TState>(key));
    };

    // Handle programmatic state changes (same-page navigation with
    // ctx.setLocationState where components don't remount)
    const handleLocationState = () => {
      if (key) {
        const val = readLocationStateValue<TState>(key);
        if (isFlash) {
          // For flash state, only update if there's a new value
          if (val !== undefined) {
            setState(val);
          }
        } else {
          setState(val);
        }
      } else {
        setState(readLocationStateValue<TState>(key));
      }
    };

    if (initialReadDeferredRef.current) {
      initialReadDeferredRef.current = false;
      setState(readLocationStateValue<TState>(key));
    }

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
