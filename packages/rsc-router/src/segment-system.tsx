import { createElement, Fragment, type ReactNode } from "react";
import { OutletProvider } from "./client.js";
import type { ResolvedSegment } from "./types.js";
import { invariant } from "./errors.js";

/**
 * Render segments into a React tree with proper layout nesting
 *
 * Layouts nest using OutletProvider, while route + parallel segments
 * render as siblings in a Fragment.
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
export function renderSegments(segments: ResolvedSegment[]): ReactNode {
  // Separate segments by type
  const tree = segmentTreeWalk(segments);
  // Render content segments as siblings
  let content: ReactNode = null;
  let position = 0;
  for (const node of tree) {
    invariant(
      node.segment.type === "layout" || node.segment.type === "route",
      `Expected layout or route segment, got ${node.segment.type}`
    );
    const { component, id, params } = node.segment;
    let nodeContent: ReactNode = component;

    // Only include params in key for segments that actually depend on them
    // - Routes: always include params (they render param-specific content)
    // - Route-owned layouts: include params (defined in route's use(), likely param-dependent)
    // - Parent layouts: exclude params (param-agnostic, should stay mounted across param changes)
    // This prevents unnecessary unmounting when params change
    const includeParams =
      node.segment.type === "route" ||
      (node.segment.type === "layout" && node.segment.isOwnedByEntry);

    const paramStr =
      includeParams && params && Object.keys(params).length > 0
        ? Object.entries(params)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(",")
        : "";
    const key = `${position++}-${paramStr ? `${id}-${paramStr}` : id}`;

    console.log("node > ", { key, node });

    content = createElement(OutletProvider, {
      key: key,
      content: node.segment.type === "layout" ? content : null,
      segment: node.segment,
      parallel: node.parallel,
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
 */
function* segmentTreeWalk(segments: ResolvedSegment[]): Generator<{
  segment: ResolvedSegment;
  parallel: ResolvedSegment[];
}> {
  // Pre-group parallel segments by their parent ID using prefix matching
  // This ensures each parallel is associated with the correct parent segment
  // regardless of the iteration order
  const parallelsByParent = new Map<string, ResolvedSegment[]>();
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
    } else {
      nonParallels.push(segment);
    }
  }

  // Iterate bottom-to-top using reverse() to process leaf segments first
  // This processes route/leaf layouts first, then parent layouts
  // Note: We reverse the array to iterate from end to start (bottom-to-top)
  for (let i = nonParallels.length - 1; i >= 0; i--) {
    const segment = nonParallels[i];

    // Lookup parallels that belong to this segment by ID prefix
    const parallel = parallelsByParent.get(segment.id) || [];

    yield { segment, parallel };
  }
}
