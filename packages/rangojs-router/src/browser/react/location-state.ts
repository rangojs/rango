"use client";

import {
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { NavigationStoreContext } from "./context.js";
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

function readLocationStateValue<TState>(
  key: string | undefined,
  location?: { readonly state: unknown } | null,
): TState | undefined {
  // Typed state: history.state[key]. Plain state: history.state.state. Either
  // is read only when the entry recorded this client's app version.
  return readableLocationState(location || undefined)?.[key || "state"] as
    | TState
    | undefined;
}

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
 * Hook to read location state from history.state
 *
 * A reader sees an entry's state together with that entry's tree: on a
 * navigation the value changes in the React commit that brings the
 * destination, so content a pending navigation keeps on screen keeps the
 * state of the entry being left (#1029).
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
  // Not compiled by the React Compiler: its memo cache for this hook (29
  // slots) re-derives what the dependency lists below already pin, and costs
  // 296B gzip in the eager router chunk of an app that enables it.
  "use no memo";
  const key = definition?.__rsc_ls_key;
  const isFlash = definition?.__rsc_ls_flash ?? false;
  const ctx = useContext(NavigationStoreContext);
  const optimistic = useContext(OptimisticLocationContext);

  // The slot as read at mount and at each location-state commit since. React
  // state, not a store snapshot: the commit's update runs in the lane of the
  // payload that brings the entry's tree, so a transition React holds renders
  // the destination's value while the tree on screen keeps its own. A store
  // read (useSyncExternalStore) is the latest value in every tree at once.
  // write()/delete() and the flash clear replace history.state without a
  // commit, so they stay invisible here until the next one.
  const readSlot = (): { key: typeof key; value: TState | undefined } => ({
    key,
    value: readLocationStateValue<TState>(key, optimistic),
  });
  const [slot, setSlot] = useState(readSlot);
  // A reader handed another definition must not return the previous slot,
  // in the pass that notices the change either.
  let current = slot;
  if (slot.key !== key) setSlot((current = readSlot()));
  // The commit this reader last took, and the slot it took with it. Every
  // reader hears every commit; one that finds its slot as it was sets no
  // state, so it does not render for it, not even to bail out.
  const seen = useRef({
    commit: ctx?.eventController.getLocationStateCommit(),
    slot,
  });

  useEffect(() => {
    if (!ctx) return;
    const update = (): void => {
      const commit = ctx.eventController.getLocationStateCommit();
      const last = seen.current;
      if (commit === last.commit) return;
      last.commit = commit;
      const next = readLocationStateValue<TState>(key);
      // A flash reader emptied its own slot after paint: a commit that finds
      // it empty must not take the shown value away. Back/forward applies the
      // destination entry as it is.
      if (isFlash && next === undefined && !commit.traversal) return;
      if (last.slot.key !== key || next !== last.slot.value) {
        setSlot((last.slot = { key, value: next }));
      }
    };
    // A commit between the render that read the slot and this subscription.
    update();
    return ctx.eventController.subscribe(update);
  }, [key, isFlash]);

  // Inside an optimistically rendered clientUrls() destination history still
  // holds the entry being left: read the entry the navigation will push.
  const shown = optimistic
    ? readLocationStateValue<TState>(key, optimistic)
    : current.value;
  // useSyncExternalStore only for its server snapshot: no other hook tells a
  // hydrating render from a client one.
  const state = useSyncExternalStore<TState | undefined>(
    subscribeToNothing,
    () => shown,
    getServerSnapshot,
  );

  // Flash: clear from history.state after paint so subsequent navigations don't see it.
  // Depends on `state` so it re-runs when a commit delivers a value. Not while
  // the value is the optimistic entry's: history.state is another entry's.
  useEffect(() => {
    if (isFlash && key && !optimistic && state !== undefined) {
      const cleaned = { ...window.history.state };
      delete cleaned[key];
      replaceCurrentHistoryState(cleaned);
    }
  }, [isFlash, key, state, optimistic]);

  return state;
}
