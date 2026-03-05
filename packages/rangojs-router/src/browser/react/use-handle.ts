"use client";

import {
  useContext,
  useState,
  useEffect,
  useRef,
  useOptimistic,
  startTransition,
} from "react";
import type { Handle } from "../../handle.js";
import { getCollectFn } from "../../handle.js";
import type { HandleData } from "../types.js";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";

/**
 * Resolve the collect function for a handle.
 * Handle objects are plain { __brand, $$id } - collect is stored in the registry
 * (populated when createHandle runs on the client).
 */
function resolveCollect<T, A>(handle: Handle<T, A>): (segments: T[][]) => A {
  // Look up collect from the registry (populated when the handle module is imported).
  const registered = getCollectFn(handle.$$id);
  if (registered) {
    return registered as (segments: T[][]) => A;
  }

  // Fall back to default flat collect with a dev warning.
  if (process.env.NODE_ENV !== "production") {
    console.warn(
      `[rsc-router] Handle "${handle.$$id}" was passed as a prop but its collect ` +
        `function could not be resolved. Falling back to flat array. ` +
        `Import the handle module in a client component to register its collect function.`,
    );
  }
  return ((segments: unknown[][]) => segments.flat()) as unknown as (
    segments: T[][],
  ) => A;
}

/**
 * Collect handle data from segments and transform to final value.
 */
function collectHandle<T, A>(
  handle: Handle<T, A>,
  data: HandleData,
  segmentOrder: string[],
): A {
  const collect = resolveCollect(handle);
  const segmentData = data[handle.$$id];

  if (!segmentData) {
    return collect([]);
  }

  // Build array of segment arrays in parent -> child order
  const segmentArrays: T[][] = [];
  for (const segmentId of segmentOrder) {
    const entries = segmentData[segmentId];
    if (entries && entries.length > 0) {
      segmentArrays.push(entries as T[]);
    }
  }

  // Call collect once with all segment data
  return collect(segmentArrays);
}

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
export function useHandle<T, A>(handle: Handle<T, A>): A;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector: (data: A) => S,
): S;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector?: (data: A) => S,
): A | S {
  const ctx = useContext(NavigationStoreContext);

  // Initial state from context event controller, or empty fallback without provider.
  const [value, setValue] = useState<A | S>(() => {
    if (!ctx) {
      const collected = collectHandle(handle, {}, []);
      return selector ? selector(collected) : collected;
    }

    // On client, use event controller state
    const state = ctx.eventController.getHandleState();
    const collected = collectHandle(handle, state.data, state.segmentOrder);
    return selector ? selector(collected) : collected;
  });
  const [optimisticValue, setOptimisticValue] = useOptimistic(value);

  // Track previous value for shallow comparison
  const prevValueRef = useRef(value);
  prevValueRef.current = value;

  // Ref keeps the latest selector without re-subscribing on every render.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to handle data changes (client only)
  useEffect(() => {
    if (!ctx) return;

    // Sync current state for the (possibly new) handle so that switching
    // handles on an idle page doesn't leave stale data from the old handle.
    const currentHandleState = ctx.eventController.getHandleState();
    const currentCollected = collectHandle(
      handle,
      currentHandleState.data,
      currentHandleState.segmentOrder,
    );
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
      const collected = collectHandle(handle, state.data, state.segmentOrder);
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
