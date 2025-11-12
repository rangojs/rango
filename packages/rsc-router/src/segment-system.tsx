import { createElement, type ReactNode } from 'react';
import { OutletProvider } from './client.js';
import type { ResolvedSegment } from './types.js';

/**
 * Render segments into a nested React tree with OutletProvider
 *
 * Builds the tree in reverse order (innermost first), wrapping each
 * component with OutletProvider to enable <Outlet /> rendering.
 *
 * @param segments - Array of resolved segments to render
 * @returns ReactNode representing the nested component tree
 *
 * @example
 * ```typescript
 * const segments = [
 *   { id: 'L0.0', component: <RootLayout />, ... },
 *   { id: 'L1.0', component: <BlogLayout />, ... },
 *   { id: 'R2.0', component: <BlogPost />, ... }
 * ];
 *
 * const tree = renderSegments(segments);
 * // Results in:
 * // <OutletProvider>
 * //   <RootLayout>
 * //     <OutletProvider>
 * //       <BlogLayout>
 * //         <OutletProvider>
 * //           <BlogPost />
 * //         </OutletProvider>
 * //       </BlogLayout>
 * //     </OutletProvider>
 * //   </RootLayout>
 * // </OutletProvider>
 * ```
 */
export function renderSegments(segments: ResolvedSegment[]): ReactNode {
  let content: ReactNode = null;

  // Process segments in reverse order (innermost first)
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!segment) continue;

    const { component } = segment;

    // Wrap component with OutletProvider
    // The 'content' prop contains the child layer
    content = createElement(
      OutletProvider,
      { content, children: component }
    );
  }

  return content;
}
