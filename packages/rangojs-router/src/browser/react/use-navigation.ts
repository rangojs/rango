"use client";

import {
  useContext,
  useState,
  useEffect,
  useLayoutEffect,
  startTransition,
  useRef,
} from "react";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";
import type { PublicNavigationState } from "../types.js";
import type { DerivedNavigationState } from "../event-controller.js";

/**
 * Convert derived state to public version (strips inflightActions)
 */
function toPublicState(state: DerivedNavigationState): PublicNavigationState {
  const { inflightActions: _, ...publicState } = state;
  return publicState;
}

/**
 * Hook to access reactive navigation state with optional selector for performance.
 *
 * Returns state only. For actions (push, replace, refresh, prefetch),
 * use useRouter() instead.
 *
 * @example
 * ```tsx
 * const { state, location } = useNavigation();
 * const isLoading = useNavigation(nav => nav.state === 'loading');
 * ```
 */
export function useNavigation(): PublicNavigationState;
export function useNavigation<T>(
  selector: (state: PublicNavigationState) => T,
): T;
export function useNavigation<T>(
  selector?: (state: PublicNavigationState) => T,
): T | PublicNavigationState {
  const ctx = useContext(NavigationStoreContext);

  if (!ctx) {
    throw new Error("useNavigation must be used within NavigationProvider");
  }

  const [value, setValue] = useState<T | PublicNavigationState>(() => {
    const publicState = toPublicState(
      ctx.eventController.getHydrationSnapshot()?.state ??
        ctx.eventController.getState(),
    );
    return selector ? selector(publicState) : publicState;
  });
  const prevState = useRef(value);
  // The value on screen: a set value that differs has not committed yet.
  const committedRef = useRef(value);
  useLayoutEffect(() => {
    committedRef.current = value;
  });

  // Store selector in a ref so the subscription callback always uses the
  // latest selector without re-subscribing on every render (inline functions
  // have a new identity each render). This is event-driven by design: the
  // value updates when the store emits, not when the selector changes.
  // Between events there is nothing new to select from.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to event controller state changes (only runs on client).
  //
  // The value commits in the lane of the notification that carries it, as
  // the location hooks' values do: NavigationProvider flushes a navigation's
  // notification into the transition that commits its tree, so idle commits
  // with the destination's location (useSearchParams, usePathname,
  // useParams). An optimistic update renders in the sync lane, ahead of that
  // transition, and put idle on screen with the location being left (#1164).
  useEffect(() => {
    let last: DerivedNavigationState | undefined;
    const update = () => {
      const currentState = ctx.eventController.getState();
      // Neither the state nor the location moved (the stream starting or
      // ending): while a value of this hook's is held, a transition, which
      // React entangles with it, so it never commits ahead of the location.
      // Otherwise urgent: a transition of its own would start a view
      // transition, and could commit ahead of a held page and take its
      // transition types.
      const quiet =
        currentState.state === last?.state &&
        currentState.location === last.location;
      last = currentState;
      const publicState = toPublicState(currentState);
      const nextSelected = selectorRef.current
        ? selectorRef.current(publicState)
        : publicState;

      // Check if selected value has changed
      if (!shallowEqual(nextSelected, prevState.current)) {
        const held = prevState.current !== committedRef.current;
        prevState.current = nextSelected;
        if (quiet && held) startTransition(() => setValue(nextSelected));
        else setValue(nextSelected);
      }
    };

    // Catch-up: re-read state synchronously on mount before subscribing, so a
    // state change between the seeding render and this effect commit isn't
    // dropped until the next (debounced) notify. Mirrors usePathname /
    // useSearchParams.
    update();

    return ctx.eventController.subscribe(update);
  }, []);

  return value as T | PublicNavigationState;
}
