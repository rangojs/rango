"use client";

import {
  useContext,
  useState,
  useEffect,
  useOptimistic,
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

  const [baseValue, setBaseValue] = useState<T | PublicNavigationState>(() => {
    const publicState = toPublicState(ctx.eventController.getState());
    return selector ? selector(publicState) : publicState;
  });
  const prevState = useRef(baseValue);

  // Tracks whether the most recent setOptimisticValue call pinned the value
  // to a non-idle state. Used to decide whether to emit a release update when
  // returning to idle, so the optimistic store doesn't stay pinned if a
  // parent transition (e.g. <Link> click) is still pending.
  const optimisticPinnedRef = useRef(false);

  const [value, setOptimisticValue] = useOptimistic(baseValue);

  // Store selector in a ref so the subscription callback always uses the
  // latest selector without re-subscribing on every render (inline functions
  // have a new identity each render). This is event-driven by design: the
  // value updates when the store emits, not when the selector changes.
  // Between events there is nothing new to select from.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to event controller state changes (only runs on client)
  useEffect(() => {
    const update = () => {
      const currentState = ctx.eventController.getState();
      const publicState = toPublicState(currentState);
      const nextSelected = selectorRef.current
        ? selectorRef.current(publicState)
        : publicState;

      // Check if selected value has changed
      if (!shallowEqual(nextSelected, prevState.current)) {
        prevState.current = nextSelected;

        // Check if any actions are in progress for optimistic updates
        const hasInflightActions =
          ctx.eventController.getInflightActions().size > 0;

        const shouldPin = hasInflightActions || publicState.state !== "idle";

        if (shouldPin) {
          // Pin the optimistic store so the loading value shows immediately
          // even if a parent transition (e.g. <Link> click) defers the
          // urgent setBaseValue commit.
          startTransition(() => {
            setOptimisticValue(nextSelected);
          });
          optimisticPinnedRef.current = true;
        } else if (optimisticPinnedRef.current) {
          // Release a previously-pinned optimistic value. Without this,
          // useOptimistic keeps returning the stale loading value while
          // any parent transition is still pending, even after baseValue
          // flipped to idle.
          startTransition(() => {
            setOptimisticValue(nextSelected);
          });
          optimisticPinnedRef.current = false;
        }

        // Always update base state so UI reflects current state
        setBaseValue(nextSelected);
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
