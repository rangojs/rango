"use client";

import { useContext, useEffect, useSyncExternalStore } from "react";
import { LocationStateContext } from "./context.js";
import { OptimisticLocationContext } from "../../client-urls/optimistic-location.js";
import {
  readableLocationState,
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

/**
 * Server and hydration renders must match the SSR output (`undefined`).
 * React then re-renders with `getSnapshot`, including a reader whose Suspense
 * boundary hydrates after the root has set `data-hydrated`.
 */
function getServerSnapshot(): undefined {
  return undefined;
}

const subscribeToNothing = (): (() => void) => () => {};

/**
 * Hook to read the location state of the history entry on screen
 *
 * A reader sees an entry's state together with that entry's tree: on a
 * navigation the value changes in the React commit that brings the
 * destination, so content a pending navigation keeps on screen keeps the
 * state of the entry being left, for a reader that mounts there too (#1029).
 *
 * Behavior depends on the definition:
 * - Normal state: persists across navigations and back/forward
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
  const entry = useContext(LocationStateContext);
  const optimistic = useContext(OptimisticLocationContext);

  // Typed state: the slot under its key. Plain state: the `state` slot.
  // Inside an optimistically rendered clientUrls() destination the provider
  // still holds the entry being left: read the entry the navigation will push.
  const shown = (optimistic ? readableLocationState(optimistic) : entry)?.[
    key || "state"
  ] as TState | undefined;
  // useSyncExternalStore only for its server snapshot: no other hook tells a
  // hydrating render from a client one.
  const state = useSyncExternalStore<TState | undefined>(
    subscribeToNothing,
    () => shown,
    getServerSnapshot,
  );

  // Flash: removed from history.state after paint, so a reload or a return to
  // the entry does not show it again. The provider's snapshot keeps it, so it
  // stays on screen until the next commit of the entry's state. Not while the
  // value is the optimistic entry's: history.state is another entry's.
  useEffect(() => {
    if (isFlash && key && !optimistic && state !== undefined) {
      const cleaned = { ...window.history.state };
      delete cleaned[key];
      replaceCurrentHistoryState(cleaned);
    }
  }, [isFlash, key, state, optimistic]);

  return state;
}
