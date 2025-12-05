"use client";

import {
  createElement,
  useContext,
  Suspense,
  use,
  type ReactNode,
} from "react";
import { OutletContextV2, type OutletContextValueV2 } from "./outlet-context-v2.js";
import { useSegment, useSegmentStore } from "./browser/react/use-segment.js";
import type { LoaderDefinition, ResolvedSegment } from "./types.js";
import { RouteContentWrapper, LoaderBoundary } from "./route-content-wrapper.js";

/**
 * Outlet component (v2) - renders child content using segment subscriptions
 *
 * Instead of reading segment data from context, this component subscribes
 * to the segment store. Only re-renders when the subscribed segment changes.
 *
 * For named outlets (parallel routes), uses store.getChildren to find
 * the matching parallel segment.
 *
 * @param name - Optional slot name for parallel/intercept content (must start with @)
 */
export function Outlet({ name }: { name?: `@${string}` } = {}): ReactNode {
  const context = useContext(OutletContextV2);
  if (!context) return null;

  const { segmentId } = context;

  // For named slots, render parallel segment
  if (name) {
    return <ParallelOutletContent segmentId={segmentId} slotName={name} />;
  }

  // Default outlet - render child content
  return <DefaultOutletContent segmentId={segmentId} />;
}

/**
 * Default outlet content - subscribes to segment and renders child
 */
function DefaultOutletContent({ segmentId }: { segmentId: string }): ReactNode {
  const store = useSegmentStore();
  const segment = useSegment(segmentId);

  console.log("[DefaultOutletContent] Render:", {
    segmentId,
    hasSegment: !!segment,
    segmentType: segment?.type,
  });

  if (!segment) return null;

  // Find child segment (layout's outlet content)
  const childSegment = store.getChildSegment(segmentId);
  console.log("[DefaultOutletContent] Child segment:", {
    parentId: segmentId,
    childId: childSegment?.id,
    childType: childSegment?.type,
  });

  if (!childSegment) {
    // No child - this is a leaf segment
    return null;
  }

  // Render child with its own OutletProvider
  const childContent = <SegmentRenderer segment={childSegment} />;

  // If this segment has a loading component, wrap child in Suspense
  if (segment.loading) {
    return <Suspense fallback={segment.loading}>{childContent}</Suspense>;
  }

  return childContent;
}

/**
 * Parallel outlet content - finds and renders parallel segment for slot
 */
function ParallelOutletContent({
  segmentId,
  slotName,
}: {
  segmentId: string;
  slotName: `@${string}`;
}): ReactNode {
  const store = useSegmentStore();

  // Subscribe to parent segment to detect changes
  useSegment(segmentId);

  // Get parallels for this segment
  const { parallels } = store.getChildren(segmentId);
  const parallelSegment = parallels.find((p) => p.slot === slotName);

  if (!parallelSegment) return null;

  return <ParallelSegmentRenderer segment={parallelSegment} />;
}

/**
 * Renders a parallel segment (may have layout, loaders, etc.)
 */
function ParallelSegmentRenderer({
  segment,
}: {
  segment: ResolvedSegment;
}): ReactNode {
  // Determine content to render
  let content: ReactNode;
  if (segment.loading || segment.component instanceof Promise) {
    content = (
      <RouteContentWrapper
        content={
          segment.component instanceof Promise
            ? segment.component
            : Promise.resolve(segment.component)
        }
        fallback={segment.loading}
      />
    );
  } else {
    content = segment.component ?? null;
  }

  // If segment has layout, wrap appropriately
  if (segment.layout) {
    // Check if segment has loaders that need streaming
    if (segment.loaderDataPromise && segment.loaderNames) {
      // Wrap layout with LoaderBoundary for streaming loader data
      return (
        <OutletProviderV2 segmentId={segment.id}>
          <LoaderBoundary
            loaderDataPromise={segment.loaderDataPromise}
            loaderNames={segment.loaderNames}
            fallback={segment.loading}
            outletKey={segment.id + "-loader"}
            outletContent={content}
            segment={segment}
          >
            {segment.layout}
          </LoaderBoundary>
        </OutletProviderV2>
      );
    }

    // No loaders - wrap in OutletProvider so layout can use <Outlet />
    return (
      <OutletProviderV2 segmentId={segment.id}>
        {segment.layout}
      </OutletProviderV2>
    );
  }

  return content;
}

