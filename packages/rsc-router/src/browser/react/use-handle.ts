"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext, SSRHandleContext } from "./context.js";
import type { Handle } from "../../handle.js";

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
 * Array equality check for matched segment IDs
 */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Cache entry for accumulated handle data
 * Tracks subscribers to clear cache when all unmount
 */
interface HandleCacheEntry {
  subscribers: Set<object>;
  matchedSegmentIds: string[];
  entriesRef: Record<string, unknown[]> | undefined;
  result: unknown;
}

/**
 * Module-level cache for accumulated handle data
 * Keyed by handle name, cleared when all subscribers unmount
 */
const handleCache = new Map<string, HandleCacheEntry>();

/**
 * Get or compute accumulated handle data with caching
 * Reducer runs once per handle per navigation state, shared across all useHandle calls
 */
function getAccumulatedHandleData<TData, TAccumulated>(
  handle: Handle<TData, TAccumulated>,
  entriesBySegment: Record<string, unknown[]> | undefined,
  matchedSegmentIds: string[]
): TAccumulated {
  const cached = handleCache.get(handle.handleName);

  // Check if cache is valid (same entries reference and matched segments)
  if (
    cached &&
    cached.entriesRef === entriesBySegment &&
    arraysEqual(cached.matchedSegmentIds, matchedSegmentIds)
  ) {
    return cached.result as TAccumulated;
  }

  // Compute accumulated value
  const result = accumulateHandleData(handle, entriesBySegment, matchedSegmentIds);

  // Update cache (preserve subscribers if entry exists)
  if (cached) {
    cached.matchedSegmentIds = matchedSegmentIds;
    cached.entriesRef = entriesBySegment;
    cached.result = result;
  }

  return result;
}

/**
 * Accumulate handle data from per-segment entries
 * Collects entries from matched segments in order and runs the reducer
 */
function accumulateHandleData<TData, TAccumulated>(
  handle: Handle<TData, TAccumulated>,
  entriesBySegment: Record<string, unknown[]> | undefined,
  matchedSegmentIds: string[]
): TAccumulated {
  if (!entriesBySegment) {
    return handle.defaultValue;
  }

  // Collect all entries from matched segments in order (layouts first, then routes)
  const allEntries: TData[] = [];
  for (const segmentId of matchedSegmentIds) {
    const segmentEntries = entriesBySegment[segmentId];
    if (segmentEntries) {
      allEntries.push(...(segmentEntries as TData[]));
    }
  }

  // Run reducer to accumulate
  let result = handle.defaultValue;
  for (const entry of allEntries) {
    result = handle.reducer(result, entry);
  }

  return result;
}

/**
 * Hook to read handle data from the server
 *
 * Handles are created with createHandle() and populated during server render
 * from loaders, middleware, handlers, or server components. This hook collects
 * entries from matched segments and runs the handle's reducer to accumulate data.
 * Updates reactively on navigation.
 *
 * @param handle - The handle created with createHandle()
 * @param selector - Optional selector to transform/select specific data
 * @returns The accumulated handle data, or selected value if selector provided
 *
 * @example
 * ```tsx
 * // Basic usage - returns accumulated data
 * const breadcrumbs = useHandle(breadcrumbsHandle);
 *
 * // With selector - returns transformed/selected data
 * const lastCrumb = useHandle(breadcrumbsHandle, crumbs => crumbs[crumbs.length - 1]);
 *
 * // With permissions handle using custom reducer
 * const permissions = useHandle(permissionsHandle);
 * const canEdit = useHandle(permissionsHandle, perms => perms.includes('edit'));
 * ```
 */
export function useHandle<TData, TAccumulated>(
  handle: Handle<TData, TAccumulated>
): TAccumulated;
export function useHandle<TData, TAccumulated, TSelected>(
  handle: Handle<TData, TAccumulated>,
  selector: (accumulated: TAccumulated) => TSelected
): TSelected;
export function useHandle<TData, TAccumulated, TSelected>(
  handle: Handle<TData, TAccumulated>,
  selector?: (accumulated: TAccumulated) => TSelected
): TAccumulated | TSelected {
  const ctx = useContext(NavigationStoreContext);
  const ssrCtx = useContext(SSRHandleContext);
  const subscriberRef = useRef<object>({});

  // Register subscriber and manage cache lifecycle
  useEffect(() => {
    let entry = handleCache.get(handle.handleName);
    if (!entry) {
      entry = {
        subscribers: new Set(),
        matchedSegmentIds: [],
        entriesRef: undefined,
        result: handle.defaultValue,
      };
      handleCache.set(handle.handleName, entry);
    }
    entry.subscribers.add(subscriberRef.current);

    return () => {
      entry!.subscribers.delete(subscriberRef.current);
      // Clear cache when all subscribers unmount
      if (entry!.subscribers.size === 0) {
        handleCache.delete(handle.handleName);
      }
    };
  }, [handle.handleName, handle.defaultValue]);

  // Get accumulated value (cached or computed)
  const getAccumulatedValue = (): TAccumulated => {
    // During SSR, use SSR context if available
    if (ssrCtx) {
      const entriesBySegment = ssrCtx.handleEntries[handle.handleName];
      return getAccumulatedHandleData(handle, entriesBySegment, ssrCtx.matchedSegmentIds);
    }

    // On client, use navigation store context
    if (!ctx) {
      return handle.defaultValue;
    }

    const allEntries = ctx.store.getHandleEntries();
    const matchedSegmentIds = ctx.store.getMatchedSegmentIds();
    const entriesBySegment = allEntries[handle.handleName];

    return getAccumulatedHandleData(handle, entriesBySegment, matchedSegmentIds);
  };

  // Compute current value (with optional selector)
  const getCurrentValue = (): TAccumulated | TSelected => {
    const accumulated = getAccumulatedValue();
    return selector ? selector(accumulated) : accumulated;
  };

  const [value, setValue] = useState(getCurrentValue);
  const prevValue = useRef(value);

  // Subscribe to store updates
  useEffect(() => {
    if (!ctx) return;

    return ctx.store.subscribe(() => {
      const nextValue = getCurrentValue();

      // Only update if value changed (using shallow equality for objects)
      if (!shallowEqual(nextValue, prevValue.current)) {
        prevValue.current = nextValue;
        setValue(nextValue);
      }
    });
  }, [handle.handleName, selector]);

  return value;
}
