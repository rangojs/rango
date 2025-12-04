import { createElement, type ReactNode } from "react";
import { OutletProvider } from "./client.js";
import type { ResolvedSegment, LoaderDataResult } from "./types.js";
import { isLoaderDataResult } from "./types.js";
import { invariant } from "./errors.js";
import {
  RouteContentWrapper,
  LoaderBoundary,
} from "./route-content-wrapper.js";
import { RootErrorBoundary } from "./root-error-boundary.js";

/**
 * Resolve loader data from raw results, unwrapping LoaderDataResult wrappers
 */
function resolveLoaderData(
  resolvedData: any[],
  loaderNames: string[]
): { loaderData: Record<string, any>; errorFallback: ReactNode } {
  const loaderData: Record<string, any> = {};
  let errorFallback: ReactNode = null;

  for (let i = 0; i < loaderNames.length; i++) {
    const name = loaderNames[i];
    const result = resolvedData[i];

    if (!isLoaderDataResult(result)) {
      // Legacy format - direct data
      loaderData[name] = result;
      continue;
    }

    if (result.ok) {
      loaderData[name] = result.data;
      continue;
    }

    // Error case
    if (result.fallback) {
      errorFallback = result.fallback;
    } else {
      throw new Error(result.error.message);
    }
  }

  return { loaderData, errorFallback };
}

/**
 * Options for renderSegments
 */
export interface RenderSegmentsOptions {
  /**
   * If true, this render is for a server action response.
   * In browser during actions, we await component promises to prevent
   * UI flickering/suspense during optimistic updates.
   */
  isAction?: boolean;

  /**
   * If true, force awaiting all loaders instead of streaming with Suspense.
   * Used for popstate (back/forward) navigation where we want instant rendering
   * from cache without showing loading skeletons.
   */
  forceAwait?: boolean;

  /**
   * Intercept segments to inject into the tree.
   * These are parallel segments from intercept routes that need to be
   * associated with their parent layout's named outlet.
   *
   * Passed separately for explicit handling - makes the flow clearer
   * and easier to debug than relying on ID pattern matching.
   */
  interceptSegments?: ResolvedSegment[];
}

/**
 * Render segments into a React tree with proper layout nesting
 *
 * Layouts nest using OutletProvider, while route + parallel + error + notFound segments
 * render as siblings in a Fragment.
 *
 * Error segments are treated like route segments - they render their fallback
 * component in place of the failed segment. When an error occurs in a handler,
 * loader, or middleware, the router creates an error segment with the nearest
 * error boundary's fallback component.
 *
 * NotFound segments are similar to error segments but are triggered by
 * DataNotFoundError (thrown via notFound()). They render the nearest
 * notFoundBoundary's fallback component.
 *
 * @param segments - Array of resolved segments to render
 * @returns ReactNode representing the component tree
 *
 * @example
 * ```typescript
 * const segments = [
 *   { id: 'L0.0', type: 'layout', component: <RootLayout /> },
 *   { id: 'L1.0', type: 'layout', component: <BlogLayout /> },
 *   { id: 'R2.0', type: 'route', component: <BlogPost /> },
 *   { id: 'P3.0', type: 'parallel', component: <Sidebar />, slot: '@sidebar' }
 * ];
 *
 * const tree = renderSegments(segments);
 * // Results in:
 * // <OutletProvider><RootLayout>
 * //   <OutletProvider><BlogLayout>
 * //     <><BlogPost /><Sidebar /></>
 * //   </BlogLayout></OutletProvider>
 * // </RootLayout></OutletProvider>
 *
 * // For server actions, pass isAction to await components:
 * const tree = renderSegments(segments, { isAction: true });
 * ```
 */
