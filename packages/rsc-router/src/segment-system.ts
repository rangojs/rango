/**
 * Segment ID System - L0, R1, P2 identification for partial rendering
 */

import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import * as React from 'react';
import { OutletProvider } from './Outlet';

/**
 * Segment type identifiers
 */
export type SegmentType = 'layout' | 'route' | 'parallel';

/**
 * Component type that can be either a ReactNode or a function component
 */
export type SegmentComponent =
  | ReactNode
  | ((props?: any) => ReactNode)
  | React.ComponentType<any>;

/**
 * Segment structure for partial rendering
 */
export interface Segment {
  /**
   * Unique segment ID (e.g., 'L0', 'R2', 'P3')
   */
  id: string;

  /**
   * Segment type
   */
  type: SegmentType;

  /**
   * Sequential index number
   */
  index: number;

  /**
   * React component for this segment
   * Can be a ReactNode, function component, or class component
   */
  component: SegmentComponent;

  /**
   * Slot name for parallel segments (e.g., '@sidebar', '@modal')
   * Only present for parallel segments
   */
  slot?: string;

  /**
   * Path pattern for this segment
   */
  path?: string;

  /**
   * Route params for this segment
   */
  params?: Record<string, string>;
}

/**
 * Generate segment ID from type and index
 *
 * @param type - Segment type (layout, route, parallel)
 * @param index - Sequential index
 * @returns Segment ID string (e.g., 'L0', 'R2', 'P3')
 *
 * @example
 * ```typescript
 * generateSegmentId('layout', 0)    // 'L0'
 * generateSegmentId('route', 2)     // 'R2'
 * generateSegmentId('parallel', 3)  // 'P3'
 * ```
 */
export function generateSegmentId(type: SegmentType, index: number): string {
  const prefix = type === 'layout' ? 'L' : type === 'route' ? 'R' : 'P';
  return `${prefix}${index}`;
}

/**
 * Parse segment ID to extract type and index
 *
 * @param segmentId - Segment ID string (e.g., 'L0', 'R2')
 * @returns Object with type and index, or null if invalid
 *
 * @example
 * ```typescript
 * parseSegmentId('L0')  // { type: 'layout', index: 0 }
 * parseSegmentId('R2')  // { type: 'route', index: 2 }
 * parseSegmentId('P3')  // { type: 'parallel', index: 3 }
 * ```
 */
export function parseSegmentId(
  segmentId: string
): { type: SegmentType; index: number } | null {
  const match = segmentId.match(/^([LRP])(\d+)$/);

  if (!match) {
    return null;
  }

  const [, typeChar, indexStr] = match;
  const index = parseInt(indexStr, 10);

  let type: SegmentType;
  switch (typeChar) {
    case 'L':
      type = 'layout';
      break;
    case 'R':
      type = 'route';
      break;
    case 'P':
      type = 'parallel';
      break;
    default:
      return null;
  }

  return { type, index };
}

/**
 * Validate segment ID format
 *
 * @param segmentId - Segment ID to validate
 * @returns True if valid format
 */
export function isValidSegmentId(segmentId: string): boolean {
  return /^[LRP]\d+$/.test(segmentId);
}

/**
 * Create a segment object
 *
 * @param type - Segment type
 * @param index - Sequential index
 * @param component - React component
 * @param options - Optional properties (slot, path, params)
 * @returns Segment object
 */
export function createSegment(
  type: SegmentType,
  index: number,
  component: SegmentComponent,
  options?: {
    slot?: string;
    path?: string;
    params?: Record<string, string>;
  }
): Segment {
  return {
    id: generateSegmentId(type, index),
    type,
    index,
    component,
    ...options,
  };
}

/**
 * Parse client segments from _has parameter
 *
 * During SPA navigation, the client reports which segments it currently has
 * rendered using the _has query parameter (e.g., ?_has=L0,L1,R2).
 *
 * This function parses the _has parameter and returns a Set of segment IDs
 * for efficient lookup during differential rendering.
 *
 * @param hasParam - The value of the _has query parameter (or null if not present)
 * @returns Set of segment IDs (e.g., Set(['L0', 'L1', 'R2']))
 *
 * @example
 * ```typescript
 * // Typical usage with URL
 * const url = new URL('http://localhost/blog/123?_has=L0,L1,R2');
 * const hasParam = url.searchParams.get('_has');
 * const clientSegments = parseClientSegments(hasParam);
 * // clientSegments => Set(['L0', 'L1', 'R2'])
 *
 * // Initial navigation (no client state)
 * parseClientSegments(null) // => Set([])
 *
 * // Handles whitespace
 * parseClientSegments('L0, L1, R2') // => Set(['L0', 'L1', 'R2'])
 *
 * // Deduplicates automatically
 * parseClientSegments('L0,L1,L0,R2') // => Set(['L0', 'L1', 'R2'])
 * ```
 */
