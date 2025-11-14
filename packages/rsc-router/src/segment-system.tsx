import { createElement, Fragment, type ReactNode } from "react";
import { OutletProvider } from "./client.js";
import type { ResolvedSegment } from "./types.js";

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
  const layouts: ResolvedSegment[] = [];
  const contentSegments: ResolvedSegment[] = []; // route + parallel

  for (const segment of segments) {
    if (segment.type === "layout") {
      layouts.push(segment);
    } else {
      // Both 'route' and 'parallel' are content
      contentSegments.push(segment);
    }
  }

  // Render content segments as siblings
  let content: ReactNode = null;
  if (contentSegments.length > 0) {
    if (contentSegments.length === 1) {
      // Single content segment - no need for Fragment
      content = contentSegments[0]!.component;
    } else {
      // Multiple content segments - wrap in Fragment
      const children = contentSegments.map((seg) => seg.component);
      content = createElement(Fragment, null, ...children);
    }
  }

  // Wrap with layouts (reverse order - innermost to outermost)
  for (let i = layouts.length - 1; i >= 0; i--) {
    const { component, id } = layouts[i]!;
    content = createElement(OutletProvider, {
      key: id,
      content,
      children: component,
    });
  }

  return content;
}
