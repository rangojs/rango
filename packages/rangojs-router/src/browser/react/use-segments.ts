"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";

/**
 * Segments state returned by useSegments hook
 */
export interface SegmentsState {
  /** URL path segments (e.g., /shop/products/123 → ["shop", "products", "123"]) */
  path: readonly string[];
  /** Matched segment IDs in order (layouts and routes only, e.g., ["L0", "L0L1", "L0L1R0"]) */
  segmentIds: readonly string[];
  /** Current URL location */
  location: URL;
}

/**
 * SSR module-level state.
 * Populated by initSegmentsSync before React renders.
 * Used by useState initializer during SSR.
 */
let ssrSegmentOrder: string[] = [];
let ssrPathname: string = "/";

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
 * Initialize segments data synchronously for SSR.
 * Called before rendering to populate state for useState initializer.
 *
 * @param matched - Segment order from RSC metadata
 * @param pathname - Current pathname
 */
export function initSegmentsSync(matched?: string[], pathname?: string): void {
  ssrSegmentOrder = filterSegmentOrder(matched ?? []);
  ssrPathname = pathname ?? "/";
}

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
 * Parse pathname into path segments
 * /shop/products/123 → ["shop", "products", "123"]
 */
function parsePathname(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * Build segments state from event controller
 */
function buildSegmentsState(
  location: URL,
  segmentOrder: string[]
): SegmentsState {
  return {
    path: parsePathname(location.pathname),
    segmentIds: segmentOrder,
    location,
  };
}

/**
 * Build SSR state from module-level variables
 */
function buildSsrState(): SegmentsState {
  const location = new URL(ssrPathname, "http://localhost");
  return {
    path: parsePathname(ssrPathname),
    segmentIds: ssrSegmentOrder,
    location,
  };
}

/**
 * Hook to access current route segments with optional selector for performance
 *
 * Provides information about the current URL path and matched route segments.
 * Uses the event controller for reactive state management.
 *
 * @example
 * ```tsx
 * // Get full segments state
 * const { path, segmentIds, location } = useSegments();
 *
 * // Use selector for specific values (better performance)
 * const path = useSegments(s => s.path);
 * const isShopRoute = useSegments(s => s.path[0] === "shop");
 * ```
 */
export function useSegments(): SegmentsState;
export function useSegments<T>(selector: (state: SegmentsState) => T): T;
export function useSegments<T>(
  selector?: (state: SegmentsState) => T
): T | SegmentsState {
  const ctx = useContext(NavigationStoreContext);

  // Build initial state from SSR module state or event controller
  const [state, setState] = useState<T | SegmentsState>(() => {
    // During SSR or when no context, use module-level SSR state
    if (typeof document === "undefined" || !ctx) {
      const ssrState = buildSsrState();
      return selector ? selector(ssrState) : ssrState;
    }
    // On client with context, use event controller state
    const navState = ctx.eventController.getState();
    const handleState = ctx.eventController.getHandleState();
    const segmentsState = buildSegmentsState(
      navState.location as URL,
      handleState.segmentOrder
    );
    return selector ? selector(segmentsState) : segmentsState;
  });

  const prevState = useRef(state);

  // Subscribe to both navigation state and handle state changes
  useEffect(() => {
    if (!ctx) {
      return;
    }

    const updateState = () => {
      const navState = ctx.eventController.getState();
      const handleState = ctx.eventController.getHandleState();
      const segmentsState = buildSegmentsState(
        navState.location as URL,
        handleState.segmentOrder
      );
      const nextSelected = selector ? selector(segmentsState) : segmentsState;

      if (!shallowEqual(nextSelected, prevState.current)) {
        prevState.current = nextSelected;
        setState(nextSelected);
      }
    };

    // Initial update in case SSR state differs from client state
    updateState();

    // Subscribe to both state sources
    const unsubscribeNav = ctx.eventController.subscribe(updateState);
    const unsubscribeHandles = ctx.eventController.subscribeToHandles(updateState);

    return () => {
      unsubscribeNav();
      unsubscribeHandles();
    };
  }, [selector]);

  return state as T | SegmentsState;
}
