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
import type {
  DerivedNavigationState,
  RouteStateSignal,
} from "../event-controller.js";

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
    // A page handed to React in a transition is held: from its
    // flushRouteState("anchor") to its release (useCommitAnchoredState).
    let pageHeld = false;
    const update = (signal?: RouteStateSignal) => {
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
      // idle is the page's. While one is held, idle from an action that
      // settles or a newer navigation that ends with no page would commit
      // urgently over the page being left, with its URL (#1164's chips come
      // back): it waits, and the page's release brings it in the commit's
      // task. Work that starts (loading, a newer pendingUrl) shows at once.
      if (signal) pageHeld = signal === "anchor";
      else if (pageHeld && !quiet && currentState.state === "idle") return;
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

    const unsubscribe = ctx.eventController.subscribe(update);
    // The anchor and release signals ride the handle channel.
    const unsubscribeSignals = ctx.eventController.subscribeToHandles(update);
    return () => {
      unsubscribe();
      unsubscribeSignals();
    };
  }, []);

  return value as T | PublicNavigationState;
}
