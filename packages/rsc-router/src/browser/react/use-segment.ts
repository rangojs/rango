"use client";

import { useContext, useState, useEffect, useEffectEvent, useReducer } from "react";
import { SegmentStoreContext } from "./segment-context.js";
import type { SegmentStore, SegmentSelector } from "../segment-store.js";
import type { ResolvedSegment } from "../../types.js";

/**
 * Shallow equality check for selector results
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
 * Hook that forces a re-render when notified
 * Used by outlets that need to re-render when structure changes
 */
export function useSegmentNotification(segmentId: string): void {
  const store = useContext(SegmentStoreContext);
  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  useEffect(() => {
    if (!store) return;

    // Subscribe to this segment - always force update when notified
    return store.subscribe(segmentId, () => {
      forceUpdate();
    });
  }, [segmentId, store]);
}

// SSR-safe default segment
const SSR_DEFAULT_SEGMENT: ResolvedSegment = {
  id: "",
  namespace: "",
  type: "route",
  index: 0,
  component: null,
};

/**
 * Hook to subscribe to a specific segment with optional selector
 *
 * This hook subscribes to changes for a specific segment ID. When that segment
 * updates in the store, only components using this hook with that ID will re-render.
 *
 * Use selectors to derive specific data and prevent re-renders when unrelated
 * parts of the segment change.
 *
 * @param segmentId - The ID of the segment to subscribe to
 * @param selector - Optional function to derive a value from the segment
 * @returns The segment or derived value
 *
 * @example
 * ```tsx
 * // Subscribe to whole segment
 * const segment = useSegment('L0R1');
 *
 * // Subscribe with selector (only re-renders when component changes)
 * const component = useSegment('L0R1', (s) => s.component);
 *
 * // Get loader data
 * const loaderData = useSegment('L0R1', (s) => s.loaderData);
 * ```
 */
export function useSegment(segmentId: string): ResolvedSegment;
export function useSegment<T>(
  segmentId: string,
  selector: SegmentSelector<T>
): T;
export function useSegment<T>(
  segmentId: string,
  selector?: SegmentSelector<T>
): T | ResolvedSegment {
  const store = useContext(SegmentStoreContext);

  // Initialize with SSR-safe default
  const [value, setValue] = useState<T | ResolvedSegment>(() => {
    if (typeof document === "undefined" || !store) {
      return selector ? selector(SSR_DEFAULT_SEGMENT) : SSR_DEFAULT_SEGMENT;
    }
    const segment = store.get(segmentId);
    if (!segment) {
      return selector ? selector(SSR_DEFAULT_SEGMENT) : SSR_DEFAULT_SEGMENT;
    }
    return selector ? selector(segment) : segment;
  });

  const isSameValue = useEffectEvent((newValue: unknown) => {
    return shallowEqual(value, newValue);
  });

  // Subscribe to segment changes (only runs on client)
  useEffect(() => {
    if (!store) return;

    // Sync immediately in case segment changed between render and effect
    const current = store.get(segmentId);
    if (current) {
      const selected = selector ? selector(current) : current;
      if (!isSameValue(selected)) {
        setValue(selected);
      }
    }

    // Subscribe to this specific segment
    return store.subscribe(segmentId, () => {
      const next = store.get(segmentId);
      if (!next) return;

      const nextSelected = selector ? selector(next) : next;

      // Skip update if value hasn't changed
      if (isSameValue(nextSelected)) {
        return;
      }

      setValue(nextSelected);
    });
  }, [segmentId, selector]);

  return value;
}

/**
 * Hook to get the segment store directly
 *
 * Use this when you need to access multiple segments or perform
 * operations on the store itself.
 *
 * @example
 * ```tsx
 * const store = useSegmentStore();
 * const childSegment = store.getChildSegment('L0');
 * const { parallels, loaders } = store.getChildren('L0R1');
 * ```
 */
export function useSegmentStore(): SegmentStore {
  const store = useContext(SegmentStoreContext);
  if (!store) {
    throw new Error(
      "useSegmentStore must be used within a SegmentStoreProvider"
    );
  }
  return store;
}
