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

  for (const node of tree) {
    invariant(
      node.segment.type === "layout" || node.segment.type === "route",
      `Expected layout or route segment, got ${node.segment.type}`
    );
    const { component, id, params } = node.segment;
    let nodeContent: ReactNode = component;
    const key = `${id}-${Object.entries(params ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join(",")}`;
    console.log("node", { key, node });

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

function* segmentTreeWalk(segments: ResolvedSegment[]): Generator<{
  segment: ResolvedSegment;
  parallel: ResolvedSegment[];
}> {
  const _segments = [...segments];
  let parallelSegments: ResolvedSegment[] = [];
  do {
    const segment = _segments.pop();
    if (!segment) {
      return null;
    }

    if (segment.type === "parallel") {
      parallelSegments.push(segment);
      continue;
    }

    // type is layout or route
    yield {
      segment,
      parallel: parallelSegments,
    };
    yield* segmentTreeWalk(_segments);
    break;
  } while (_segments.length > 0);
}