/**
 * Renders a segment's component with proper Suspense/loader handling
 */
function SegmentRenderer({ segment }: { segment: ResolvedSegment }): ReactNode {
  const { id, component, loading, params, type, belongsToRoute } = segment;

  // Build key for this segment
  const includeParams =
    type === "route" ||
    type === "error" ||
    type === "notFound" ||
    (type === "layout" && belongsToRoute);

  const paramStr =
    includeParams && params && Object.keys(params).length > 0
      ? Object.entries(params)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(",")
      : "";
  const key = paramStr ? `${id}-${paramStr}` : id;

  // Determine component content
  let nodeContent: ReactNode;
  if (loading || loading === null || component instanceof Promise) {
    nodeContent = createElement(RouteContentWrapper, {
      key: `suspense-loading-${id}`,
      content:
        component instanceof Promise ? component : Promise.resolve(component),
      fallback: loading,
    });
  } else {
    // Handle promise case with use()
    nodeContent =
      component instanceof Promise ? use(component) : component;
  }

  // Wrap in OutletProvider for nested outlets
  return (
    <OutletProviderV2 key={key} segmentId={id}>
      {nodeContent}
    </OutletProviderV2>
  );
}

/**
 * Minimal OutletProvider (v2) - only passes segment ID through context
 *
 * Children use useSegment(segmentId) to subscribe to segment data.
 * This prevents cascading re-renders since context value only changes
 * when segment ID changes (rare), not when segment data changes.
 */
export function OutletProviderV2({
  segmentId,
  children,
}: {
  segmentId: string;
  children: ReactNode;
}): ReactNode {
  const value: OutletContextValueV2 = { segmentId };

  return (
    <OutletContextV2.Provider value={value}>
      {children}
    </OutletContextV2.Provider>
  );
}

/**
 * Hook to access loader data (v2)
 *
 * Walks up the segment tree to find loader data.
 * Uses segment store to look up loader segments.
 */
export function useLoaderV2<T>(loader: LoaderDefinition<T>): T {
  const context = useContext(OutletContextV2);
  const store = useSegmentStore();

  if (!context) {
    throw new Error("useLoaderV2 must be used within an OutletProviderV2");
  }

  // Get loaders for current segment and walk up
  let currentId: string | undefined = context.segmentId;

  while (currentId) {
    const { loaders } = store.getChildren(currentId);

    // Check if any loader matches
    for (const loaderSegment of loaders) {
      if (loaderSegment.loaderName === loader.name) {
        return loaderSegment.loaderData as T;
      }
    }

    // Walk up: find parent segment ID
    // "L0L0" → "L0", "L0R1" → "L0"
    const match: RegExpMatchArray | null = currentId.match(/^(.+?)[LR]\d+$/);
    currentId = match?.[1];
  }

  throw new Error(
    `Loader data for "${loader.name}" not found. Make sure the loader is attached to this route or a parent layout.`
  );
}

/**
 * Hook to get all loader data in current segment tree
 */
export function useLoaderDataV2(): Record<string, any> {
  const context = useContext(OutletContextV2);
  const store = useSegmentStore();

  if (!context) {
    return {};
  }

  const result: Record<string, any> = {};
  const visited = new Set<string>();

  // Walk from current segment up to root, collecting loader data
  let currentId: string | undefined = context.segmentId;

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const { loaders } = store.getChildren(currentId);

    for (const loaderSegment of loaders) {
      if (loaderSegment.loaderName && loaderSegment.loaderData !== undefined) {
        // Don't override child loaders with parent loaders
        if (!(loaderSegment.loaderName in result)) {
          result[loaderSegment.loaderName] = loaderSegment.loaderData;
        }
      }
    }

    // Walk up
    const match: RegExpMatchArray | null = currentId.match(/^(.+?)[LR]\d+$/);
    currentId = match?.[1];
  }

  return result;
}
