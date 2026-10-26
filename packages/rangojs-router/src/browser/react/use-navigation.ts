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

/** A value of the hook, the state it was selected from, and its set's number. */
interface Snapshot<T> {
  state: PublicNavigationState;
  value: T;
  seq: number;
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

  const [snapshot, setSnapshot] = useState<Snapshot<T | PublicNavigationState>>(
    () => {
      const state = toPublicState(
        ctx.eventController.getHydrationSnapshot()?.state ??
          ctx.eventController.getState(),
      );
      return { state, value: selector ? selector(state) : state, seq: 0 };
    },
  );
  // The last value set, and the value on screen. The screen's lags while
  // React holds a set, or shows a location a held set has moved past.
  const latest = useRef(snapshot);
  const onScreen = useRef(snapshot);
  useLayoutEffect(() => {
    onScreen.current = snapshot;
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
    const select = (state: PublicNavigationState) =>
      selectorRef.current ? selectorRef.current(state) : state;
    const update = (signal?: RouteStateSignal) => {
      const currentState = ctx.eventController.getState();
      const moved = currentState.location !== last?.location;
      // Only isStreaming or isNavigating changed, or pendingUrl cleared: no
      // newer request. While a value of this hook's is held, a transition,
      // which React entangles with it, so it never commits ahead of the
      // location. Otherwise urgent: a transition of its own would start a
      // view transition, and could commit ahead of a held page and take its
      // transition types. A newer click's pendingUrl is work starting, shown
      // at once even while the state already reads loading (an action in
      // flight).
      const quiet =
        !moved &&
        currentState.state === last?.state &&
        (currentState.pendingUrl ?? last.pendingUrl) === last.pendingUrl;
      // idle is the page's. While one is held, idle from an action that
      // settles or a newer navigation that ends with no page would commit
      // urgently over the page being left, with its URL (#1164's chips come
      // back): it waits, and the page's release brings it in the commit's
      // task. Work that starts (loading, a newer pendingUrl) shows at once.
      if (signal) pageHeld = signal === "anchor";
      else if (pageHeld && !quiet && currentState.state === "idle") return;
      last = currentState;
      const state = toPublicState(currentState);
      const value = select(state);
      const prev = latest.current;
      if (shallowEqual(value, prev.value)) return;

      const screen = onScreen.current;
      const held =
        screen.seq !== prev.seq ||
        screen.state.location !== prev.state.location;
      const next = { state, value, seq: prev.seq + 1 };
      latest.current = next;
      if (held && quiet) startTransition(() => setSnapshot(next));
      else if (held && !moved) {
        // location is the page on screen until the next page shows. This
        // update did not move it: the location a held set brings (a held
        // page's) is not on screen, so the value keeps the location of the
        // one it replaces in React's queue: the screen's when it renders
        // urgently, the held page's when React rebases it onto that page.
        setSnapshot((base) => {
          const kept = { ...state, location: base.state.location };
          return { state: kept, value: select(kept), seq: next.seq };
        });
      } else setSnapshot(next);
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