export async function renderSegments(
  segments: ResolvedSegment[],
  options?: RenderSegmentsOptions
): Promise<ReactNode> {
  const { interceptSegments, forceAwait } = options || {};

  // Separate segments by type, passing intercept segments for explicit injection
  const tree = segmentTreeWalk(segments, interceptSegments);
  // Render content segments as siblings
  let content: ReactNode = null;
  for (const node of tree) {
    console.log("node > ", node);

    invariant(
      node.segment.type === "layout" ||
        node.segment.type === "route" ||
        node.segment.type === "error" ||
        node.segment.type === "notFound",
      `Expected layout, route, error, or notFound segment, got ${node.segment.type}`
    );
    const { component, id, params, loading } = node.segment;

    // Only include params in key for segments that belong to the route
    // - Routes: always include params (they render param-specific content)
    // - Error/notFound segments: always include params (they replace failed route content)
    // - Route's layouts (orphans): include params (children of parameterized route)
    // - Parent chain layouts: exclude params (shared across routes, param-agnostic)
    // This prevents unnecessary unmounting when params change
    const includeParams =
      node.segment.type === "route" ||
      node.segment.type === "error" ||
      node.segment.type === "notFound" ||
      (node.segment.type === "layout" && node.segment.belongsToRoute);

    const paramStr =
      includeParams && params && Object.keys(params).length > 0
        ? Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
    const key = `${paramStr ? `${id}-${paramStr}` : id}`;

    // Get loader entries for this node
    const loaderEntries = node.loaders.filter(
      (loader) => loader.loaderName && loader.loaderData !== undefined
    );

    // Determine the component content (with or without Suspense wrapper)
    let nodeContent: ReactNode =
      loading || loading === null || component instanceof Promise
        ? createElement(RouteContentWrapper, {
            key: `suspense-loading-${id}`,
            content:
              component instanceof Promise
                ? component
                : Promise.resolve(component),
            fallback: loading,
          })
        : component;

    // Common props for OutletProvider
    const outletContent: ReactNode =
      node.segment.type === "layout" ? content : null;

    // No loaders - create OutletProvider directly
    if (loaderEntries.length === 0) {
      content = createElement(OutletProvider, {
        key,
        content: outletContent,
        segment: node.segment,
        parallel: node.parallel,
        children: nodeContent,
      });
      continue;
    }

    // Has loaders - prepare loader data
    const loaderNames = loaderEntries.map((loader) => loader.loaderName!);
    const loaderDataPromise = Promise.all(
      loaderEntries.map((loader) =>
        loader.loaderData instanceof Promise
          ? loader.loaderData
          : Promise.resolve(loader.loaderData)
      )
    );

    // Use LoaderBoundary for streaming when loading skeleton is defined
    // If forceAwait was set, promises are pre-resolved so LoaderBoundary won't suspend
    // false means we have a loading skeleton but it it's explicitly disabled for ssr
    // undefined means we dont have a loading skeleton
    if (loading !== undefined) {
      content = createElement(LoaderBoundary, {
        key: `loader-boundary-${key}`,
        loaderDataPromise: forceAwait
          ? await loaderDataPromise
          : loaderDataPromise,
        loaderNames,
        fallback: loading,
        outletKey: key,
        outletContent,
        segment: node.segment,
        parallel: node.parallel,
        children: nodeContent,
      });
      continue;
    }

    // No loading skeleton - await loaders and render directly
    const resolvedData = await loaderDataPromise;
    const { loaderData, errorFallback } = resolveLoaderData(
      resolvedData,
      loaderNames
    );

    content = createElement(OutletProvider, {
      key,
      content: outletContent,
      segment: node.segment,
      parallel: node.parallel,
      loaderData: Object.keys(loaderData).length > 0 ? loaderData : undefined,
      children: errorFallback ?? nodeContent,
    });
  }

  // Always wrap with root error boundary to prevent white screens
  // This catches any unhandled errors that bubble up from the segment tree
  return createElement(RootErrorBoundary, {
    children: content,
  });
}

/**
 * Walk segments in bottom-to-top order for React nesting
 *
 * Segments from match() are in top-to-bottom order (root → leaf):
 * Example: [L0, L0L0, L0R1L0.@sidebar, L0R1L0, L0R1]
 *
 * For proper React rendering, we need bottom-to-top (leaf → root):
 * - Innermost content (route) wraps inside layouts
 * - Each layer provides context via OutletProvider
 * - Outer layouts receive inner content via <Outlet />
 *
 * Parallel segments must be matched to their parent by ID prefix:
 * - "L0R1L0.@sidebar" belongs to "L0R1L0"
 * - Pre-grouping prevents parallels from attaching to wrong parents
 *   during the reversed iteration (which would cause "L0R1L0.@sidebar"
 *   to incorrectly attach to "L0L0" instead of "L0R1L0")
 *
 * Loader segments are also grouped by parent:
 * - "L0D0.cart" belongs to "L0"
 * - Loaders don't render directly, their data is passed to context
 *
 * Intercept segments are passed separately for explicit handling:
 * - They are injected into the correct parent's parallel array
 * - This makes the flow clearer than relying on ID pattern matching
 *
 * @param segments - Main segments from the route tree
 * @param interceptSegments - Optional intercept segments to inject
 */
