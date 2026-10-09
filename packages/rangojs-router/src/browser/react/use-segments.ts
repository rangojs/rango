"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
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
 * Parse pathname into path segments
 * /shop/products/123 → ["shop", "products", "123"]
 */
function parsePathname(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * Build segments state from event controller. `segmentIds` is the
 * route-only list (parallels and loaders stripped) — distinct from the
 * controller's `segmentOrder` which drives handle collection and includes
 * parallel slot ids.
 */
function buildSegmentsState(
  location: URL,
  routeSegmentIds: string[],
): SegmentsState {
  return {
    path: parsePathname(location.pathname),
    segmentIds: routeSegmentIds,
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

  // The selector is applied when the store changes, never during render, as in
  // useNavigation and useAction: the hook renders its own state only. A new
  // selector identity is not a reactive input; it applies from the next store
  // change.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const [state, setState] = useState<T | SegmentsState>(() => {
    if (!ctx) {
      const fallbackLocation = new URL("/", "http://localhost");
      const fallbackState = buildSegmentsState(fallbackLocation, []);
      return selector ? selector(fallbackState) : fallbackState;
    }
    const location = ctx.eventController.getLocation();
    const handleState = ctx.eventController.getHandleState();
    const segmentsState = buildSegmentsState(
      location as URL,
      handleState.routeSegmentIds,
    );
    return selector ? selector(segmentsState) : segmentsState;
  });

  const prevState = useRef(state);

  useEffect(() => {
    if (!ctx) {
      return;
    }

    // Reused while the location and route segments are unchanged, so a
    // selector returning part of it keeps the same references.
    let cache: {
      location: URL;
      routeSegmentIds: string[];
      state: SegmentsState;
    } | null = null;

    const updateState = () => {
      const location = ctx.eventController.getLocation() as URL;
      const { routeSegmentIds } = ctx.eventController.getHandleState();
      if (
        !cache ||
        cache.location !== location ||
        cache.routeSegmentIds !== routeSegmentIds
      ) {
        cache = {
          location,
          routeSegmentIds,
          state: buildSegmentsState(location, routeSegmentIds),
        };
      }
      const sel = selectorRef.current;
      const nextSelected = sel ? sel(cache.state) : cache.state;
      if (!shallowEqual(nextSelected, prevState.current)) {
        prevState.current = nextSelected;
        setState(nextSelected);
      }
    };

    // Catch up with a change between the seeding render and this effect.
    updateState();

    const unsubscribeNav = ctx.eventController.subscribe(updateState);
    const unsubscribeHandles =
      ctx.eventController.subscribeToHandles(updateState);

    return () => {
      unsubscribeNav();
      unsubscribeHandles();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state as T | SegmentsState;
}
