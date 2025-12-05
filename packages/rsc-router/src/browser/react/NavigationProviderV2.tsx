"use client";

import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  use,
  type ReactNode,
} from "react";
import {
  NavigationStoreContext,
  type NavigationStoreContextValue,
} from "./context.js";
import { SegmentStoreContext } from "./segment-context.js";
import type {
  NavigationStore,
  NavigateOptions,
  NavigationBridge,
  ResolvedSegment,
} from "../types.js";
import { createSegmentStore, type SegmentStore } from "../segment-store.js";
import { OutletProviderV2 } from "../../client-v2.js";
import { RootErrorBoundary } from "../../root-error-boundary.js";

/**
 * Props for NavigationProviderV2
 */
export interface NavigationProviderV2Props {
  /**
   * Navigation store instance
   */
  store: NavigationStore;

  /**
   * Initial segments from server (from payload.metadata.segments)
   */
  initialSegments: ResolvedSegment[];

  /**
   * Navigation bridge for handling navigation
   */
  bridge: NavigationBridge;

  /**
   * Initial RSC content from server (the full tree with OutletProvider chain)
   * Used during hydration to match server rendering
   */
  initialContent: ReactNode | Promise<ReactNode> | null;
}

/**
 * Find the root segment ID from segments array
 * Root is the shortest ID (e.g., "L0")
 */
function findRootId(segments: ResolvedSegment[]): string {
  let rootId = "";
  let minLen = Infinity;

  for (const seg of segments) {
    // Only consider main tree segments (layout, route)
    if (seg.type === "layout" || seg.type === "route") {
      if (seg.id.length < minLen) {
        minLen = seg.id.length;
        rootId = seg.id;
      }
    }
  }

  return rootId;
}

/**
 * Navigation provider with segment-based rendering (v2)
 *
 * Instead of rendering a full ReactNode tree on every update, this provider:
 * 1. Maintains a segment store with all segment data (indexed by ID)
 * 2. Renders a stable component tree with OutletProviderV2
 * 3. On updates, mutates segment store (only affected components re-render)
 *
 * This enables in-place updates without reconstructing the entire React tree.
 *
 * @example
 * ```tsx
 * <NavigationProviderV2
 *   store={store}
 *   initialSegments={payload.metadata.segments}
 *   bridge={navigationBridge}
 * />
 * ```
 */
export function NavigationProviderV2({
  store,
  initialSegments,
  bridge,
  initialContent,
}: NavigationProviderV2Props): ReactNode {
  // Create segment store (stable, never changes)
  const segmentStore = useMemo<SegmentStore>(() => {
    const s = createSegmentStore();
    s.setAll(initialSegments);
    return s;
  }, []);

  // Track root segment ID
  const [rootId, setRootId] = useState(() => findRootId(initialSegments));

  // Track hydration state - don't expose segment store until hydration is complete
  // This ensures Outlet uses V1 mode during hydration to match server rendering
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    console.log("[NavigationProviderV2] Hydration complete, enabling V2 mode");
    setIsHydrated(true);
  }, []);

  /**
   * Navigate to a URL (delegates to bridge)
   */
  const navigate = useCallback(
    async (url: string, options?: NavigateOptions): Promise<void> => {
      await bridge.navigate(url, options);
    },
    [bridge]
  );

  /**
   * Refresh current route (delegates to bridge)
   */
  const refresh = useCallback(async (): Promise<void> => {
    await bridge.refresh();
  }, [bridge]);

  // Navigation context value is stable
  const navigationContextValue = useMemo<NavigationStoreContextValue>(
    () => ({
      store,
      navigate,
      refresh,
    }),
    [store, navigate, refresh]
  );

  // Subscribe to UI updates (stable - never re-subscribes)
  useEffect(() => {
    const unsubscribe = store.onUpdate((update) => {
      // Get segments from update metadata
      const segments = update.metadata?.segments as ResolvedSegment[] | undefined;
      const diff = update.metadata?.diff as string[] | undefined;

      console.log("[NavigationProviderV2] Update received:", {
        segmentCount: segments?.length ?? 0,
        diff: diff?.join(", ") ?? "none",
        pathname: update.metadata?.pathname,
      });

      if (!segments || segments.length === 0) {
        console.warn("[NavigationProviderV2] No segments in update, skipping");
        return;
      }

      // Find new root ID
      const newRootId = findRootId(segments);
      console.log("[NavigationProviderV2] New root ID:", newRootId);

      if (diff && diff.length > 0) {
        // Partial update: only update changed segments
        const updates = new Map<string, ResolvedSegment>();
        for (const seg of segments) {
          updates.set(seg.id, seg);
        }
        segmentStore.update(updates, diff);
      } else {
        // Full update: replace all segments
        segmentStore.setAll(segments);
      }

      // Update root ID if changed (use functional update to avoid stale closure)
      setRootId((currentRootId) => {
        if (newRootId && newRootId !== currentRootId) {
          console.log("[NavigationProviderV2] Updating rootId:", currentRootId, "->", newRootId);
          return newRootId;
        }
        return currentRootId;
      });
    });

    console.log("[Browser] NavigationProviderV2 ready (segment-based)");

    return unsubscribe;
  }, [store, segmentStore]);

  // Get root segment to render (for V2 mode after hydration)
  const rootSegment = segmentStore.get(rootId);
  const component = rootSegment?.component;

  console.log("[NavigationProviderV2] Render:", {
    rootId,
    isHydrated,
    hasRootSegment: !!rootSegment,
    segmentType: rootSegment?.type,
    hasComponent: !!component,
    storeSegmentIds: segmentStore.getIds(),
  });

  // Handle promise case for component
  const rootComponent =
    component instanceof Promise ? use(component) : component ?? null;

  // Handle promise case for initialContent
  const resolvedInitialContent =
    initialContent instanceof Promise ? use(initialContent) : initialContent;

  // During hydration, render the server's RSC tree directly (initialContent)
  // This matches the server rendering and avoids hydration mismatch
  // After hydration, switch to segment-based V2 rendering for navigation updates
  const content = isHydrated ? (
    <OutletProviderV2 key={rootId} segmentId={rootId}>
      {rootComponent}
    </OutletProviderV2>
  ) : (
    resolvedInitialContent
  );

  return (
    <NavigationStoreContext.Provider value={navigationContextValue}>
      <SegmentStoreContext.Provider value={isHydrated ? segmentStore : null}>
        <RootErrorBoundary>{content}</RootErrorBoundary>
      </SegmentStoreContext.Provider>
    </NavigationStoreContext.Provider>
  );
}
