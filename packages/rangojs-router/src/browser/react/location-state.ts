"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
  replaceCurrentHistoryState,
  type LocationStateDefinition,
} from "./location-state-shared.js";

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

/**
 * Server and hydration renders must match the SSR output (`undefined`).
 * React then re-renders with `getSnapshot`, including a reader whose Suspense
 * boundary hydrates after the root has set `data-hydrated`.
 */
function getServerSnapshot(): undefined {
  return undefined;
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

  // Flash is shown once, then removed from history after paint. Keep returning
  // that captured value: under StrictMode the clear effect runs before the
  // second setup pass, and a re-read would clobber it with the now-cleared
  // `undefined`. A new definition must not keep the previous slot's capture.
  const flashSnapshotRef = useRef<TState | undefined>(undefined);
  const flashCapturedRef = useRef(false);
  const slotRef = useRef(key);
  const slotFlashRef = useRef(isFlash);
  if (slotRef.current !== key || slotFlashRef.current !== isFlash) {
    slotRef.current = key;
    slotFlashRef.current = isFlash;
    flashSnapshotRef.current = undefined;
    flashCapturedRef.current = false;
  }

  const getSnapshot = useCallback((): TState | undefined => {
    const current = readLocationStateValue<TState>(key);
    if (!isFlash) return current;
    if (flashCapturedRef.current) return flashSnapshotRef.current;
    if (current !== undefined) {
      flashSnapshotRef.current = current;
      flashCapturedRef.current = true;
    }
    return current;
  }, [key, isFlash]);

  // popstate always applies the destination entry, including an empty flash
  // slot. `__rsc_locationstate` for flash ignores an empty slot: the
  // clear-after-paint does not dispatch this event, and a clear-only
  // notification must not wipe the value already shown. Update the capture
  // before notifying — the store reads getSnapshot inside that call.
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      const handlePopstate = (): void => {
        if (isFlash) {
          flashSnapshotRef.current = readLocationStateValue<TState>(key);
          flashCapturedRef.current = true;
        }
        onStoreChange();
      };
      const handleLocationState = (): void => {
        if (isFlash && key) {
          const next = readLocationStateValue<TState>(key);
          if (next === undefined) return;
          flashSnapshotRef.current = next;
          flashCapturedRef.current = true;
        }
        onStoreChange();
      };
      window.addEventListener("popstate", handlePopstate);
      window.addEventListener("__rsc_locationstate", handleLocationState);
      return () => {
        window.removeEventListener("popstate", handlePopstate);
        window.removeEventListener("__rsc_locationstate", handleLocationState);
      };
    },
    [key, isFlash],
  );

  const state = useSyncExternalStore<TState | undefined>(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Flash: clear from history.state after paint so subsequent navigations don't see it.
  // Depends on `state` so it re-runs when state is set via the event listener.
  useEffect(() => {
    if (isFlash && key && state !== undefined) {
      const cleaned = { ...window.history.state };
      delete cleaned[key];
      replaceCurrentHistoryState(cleaned);
    }
  }, [isFlash, key, state]);

  return state;
}