export function parseClientSegments(hasParam: string | null): Set<string> {
  // Handle null or empty string (initial navigation)
  if (!hasParam || hasParam.trim() === '') {
    return new Set();
  }

  // Split by comma, trim whitespace, filter empty strings
  const segments = hasParam
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Return as Set for efficient lookup and automatic deduplication
  return new Set(segments);
}

/**
 * Result of differential computation
 */
export interface DifferentialResult {
  /**
   * Complete list of segment IDs for the target route
   * Used by client for reconciliation (removing segments not in this list)
   */
  segmentIds: string[];

  /**
   * Segments that need to be sent to the client
   * Only includes segments that the client doesn't have or need updating
   */
  updates: Segment[];
}

/**
 * Compute differential segments for partial rendering
 *
 * Determines which segments need to be sent to the client by comparing
 * the client's current segments with the target segments for the requested route.
 *
 * The algorithm sends only:
 * - Segments that don't exist on the client
 * - Segments that need revalidation (in future: params changed, etc.)
 *
 * @param clientHas - Set of segment IDs the client currently has
 * @param targetSegments - Complete list of segments for target route
 * @returns Object with complete segment IDs list and segments to update
 *
 * @example
 * ```typescript
 * // Initial navigation - client has nothing
 * const clientHas = new Set();
 * const targetSegments = [
 *   { id: 'L0', type: 'layout', index: 0, component: <Layout /> },
 *   { id: 'R1', type: 'route', index: 1, component: <Page /> }
 * ];
 * const result = computeDifferential(clientHas, targetSegments);
 * // result.segmentIds => ['L0', 'R1']
 * // result.updates => [L0, R1] (all segments)
 *
 * // Client has segments, navigates to same route
 * const clientHas = new Set(['L0', 'R1']);
 * const result = computeDifferential(clientHas, targetSegments);
 * // result.segmentIds => ['L0', 'R1']
 * // result.updates => [] (no changes)
 *
 * // Client navigates deeper (adding segments)
 * const clientHas = new Set(['L0', 'R1']);
 * const targetSegments = [
 *   { id: 'L0', ... },
 *   { id: 'R1', ... },
 *   { id: 'L2', ... },  // New
 *   { id: 'R3', ... }   // New
 * ];
 * const result = computeDifferential(clientHas, targetSegments);
 * // result.segmentIds => ['L0', 'R1', 'L2', 'R3']
 * // result.updates => [L2, R3] (only new segments)
 * ```
 */
export function computeDifferential(
  clientHas: Set<string>,
  targetSegments: Segment[]
): DifferentialResult {
  // Extract target segment IDs for reconciliation
  const segmentIds = targetSegments.map((segment) => segment.id);

  // Compute which segments need to be sent
  const updates: Segment[] = [];

  for (const segment of targetSegments) {
    const shouldSend =
      // Send if client doesn't have this segment
      !clientHas.has(segment.id) ||
      // Send if segment has params (conservative: assume params might have changed)
      // This is a simple heuristic until we have full revalidation logic
      (segment.params !== undefined && Object.keys(segment.params).length > 0);

    if (shouldSend) {
      updates.push(segment);
    }
  }

  return {
    segmentIds,
    updates,
  };
}

/**
 * Route match result from router
 */
export interface RouteMatch {
  pathname: string;
  params: Record<string, string>;
  handlers: any; // The matched handlers object
}

/**
 * Build segment map from route match
 *
 * Converts a route match result into a segment map for rendering.
 * The segment map includes layouts, route content, and parallel routes,
 * all with sequential indices for partial rendering.
 *
 * @param match - The route match result
 * @returns Array of segments in rendering order
 *
 * @example
 * ```typescript
 * const match = {
 *   pathname: '/blog/123',
 *   params: { slug: '123' },
 *   handlers: {
 *     layout: [RootLayout, BlogLayout],
 *     show: BlogPost,
 *     parallel: {
 *       '@sidebar': Sidebar,
 *       '@modal': Modal
 *     }
 *   }
 * };
 *
 * const segments = buildSegmentMap(match);
 * // [
 * //   { id: 'L0', type: 'layout', index: 0, component: RootLayout, ... },
 * //   { id: 'L1', type: 'layout', index: 1, component: BlogLayout, ... },
 * //   { id: 'R2', type: 'route', index: 2, component: BlogPost, ... },
 * //   { id: 'P3', type: 'parallel', index: 3, component: Modal, slot: '@modal', ... },
 * //   { id: 'P4', type: 'parallel', index: 4, component: Sidebar, slot: '@sidebar', ... }
 * // ]
 * ```
 */
