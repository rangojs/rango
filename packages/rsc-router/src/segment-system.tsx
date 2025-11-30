import { createElement, Fragment, type ReactNode } from "react";
import { OutletProvider } from "./client.js";
import type { ResolvedSegment } from "./types.js";
import { isLoaderDataResult } from "./types.js";
import { invariant } from "./errors.js";
import { RouteContentWrapper } from "./route-content-wrapper.js";

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
 * ```
 */
export async function renderSegments(
  segments: ResolvedSegment[]
): Promise<ReactNode> {
  // Separate segments by type
  const tree = segmentTreeWalk(segments);
  // Render content segments as siblings
  let content: ReactNode = null;
  for (const node of tree) {
    invariant(
      node.segment.type === "layout" ||
        node.segment.type === "route" ||
        node.segment.type === "error" ||
        node.segment.type === "notFound",
      `Expected layout, route, error, or notFound segment, got ${node.segment.type}`
    );
    const { component, id, params, loading } = node.segment;

    let nodeContent: ReactNode =
      loading || loading === null || component instanceof Promise
        ? createElement(RouteContentWrapper, {
            key: `suspense-loading-${id}`,
            content: component,
            fallback: loading,
          })
        : component;

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

    console.log("node > ", { key, node });

    // Extract loader data from loader segments
    // Each loader segment has loaderName and loaderData (may be Promise<LoaderDataResult>)
    // Await all loader promises in parallel for this node
    const loaderData: Record<string, any> = {};
    let loaderErrorFallback: ReactNode = null;
    const loaderEntries = node.loaders.filter(
      (loader) => loader.loaderName && loader.loaderData !== undefined
    );

    if (loaderEntries.length > 0) {
      // Debug: Check loader data types
      console.log(
        "[renderSegments] Loader entries:",
        loaderEntries.map((l) => ({
          name: l.loaderName,
          isPromise: l.loaderData instanceof Promise,
          isThenable: l.loaderData && typeof l.loaderData.then === "function",
          type: typeof l.loaderData,
          constructor: l.loaderData?.constructor?.name,
        }))
      );

      // Await all loader data in parallel
      const resolvedData = await Promise.all(
        loaderEntries.map((loader) =>
          loader.loaderData instanceof Promise
            ? loader.loaderData
            : Promise.resolve(loader.loaderData)
        )
      );

      console.log("[renderSegments] Loaders resolved");

      // Process results, checking for wrapped loader results with errors
      loaderEntries.forEach((loader, i) => {
        const result = resolvedData[i];

        if (isLoaderDataResult(result)) {
          if (result.ok) {
            // Success - extract the data
            loaderData[loader.loaderName!] = result.data;
          } else {
            // Error - check for fallback
            if (result.fallback) {
              // Use the pre-rendered fallback from server
              loaderErrorFallback = result.fallback;
              console.log(
                `[renderSegments] Loader error with fallback for ${loader.loaderName}:`,
                result.error.message
              );
            } else {
              // No fallback - throw the error
              console.error(
                `[renderSegments] Loader error without fallback for ${loader.loaderName}:`,
                result.error.message
              );
              throw new Error(result.error.message);
            }
          }
        } else {
          // Legacy format - direct data (for backwards compatibility)
          loaderData[loader.loaderName!] = result;
        }
      });
    }

    // If any loader had an error with a fallback, replace the segment content
    if (loaderErrorFallback) {
      nodeContent = loaderErrorFallback;
    }

    content = createElement(OutletProvider, {
      key: key,
      content: node.segment.type === "layout" ? content : null,
      segment: node.segment,
      parallel: node.parallel,
      loaderData: Object.keys(loaderData).length > 0 ? loaderData : undefined,
      children: nodeContent,
    });
  }

  return content;
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
 */
function* segmentTreeWalk(segments: ResolvedSegment[]): Generator<{
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

    yield { segment, parallel, loaders };
  }
}