function* segmentTreeWalk(
  segments: ResolvedSegment[],
  interceptSegments?: ResolvedSegment[]
): Generator<{
  segment: ResolvedSegment;
  parallel: ResolvedSegment[];
  loaders: ResolvedSegment[];
}> {
  // Pre-group parallel and loader segments by their parent ID using prefix matching
  // This ensures each parallel/loader is associated with the correct parent segment
  // regardless of the iteration order
  const parallelsByParent = new Map<string, ResolvedSegment[]>();
  const loadersByParent = new Map<string, ResolvedSegment[]>();
  const nonParallels: ResolvedSegment[] = [];

  for (const segment of segments) {
    if (segment.type === "parallel") {
      // Extract parent ID from parallel ID
      // Example: "L0R1L0.@sidebar" → "L0R1L0"
      const parentId = segment.id.split(".")[0];
      if (!parallelsByParent.has(parentId)) {
        parallelsByParent.set(parentId, []);
      }
      parallelsByParent.get(parentId)!.push(segment);
    } else if (segment.type === "loader") {
      // Extract parent ID from loader ID
      // Example: "L0D0.cart" → "L0"
      // Loader ID format: {parentShortCode}D{index}.{loaderName}
      const parentId = segment.id.split("D")[0];
      if (!loadersByParent.has(parentId)) {
        loadersByParent.set(parentId, []);
      }
      loadersByParent.get(parentId)!.push(segment);
    } else {
      // Layout, route, error, and notFound segments are all rendered in the tree
      // Error/notFound segments replace the failed segment with fallback UI
      nonParallels.push(segment);
    }
  }

  // INTERCEPT SEGMENTS: Explicitly inject into parent's parallel array
  // Intercept segments are passed separately for explicit handling
  if (interceptSegments && interceptSegments.length > 0) {
    for (const intercept of interceptSegments) {
      if (intercept.type === "parallel" && intercept.slot) {
        // Extract parent ID from intercept ID (e.g., "M4L0L0L2.@modal" → "M4L0L0L2")
        const parentId = intercept.id.split(".")[0];
        if (!parallelsByParent.has(parentId)) {
          parallelsByParent.set(parentId, []);
        }
        parallelsByParent.get(parentId)!.push(intercept);
      } else if (intercept.type === "loader") {
        // Intercept loaders - extract parent from loader ID
        const parentId = intercept.id.split("D")[0];
        if (!loadersByParent.has(parentId)) {
          loadersByParent.set(parentId, []);
        }
        loadersByParent.get(parentId)!.push(intercept);
      }
    }
  }

  // Sort segments by ID to ensure consistent root-to-leaf ordering
  // regardless of the order they arrive in the input array (which can differ
  // between document requests and actions)
  // Shorter IDs come first (closer to root), same length sorted lexicographically
  nonParallels.sort((a, b) => {
    if (a.id.length !== b.id.length) {
      return a.id.length - b.id.length;
    }
    return a.id.localeCompare(b.id);
  });

  // Iterate bottom-to-top using reverse() to process leaf segments first
  // This processes route/leaf layouts first, then parent layouts
  // Note: We reverse the array to iterate from end to start (bottom-to-top)
  for (let i = nonParallels.length - 1; i >= 0; i--) {
    const segment = nonParallels[i];

    // Lookup parallels and loaders that belong to this segment by ID prefix
    const parallel = parallelsByParent.get(segment.id) || [];
    const loaders = loadersByParent.get(segment.id) || [];

    // Also include loaders from parallel segments (e.g., intercept loaders)
    // These have parent IDs like "M9L0L1.@modal" which match the parallel segment ID
    for (const p of parallel) {
      const parallelLoaders = loadersByParent.get(p.id);
      if (parallelLoaders) {
        loaders.push(...parallelLoaders);
      }
    }

    yield { segment, parallel, loaders };
  }
}
