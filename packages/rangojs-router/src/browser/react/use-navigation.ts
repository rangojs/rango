"use client";

import { useContext, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";
import { useRouteState } from "./use-route-state.js";
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

/** The state a value was selected from, and the value. */
interface Snapshot<T> {
  state: PublicNavigationState;
  value: T;
}

/**
 * A notification while React holds a page: work that starts shows at once
 * (loading, streaming, a newer click's URL), what settles waits for the
 * page's commit, and location moves only with the notification
 * that moves it (the page on screen until the next one shows).
 */
function hold(
  base: PublicNavigationState,
  live: PublicNavigationState,
  moved: boolean,
): PublicNavigationState {
  return {
    state: live.state === "loading" ? live.state : base.state,
    isStreaming: live.isStreaming || base.isStreaming,
    isNavigating: live.isNavigating || base.isNavigating,
    pendingUrl: live.pendingUrl ?? base.pendingUrl,
    location: moved ? live.location : base.location,
  };
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

  // A release is compared with the state React renders it on
  // (useRouteState). The anchor is compared with the last set, as an
  // ordinary notification is: it sets inside its page's transition, which
  // renders every set so far.
  const [snapshot, set] = useRouteState<Snapshot<T | PublicNavigationState>>(
    () => {
      const state = toPublicState(
        ctx.eventController.getHydrationSnapshot()?.state ??
          ctx.eventController.getState(),
      );
      return { state, value: selector ? selector(state) : state };
    },
    (a, b) => shallowEqual(a.value, b.value),
  );

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
  // useParams). From that page's anchor to its release every other
  // notification goes through hold(), urgently, so React rebases the same
  // update onto the page when it commits. Never a transition of its own.
  useEffect(() => {
    let pageHeld = false;
    let location: PublicNavigationState["location"] | undefined;
    const select = (state: PublicNavigationState) =>
      selectorRef.current ? selectorRef.current(state) : state;
    const update = (signal?: RouteStateSignal) => {
      if (signal) pageHeld = signal === "anchor";
      const live = toPublicState(ctx.eventController.getState());
      const moved = live.location !== location;
      location = live.location;
      const held = pageHeld && !signal;
      set(
        (base) => {
          const state = held ? hold(base.state, live, moved) : live;
          return { state, value: select(state) };
        },
        signal,
        held,
      );
    };

    // Catch-up: re-read state synchronously on mount before subscribing, so a
    // state change between the seeding render and this effect commit isn't
    // dropped until the next (debounced) notify. Mirrors usePathname /
    // useSearchParams.
    update();

    const unsubscribe = ctx.eventController.subscribe(update);
    // The anchor and release signals ride the handle channel. One without a
    // signal re-reads the same state, as the state channel's own would.
    const unsubscribeSignals = ctx.eventController.subscribeToHandles(update);
    return () => {
      unsubscribe();
      unsubscribeSignals();
    };
  }, []);

  return snapshot.value as T | PublicNavigationState;
}
