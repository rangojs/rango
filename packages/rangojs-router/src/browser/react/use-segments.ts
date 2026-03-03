"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { filterSegmentOrder } from "./filter-segment-order.js";
import { shallowEqual } from "./shallow-equal.js";

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
let ssrParams: Record<string, string> = {};

/**
 * Initialize segments data synchronously for SSR.
 * Called before rendering to populate state for useState initializer.
 *
 * @param matched - Segment order from RSC metadata
 * @param pathname - Current pathname
 * @param params - Merged route params
 */
export function initSegmentsSync(
  matched?: string[],
  pathname?: string,
  params?: Record<string, string>,
): void {
  ssrSegmentOrder = filterSegmentOrder(matched ?? []);
  ssrPathname = pathname ?? "/";
  ssrParams = params ?? {};
}

/**
 * Get SSR params for use-params hook initialization.
 */
export function getSsrParams(): Record<string, string> {
  return ssrParams;
}

/**
 * Get SSR pathname for use-pathname hook initialization.
 */
export function getSsrPathname(): string {
  return ssrPathname;
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
  segmentOrder: string[],
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
  selector?: (state: SegmentsState) => T,
): T | SegmentsState {
  const ctx = useContext(NavigationStoreContext);

  // Build initial state from SSR module state or event controller.
  // Inlined rather than calling recompute() because the segmentsCache
  // ref is not yet initialized during the useState initializer.
  const [state, setState] = useState<T | SegmentsState>(() => {
    if (typeof document === "undefined" || !ctx) {
      const ssrState = buildSsrState();
      return selector ? selector(ssrState) : ssrState;
    }
    const location = ctx.eventController.getLocation();
    const handleState = ctx.eventController.getHandleState();
    const segmentsState = buildSegmentsState(
      location as URL,
      handleState.segmentOrder,
    );
    return selector ? selector(segmentsState) : segmentsState;
  });

  const prevState = useRef(state);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Track selector identity to detect when the selector function changes.
  // Only then do we eagerly recompute during render to avoid staleness.
  // Without this guard, no-selector mode causes infinite re-renders because
  // buildSegmentsState creates fresh arrays that fail Object.is checks.
  const prevSelectorIdentity = useRef(selector);

  // Cache SegmentsState to stabilize nested references (path, segmentIds
  // arrays) so selectors returning composite values don't cause spurious
  // render-time setState calls.
  const segmentsCache = useRef<{
    location: URL;
    segmentOrder: string[];
    state: SegmentsState;
  } | null>(null);

  // Recompute selected value from current store state and apply selector.
  // Shared by the render-time eager check and the subscription callback.
  function recompute(
    sel: ((state: SegmentsState) => T) | undefined,
  ): T | SegmentsState {
    const location = ctx!.eventController.getLocation();
    const handleState = ctx!.eventController.getHandleState();

    // Reuse cached state when inputs haven't changed by reference,
    // keeping array/object references stable for composite selectors.
    const cache = segmentsCache.current;
    let segmentsState: SegmentsState;
    if (
      cache &&
      cache.location === location &&
      cache.segmentOrder === handleState.segmentOrder
    ) {
      segmentsState = cache.state;
    } else {
      segmentsState = buildSegmentsState(
        location as URL,
        handleState.segmentOrder,
      );
      segmentsCache.current = {
        location: location as URL,
        segmentOrder: handleState.segmentOrder,
        state: segmentsState,
      };
    }
    return sel ? sel(segmentsState) : segmentsState;
  }

  if (ctx && selector !== prevSelectorIdentity.current) {
    prevSelectorIdentity.current = selector;
    const nextSelected = recompute(selector);
    if (!shallowEqual(nextSelected, prevState.current)) {
      prevState.current = nextSelected;
      setState(nextSelected);
    }
  }

  // Subscribe to store changes. The eager block above handles selector
  // changes and SSR drift, so no initial updateState() call is needed.
  useEffect(() => {
    if (!ctx) {
      return;
    }

    const updateState = () => {
      const nextSelected = recompute(selectorRef.current);
      if (!shallowEqual(nextSelected, prevState.current)) {
        prevState.current = nextSelected;
        setState(nextSelected);
      }
    };

    const unsubscribeNav = ctx.eventController.subscribe(updateState);
    const unsubscribeHandles =
      ctx.eventController.subscribeToHandles(updateState);

    return () => {
      unsubscribeNav();
      unsubscribeHandles();
    };
    // Stable subscription: selector changes are handled via selectorRef,
    // state comparison uses prevState ref. No re-subscribe needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state as T | SegmentsState;
}
