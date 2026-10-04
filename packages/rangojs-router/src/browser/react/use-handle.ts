"use client";

import {
  useContext,
  useState,
  useEffect,
  useRef,
  useOptimistic,
  useSyncExternalStore,
  startTransition,
} from "react";
import type { Handle } from "../../handle.js";
import { collectHandleData } from "../../handle.js";
import type { HandleData } from "../types.js";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";
import { subscribeToNothing } from "./subscribe-to-nothing.js";

const noHydrationState = (): undefined => undefined;

/**
 * Hook to access collected handle data.
 *
 * Returns the collected value from all route segments that pushed to this handle.
 * Re-renders when handle data changes (navigation, actions).
 *
 * @param handle - The handle to read
 * @param selector - Optional selector for performance (only re-render when selected value changes)
 *
 * @example
 * ```tsx
 * // Get all breadcrumbs
 * const breadcrumbs = useHandle(Breadcrumbs);
 *
 * // With selector - only re-render when last crumb changes
 * const lastCrumb = useHandle(Breadcrumbs, (data) => data.at(-1));
 * ```
 */
export function useHandle<T, A>(handle: Handle<T, A>): Rango.FlightSerialize<A>;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector: (data: Rango.FlightSerialize<A>) => S,
): S;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector?: (data: Rango.FlightSerialize<A>) => S,
): Rango.FlightSerialize<A> | S {
  const ctx = useContext(NavigationStoreContext);

  // useSyncExternalStore only for its server snapshot, as useLocationState
  // (#992): no other hook tells a hydrating render from a client one. A
  // hydrating render gets the handle state the document's HTML was rendered
  // with (EventController.getHydrationHandleState), whenever its boundary
  // hydrates; the mount effect below moves it on to the live state. That
  // state is undefined while the live state is still it, and the client
  // snapshot is always undefined: a reader that hydrated before anything
  // arrived late is not rendered again, and to React the store never
  // changes (issue #1035).
  const hydrationState = useSyncExternalStore(
    subscribeToNothing,
    noHydrationState,
    () => ctx?.eventController.getHydrationHandleState(),
  );

  const [value, setValue] = useState<Rango.FlightSerialize<A> | S>(() => {
    if (!ctx) {
      const collected = collectHandleData(
        handle,
        {},
        [],
      ) as Rango.FlightSerialize<A>;
      return selector ? selector(collected) : collected;
    }

    const state = hydrationState ?? ctx.eventController.getHandleState();
    const collected = collectHandleData(
      handle,
      state.data,
      state.segmentOrder,
    ) as Rango.FlightSerialize<A>;
    return selector ? selector(collected) : collected;
  });
  const [optimisticValue, setOptimisticValue] = useOptimistic(value);

  const prevValueRef = useRef(value);
  prevValueRef.current = value;

  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  useEffect(() => {
    if (!ctx) return;

    // Sync current state for the (possibly new) handle so that switching
    // handles on an idle page doesn't leave stale data from the old handle.
    const currentHandleState = ctx.eventController.getHandleState();
    const currentCollected = collectHandleData(
      handle,
      currentHandleState.data,
      currentHandleState.segmentOrder,
    ) as Rango.FlightSerialize<A>;
    const currentValue = selectorRef.current
      ? selectorRef.current(currentCollected)
      : currentCollected;
    if (!shallowEqual(currentValue, prevValueRef.current)) {
      prevValueRef.current = currentValue;
      setValue(currentValue);
    }

    return ctx.eventController.subscribeToHandles(() => {
      const state = ctx.eventController.getHandleState();
      const isAction =
        ctx.eventController.getState().inflightActions.length > 0;
      const collected = collectHandleData(
        handle,
        state.data,
        state.segmentOrder,
      ) as Rango.FlightSerialize<A>;
      const nextValue = selectorRef.current
        ? selectorRef.current(collected)
        : collected;

      if (!shallowEqual(nextValue, prevValueRef.current)) {
        prevValueRef.current = nextValue;
        startTransition(() => {
          // Skip optimistic update during actions to prevent Suspense fallback
          if (!isAction) setOptimisticValue(nextValue);
          setValue(nextValue);
        });
      }
    });
  }, [handle]);

  return optimisticValue;
}
