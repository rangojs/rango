"use client";

import { useSyncExternalStore, useCallback, useRef } from "react";
import type { Handle } from "../../handle.js";
import type { HandleData } from "../types.js";

/**
 * Internal state for a handle
 */
interface HandleState<A = unknown> {
  reduced: A;
  listeners: Set<() => void>;
}

/**
 * Single WeakMap storing both reduced values and listeners per handle.
 * When a Handle is GC'd, its state is automatically cleaned up.
 */
const handleState = new WeakMap<Handle<any, any>, HandleState>();

/**
 * Raw handle data from the latest RSC payload (before reduction).
 * Keyed by handle name since we receive data before we have Handle references.
 */
let rawHandleData: HandleData = {};

/**
 * Segment order from the latest RSC payload (for parent → child reduction).
 */
let segmentOrder: string[] = [];

/**
 * Get or create state for a handle.
 */
function getState<T, A>(handle: Handle<T, A>): HandleState<A> {
  let state = handleState.get(handle);
  if (!state) {
    state = {
      reduced: handle.defaultValue,
      listeners: new Set(),
    };
    handleState.set(handle, state);

    // If we have raw data for this handle, reduce it now
    reduceHandleData(handle);
  }
  return state as HandleState<A>;
}

/**
 * Notify all listeners for a handle that data has changed.
 */
function notifyListeners(handle: Handle<any, any>): void {
  const state = handleState.get(handle);
  if (state) {
    state.listeners.forEach((listener) => listener());
  }
}

/**
 * Reduce raw handle data for a specific handle.
 * Awaits any promises in the data before reducing.
 */
async function reduceHandleData<T, A>(handle: Handle<T, A>): Promise<void> {
  const state = getState(handle);
  const segmentData = rawHandleData[handle.name];

  if (!segmentData) {
    // No data for this handle - use default
    if (state.reduced !== handle.defaultValue) {
      state.reduced = handle.defaultValue;
      notifyListeners(handle);
    }
    return;
  }

  // Collect entries in segment order (parent → child)
  // Only include data from segments in the current matched route
  const orderedEntries: unknown[] = [];

  for (const segmentId of segmentOrder) {
    const entries = segmentData[segmentId];
    if (entries) {
      orderedEntries.push(...entries);
    }
  }

  // Await all promises in entries
  const resolvedEntries = await Promise.all(
    orderedEntries.map((entry) =>
      entry instanceof Promise ? entry : Promise.resolve(entry)
    )
  );

  // Run reducer across all entries
  let accumulated = handle.defaultValue;
  for (const entry of resolvedEntries) {
    accumulated = handle.reducer(accumulated, entry as T);
  }

  // Update state and notify
  state.reduced = accumulated;
  notifyListeners(handle);
}

/**
 * Registry of handles that have been used (for updating when new data arrives).
 * WeakSet allows handles to be GC'd when no longer referenced.
 */
const registeredHandles = new Set<Handle<any, any>>();

/**
 * Update handle data from RSC payload.
 * Called by NavigationProvider when new payload arrives.
 *
 * @param data - Raw handle data from RSC payload (already awaited from Promise<HandleData>)
 * @param matched - Segment order for parent → child reduction
 * @param isPartial - If true, merge with existing data instead of replacing
 */
export async function updateHandleData(
  data: HandleData,
  matched?: string[],
  isPartial?: boolean
): Promise<void> {
  // Filter matched segments to only include routes and layouts
  // Exclude parallels (contain .@) and loaders (contain D followed by digit)
  const newSegmentOrder = (matched ?? []).filter((id) => {
    // Exclude parallels (e.g., "M1L0L0.@sidebar")
    if (id.includes(".@")) return false;
    // Exclude loaders (e.g., "M1L0D0.user")
    if (/D\d+\./.test(id)) return false;
    return true;
  });

  if (isPartial && newSegmentOrder.length > 0) {
    // Partial update: merge new data with existing
    // Only update segments that are in the new data
    for (const handleName of Object.keys(data)) {
      if (!rawHandleData[handleName]) {
        rawHandleData[handleName] = {};
      }
      for (const segmentId of Object.keys(data[handleName])) {
        rawHandleData[handleName][segmentId] = data[handleName][segmentId];
      }
    }
    // Clean up data from segments no longer in the matched list
    for (const handleName of Object.keys(rawHandleData)) {
      for (const segmentId of Object.keys(rawHandleData[handleName])) {
        if (!newSegmentOrder.includes(segmentId)) {
          delete rawHandleData[handleName][segmentId];
        }
      }
    }
  } else {
    // Full update: replace all data
    rawHandleData = data;
  }
  segmentOrder = newSegmentOrder;

  // Re-reduce all registered handles
  const reductionPromises: Promise<void>[] = [];
  for (const handle of registeredHandles) {
    reductionPromises.push(reduceHandleData(handle));
  }
  await Promise.all(reductionPromises);
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
 * Hook to access accumulated handle data.
 *
 * Returns the reduced value from all route segments that pushed to this handle.
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
  // Register handle for updates
  registeredHandles.add(handle);

  // Track previous selected value for shallow comparison
  const prevSelectedRef = useRef<A | S | undefined>(undefined);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const state = getState(handle);
      state.listeners.add(onStoreChange);
      return () => {
        state.listeners.delete(onStoreChange);
      };
    },
    [handle]
  );

  const getSnapshot = useCallback(() => {
    const state = getState(handle);
    const value = selector ? selector(state.reduced) : state.reduced;

    // Use shallow equality to prevent unnecessary re-renders with selectors
    if (selector && prevSelectedRef.current !== undefined) {
      if (shallowEqual(value, prevSelectedRef.current)) {
        return prevSelectedRef.current;
      }
    }

    prevSelectedRef.current = value;
    return value;
  }, [handle, selector]);

  const getServerSnapshot = useCallback(() => {
    // On server, return default value (handles are client-side only)
    return selector ? selector(handle.defaultValue) : handle.defaultValue;
  }, [handle, selector]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