export function buildSegmentMap(match: RouteMatch): Segment[] {
  const segments: Segment[] = [];
  let index = 0;

  const { pathname, params, handlers } = match;

  if (!handlers || Object.keys(handlers).length === 0) {
    return segments;
  }

  // 1. Process layouts
  const layout = handlers.layout;
  if (layout !== undefined) {
    const layouts = Array.isArray(layout) ? layout : [layout];

    for (const layoutComponent of layouts) {
      segments.push(
        createSegment('layout', index++, layoutComponent, {
          path: pathname,
          // Layouts typically don't have params
        })
      );
    }
  }

  // 2. Process route content (find non-special keys)
  const specialKeys = ['layout', 'parallel', 'loading', 'error', 'revalidate'];
  const routeKeys = Object.keys(handlers).filter(
    (key) => !specialKeys.includes(key)
  );

  if (routeKeys.length > 0) {
    // Use first route key (typically 'index', 'show', etc.)
    const routeKey = routeKeys[0];
    if (routeKey) {
      const routeComponent = handlers[routeKey];

      segments.push(
        createSegment('route', index++, routeComponent, {
          path: pathname,
          params: Object.keys(params).length > 0 ? params : undefined,
        })
      );
    }
  }

  // 3. Process parallel routes (preserve insertion order)
  const parallel = handlers.parallel;
  if (parallel && typeof parallel === 'object') {
    // Use Object.keys() to preserve insertion order (ES2015+)
    const slots = Object.keys(parallel);

    for (const slot of slots) {
      const component = parallel[slot];
      segments.push(
        createSegment('parallel', index++, component, {
          slot,
          path: pathname,
          params: Object.keys(params).length > 0 ? params : undefined,
        })
      );
    }
  }

  return segments;
}

/**
 * Render segments into a React tree with OutletProvider
 *
 * Takes a segment map and renders it into a nested React tree using OutletProvider
 * to handle layout nesting. The function wraps each layout with OutletProvider,
 * passing the child content through the Outlet component.
 *
 * @param segments - Array of segments to render
 * @returns Rendered React tree, or null if segments is empty
 *
 * @example
 * ```typescript
 * const segments = [
 *   { id: 'L0', type: 'layout', index: 0, component: RootLayout, path: '/blog' },
 *   { id: 'L1', type: 'layout', index: 1, component: BlogLayout, path: '/blog' },
 *   { id: 'R2', type: 'route', index: 2, component: BlogPost, path: '/blog/123', params: { slug: '123' } },
 *   { id: 'P3', type: 'parallel', index: 3, component: Sidebar, slot: '@sidebar', path: '/blog/123' }
 * ];
 *
 * const tree = renderSegments(segments);
 * // Renders:
 * // <RootLayout>
 * //   <OutletProvider content={<BlogLayout><OutletProvider content={<BlogPost />}>}>
 * //     <BlogLayout>
 * //       <OutletProvider content={<BlogPost />}>
 * //         <BlogPost />
 * //       </OutletProvider>
 * //     </BlogLayout>
 * //   </OutletProvider>
 * // </RootLayout>
 * ```
 */
export function renderSegments(segments: Segment[]): ReactNode {
  // Handle empty segments
  if (!segments || segments.length === 0) {
    return null;
  }

  // Separate segments by type
  const layouts = segments.filter((s) => s.type === 'layout');
  const routeSegment = segments.find((s) => s.type === 'route');
  const parallelSegments = segments.filter((s) => s.type === 'parallel');

  // Start with the innermost content (route + parallel routes)
  let content: ReactNode = null;

  // Render route content
  if (routeSegment && routeSegment.component) {
    const Component = routeSegment.component as any;

    // If component is a function, invoke it with params
    if (typeof Component === 'function') {
      const hasParams =
        routeSegment.params && Object.keys(routeSegment.params).length > 0;

      if (hasParams) {
        content = createElement(Component, { params: routeSegment.params });
      } else {
        content = createElement(Component);
      }
    } else {
      // If it's already a ReactNode, use it directly
      content = Component;
    }
  }

  // Handle parallel routes (render alongside main content)
  // For now, we'll render them after the main content
  // In a real implementation, the layout would need to know about slots
  if (parallelSegments.length > 0) {
    const parallelNodes = parallelSegments.map((segment) => {
      if (!segment.component) return null;

      const Component = segment.component as any;

      // If component is a function, invoke it with params
      if (typeof Component === 'function') {
        const hasParams =
          segment.params && Object.keys(segment.params).length > 0;

        if (hasParams) {
          return createElement(Component, {
            key: segment.id,
            params: segment.params,
          });
        } else {
          return createElement(Component, { key: segment.id });
        }
      } else {
        // If it's already a ReactNode, use it directly
        return createElement('div', { key: segment.id }, Component);
      }
    });

    // Combine route content with parallel routes
    if (content) {
      content = createElement(Fragment, null, [content, ...parallelNodes]);
    } else {
      content = createElement(Fragment, null, parallelNodes);
    }
  }

  // If no content at all, return null
  if (!content) {
    return null;
  }

  // Wrap with layouts from innermost to outermost (reverse order)
  // Start from the last layout and work backwards
  for (let i = layouts.length - 1; i >= 0; i--) {
    const layoutSegment = layouts[i];
    if (!layoutSegment || !layoutSegment.component) {
      // Skip null/undefined layouts but continue wrapping
      continue;
    }

    const LayoutComponent = layoutSegment.component as any;

    // If it's a function, invoke it
    if (typeof LayoutComponent === 'function') {
      // Wrap current content with OutletProvider and pass to layout
      const wrappedContent = content;
      content = createElement(
        OutletProvider,
        { content: wrappedContent },
        createElement(LayoutComponent)
      );
    } else {
      // If it's already a ReactNode, just use it (rare case)
      content = LayoutComponent;
    }
  }

  return content;
}

