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
import type { HandleData } from "../types.js";
import { NavigationStoreContext } from "./context.js";

/**
 * SSR module-level state.
 * Populated by initHandleDataSync before React renders.
 * Used by useState initializer during SSR.
 */
let ssrHandleData: HandleData = {};
let ssrSegmentOrder: string[] = [];

/**
 * Filter segment IDs to only include routes and layouts.
 * Excludes parallels (contain .@) and loaders (contain D followed by digit).
 */
function filterSegmentOrder(matched: string[]): string[] {
  return matched.filter((id) => {
    if (id.includes(".@")) return false;
    if (/D\d+\./.test(id)) return false;
    return true;
  });
}

/**
 * Collect handle data from segments and transform to final value.
 */
function collectHandle<T, A>(
  handle: Handle<T, A>,
  data: HandleData,
  segmentOrder: string[]
): A {
  const segmentData = data[handle.name];

  if (!segmentData) {
    return handle.collect([]);
  }

  // Build array of segment arrays in parent → child order
  const segmentArrays: T[][] = [];
  for (const segmentId of segmentOrder) {
    const entries = segmentData[segmentId];
    if (entries && entries.length > 0) {
      segmentArrays.push(entries as T[]);
    }
  }

  // Call collect once with all segment data
  return handle.collect(segmentArrays);
}

/**
 * Shallow equality check for selector results.
 */
function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is((a as any)[key], (b as any)[key])
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Initialize handle data synchronously for SSR.
 * Called before rendering to populate state for useState initializer.
 *
 * @param data - Handle data from RSC payload
 * @param matched - Segment order for reduction
 */
export function initHandleDataSync(data: HandleData, matched?: string[]): void {
  ssrHandleData = data;
  ssrSegmentOrder = filterSegmentOrder(matched ?? []);
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
  selector: (data: A) => S
): S;
export function useHandle<T, A, S>(
  handle: Handle<T, A>,
  selector?: (data: A) => S
): A | S {
  const ctx = useContext(NavigationStoreContext);

  // Initial state from SSR module state or event controller
  const [value, setValue] = useState<A | S>(() => {
    // During SSR, use module-level state
    if (typeof document === "undefined" || !ctx) {
      const collected = collectHandle(handle, ssrHandleData, ssrSegmentOrder);
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

  // Memoize selector ref
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to handle data changes (client only)
  useEffect(() => {
    if (!ctx) return;

    return ctx.eventController.subscribeToHandles(() => {
      const state = ctx.eventController.getHandleState();
      const collected = collectHandle(handle, state.data, state.segmentOrder);
      const nextValue = selectorRef.current
        ? selectorRef.current(collected)
        : collected;

      if (!shallowEqual(nextValue, prevValueRef.current)) {
        prevValueRef.current = nextValue;
        startTransition(() => {
          setOptimisticValue(nextValue);
        });
        setValue(nextValue);
      }
    });
  }, [handle]);

  return optimisticValue;
}