/**
 * RSC Payload structure for client-server communication
 *
 * Format for streaming RSC updates to the client during navigation.
 * The payload contains the complete segment list for reconciliation and
 * the actual React components to render for segments that need updating.
 */
export interface RSCPayload {
  /**
   * Complete list of segment IDs for the target route
   * Client uses this to reconcile (remove segments not in this list)
   * @example ['L0', 'L1', 'R2', 'P3']
   */
  segments: string[];

  /**
   * Rendered React components for segments that need updating
   * Only includes segments the client doesn't have or need revalidation
   * @example { 'R2': <BlogPost />, 'P3': <Sidebar /> }
   */
  updates: Record<string, ReactNode>;
}

/**
 * Create RSC payload for streaming to client
 *
 * Generates an RSC payload containing:
 * 1. Complete segment list for client reconciliation
 * 2. Rendered components for segments that need updating
 *
 * The function performs differential rendering by only including segments
 * in the updates object that:
 * - Don't exist on the client (!clientHas.has(id))
 * - Have params that might have changed
 *
 * @param segments - Complete segment list for target route
 * @param clientHas - Set of segment IDs the client currently has
 * @returns RSC payload ready for streaming
 *
 * @example
 * ```typescript
 * // Initial navigation - client has nothing
 * const segments = [
 *   { id: 'L0', type: 'layout', component: RootLayout, ... },
 *   { id: 'R1', type: 'route', component: BlogPost, ... }
 * ];
 * const clientHas = new Set();
 * const payload = createRSCPayload(segments, clientHas);
 * // {
 * //   segments: ['L0', 'R1'],
 * //   updates: {
 * //     'L0': <RootLayout />,
 * //     'R1': <BlogPost />
 * //   }
 * // }
 *
 * // Subsequent navigation - client has some segments
 * const clientHas = new Set(['L0']);
 * const payload = createRSCPayload(segments, clientHas);
 * // {
 * //   segments: ['L0', 'R1'],
 * //   updates: {
 * //     'R1': <BlogPost />  // Only R1, client already has L0
 * //   }
 * // }
 * ```
 */
export function createRSCPayload(
  segments: Segment[],
  clientHas: Set<string>
): RSCPayload {
  // Extract all segment IDs for reconciliation
  const segmentIds = segments.map((segment) => segment.id);

  // Build updates object with only segments that need to be sent
  const updates: Record<string, ReactNode> = {};

  for (const segment of segments) {
    // Determine if this segment should be sent
    const shouldSend =
      // Send if client doesn't have this segment
      !clientHas.has(segment.id) ||
      // Send if segment has params (conservative: assume params might have changed)
      // This matches the logic in computeDifferential
      (segment.params !== undefined && Object.keys(segment.params).length > 0);

    if (shouldSend && segment.component) {
      // Render the segment component
      const Component = segment.component as any;

      let rendered: ReactNode = null;

      if (typeof Component === 'function') {
        // Function component - invoke with params if present
        const hasParams =
          segment.params && Object.keys(segment.params).length > 0;

        if (hasParams) {
          rendered = createElement(Component, { params: segment.params });
        } else {
          rendered = createElement(Component);
        }
      } else {
        // Already a ReactNode - use directly
        rendered = Component;
      }

      // Add to updates object
      if (rendered !== null) {
        updates[segment.id] = rendered;
      }
    }
  }

  return {
    segments: segmentIds,
    updates,
  };
}
