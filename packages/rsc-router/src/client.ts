// Client-side utilities for rsc-router
// Note: No 'use client' here - only React components need that directive
// Link and Outlet have 'use client' in their own files

export { Link } from './Link';
export { Outlet, OutletProvider, useOutlet } from './Outlet';
export type { LinkProps } from './Link';

import type { Segment } from './segment-system';
import { parseSegmentId } from './segment-system';
import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { OutletProvider as OutletProviderComponent } from './Outlet';
export { renderSegments } from './segment-system';
/**
 * Client-side segment store for tracking rendered segments
 *
 * The segment store maintains the client's current state of rendered segments,
 * enabling differential rendering during SPA navigation. It tracks which segments
 * are currently displayed and provides reconciliation with server responses.
 *
 * @example
 * ```typescript
 * // Initialize store
 * const store = new SegmentStore();
 *
 * // Add segments from initial render
 * store.addSegment({ id: 'L0', type: 'layout', ... });
 * store.addSegment({ id: 'R1', type: 'route', ... });
 *
 * // During navigation, send current state to server
 * const hasParam = store.getIds().join(','); // "L0,R1"
 * fetch(`/route?_has=${hasParam}`);
 *
 * // Reconcile with server response
 * const payload = await response.json();
 * store.reconcile(payload.segments); // Remove segments not in server list
 * ```
 */
export class SegmentStore {
  /**
   * Internal map of segment ID to segment data
   */
  private segments: Map<string, Segment>;

  /**
   * Create a new segment store
   *
   * @param initialSegments - Optional initial segments to populate the store
   */
  constructor(initialSegments?: Segment[]) {
    this.segments = new Map();

    if (initialSegments) {
      for (const segment of initialSegments) {
        this.segments.set(segment.id, segment);
      }
    }
  }

  /**
   * Add a segment to the store
   *
   * If a segment with the same ID already exists, it will be replaced.
   *
   * @param segment - Segment to add
   */
  addSegment(segment: Segment): void {
    this.segments.set(segment.id, segment);
  }

  /**
   * Remove a segment from the store by ID
   *
   * @param segmentId - ID of segment to remove
   */
  removeSegment(segmentId: string): void {
    this.segments.delete(segmentId);
  }

  /**
   * Update a segment in the store
   *
   * If the segment doesn't exist, it will be added.
   *
   * @param segmentId - ID of segment to update
   * @param segment - Updated segment data
   */
  updateSegment(segmentId: string, segment: Segment): void {
    this.segments.set(segmentId, segment);
  }

  /**
   * Check if store contains a segment
   *
   * @param segmentId - ID of segment to check
   * @returns True if segment exists in store
   */
  has(segmentId: string): boolean {
    return this.segments.has(segmentId);
  }

  /**
   * Get a segment from the store by ID
   *
   * @param segmentId - ID of segment to retrieve
   * @returns Segment data, or undefined if not found
   */
  get(segmentId: string): Segment | undefined {
    return this.segments.get(segmentId);
  }

  /**
   * Get all segments from the store
   *
   * Returns segments sorted by their index for consistent ordering.
   *
   * @returns Array of all segments, ordered by index
   */
  getAll(): Segment[] {
    return Array.from(this.segments.values()).sort((a, b) => a.index - b.index);
  }

  /**
   * Get all segment IDs from the store
   *
   * Returns IDs sorted by segment index for consistent ordering.
   *
   * @returns Array of segment IDs, ordered by index
   */
  getIds(): string[] {
    return this.getAll().map((segment) => segment.id);
  }

  /**
   * Get the number of segments in the store
   *
   * @returns Number of segments
   */
  size(): number {
    return this.segments.size;
  }

  /**
   * Check if the store is empty
   *
   * @returns True if store contains no segments
   */
  isEmpty(): boolean {
    return this.segments.size === 0;
  }

  /**
   * Remove all segments from the store
   */
  clear(): void {
    this.segments.clear();
  }

  /**
   * Reconcile store with server's segment list
   *
   * Removes segments that are not in the server's list. This is called
   * after receiving a response from the server to ensure the client's
   * state matches what the server expects.
   *
   * Note: This only removes segments - it doesn't add new ones. New segments
   * are added via addSegment() or updateSegment() when processing the
   * server's updates.
   *
   * @param serverSegmentIds - Array of segment IDs from server response
   *
   * @example
   * ```typescript
   * // Client has: L0, R1, P2
   * // Server says: L0, R1, R3
   * store.reconcile(['L0', 'R1', 'R3']);
   * // Result: Store now has L0, R1 (P2 removed, R3 not added yet)
   * ```
   */
  reconcile(serverSegmentIds: string[]): void {
    const serverSet = new Set(serverSegmentIds);

    // Remove segments that aren't in the server's list
    for (const segmentId of this.segments.keys()) {
      if (!serverSet.has(segmentId)) {
        this.segments.delete(segmentId);
      }
    }
  }
}

/**
 * Navigation options for client-side navigation
 */
export interface NavigationOptions
  extends Omit<RequestInit, 'method' | 'body'> {
  /**
   * Segment store instance
   * Used to send current segments via _has parameter
   */
  store: SegmentStore;

  /**
   * Base URL for the request
   * Defaults to current origin
   */
  baseUrl?: string;

  /**
   * Additional headers to send with the request
   * Merged with default headers (Accept: application/x-rsc)
   */
  headers?: HeadersInit;
}

/**
 * Navigate to a route with partial rendering support
 *
 * Performs client-side navigation by:
 * 1. Constructing URL with _has parameter (current segments)
 * 2. Fetching from server with RSC headers
 * 3. Parsing RSC payload response
 *
 * This function implements the client-side navigation protocol described
 * in the design doc (lines 292-307). It sends the client's current segment
 * state to the server via the _has parameter, allowing the server to compute
 * a differential response containing only the segments that need updating.
 *
 * @param pathname - Target pathname to navigate to
 * @param options - Navigation options including segment store
 * @returns RSC payload containing segments and updates
 *
 * @throws Error if navigation fails (network error, non-ok response, etc.)
 *
 * @example
 * ```typescript
 * import { navigateToRoute, SegmentStore } from 'rsc-router/client';
 *
 * const store = new SegmentStore();
 * // ... populate store with current segments
 *
 * // Navigate to new route
 * const payload = await navigateToRoute('/blog/123', { store });
 *
 * // Process payload
 * store.reconcile(payload.segments);
 * // Update segments with payload.updates
 * ```
 *
 * @example
 * ```typescript
 * // With custom headers
 * const payload = await navigateToRoute('/blog/123', {
 *   store,
 *   headers: {
 *     'X-Custom-Header': 'value'
 *   }
 * });
 * ```
 *
 * @example
 * ```typescript
 * // With abort signal
 * const controller = new AbortController();
 * const payload = await navigateToRoute('/blog/123', {
 *   store,
 *   signal: controller.signal
 * });
 * // Later: controller.abort()
 * ```
 */
export async function navigateToRoute(
  pathname: string,
  options: NavigationOptions
): Promise<RSCPayload> {
  const { store, baseUrl, headers: customHeaders, ...fetchOptions } = options;

  // 1. Build URL with _has parameter
  const url = new URL(pathname, baseUrl || window.location.origin);

  // Add _has parameter if store has segments
  const currentSegmentIds = store.getIds();
  if (currentSegmentIds.length > 0) {
    url.searchParams.set('_has', currentSegmentIds.join(','));
  }

  // 2. Prepare headers
  const defaultHeaders: HeadersInit = {
    Accept: 'application/x-rsc',
  };

  // Merge custom headers with defaults
  const headers = { ...defaultHeaders, ...customHeaders };

  // 3. Fetch from server
  const response = await fetch(url.toString(), {
    ...fetchOptions,
    headers,
    method: 'GET',
  });

  // 4. Check response status
  if (!response.ok) {
    throw new Error(
      `Navigation failed: ${response.status} ${response.statusText}`
    );
  }

  // 5. Parse RSC payload
  const payload: RSCPayload = await response.json();

  return payload;
}

/**
 * Process RSC payload and update segment store
 *
 * Implements the client-side reconciliation algorithm described in the design doc
 * (lines 315-337). This function:
 * 1. Reconciles store with server's segment list (removes segments not in list)
 * 2. Updates existing segments with new components from updates
 * 3. Adds new segments from updates
 *
 * @param payload - RSC payload from server response
 * @param store - Segment store to update
 *
 * @example
 * ```typescript
 * // After navigation
 * const payload = await navigateToRoute('/blog/123', { store });
 *
 * // Process the payload
 * processPayload(payload, store);
 *
 * // Store is now reconciled with server state
 * const tree = reconstructTreeFromSegments(store.getAll());
 * ```
 */
export function processPayload(payload: RSCPayload, store: SegmentStore): void {
  const { segments: serverSegmentIds, updates } = payload;

  // 1. Reconcile - remove segments not in server's list
  store.reconcile(serverSegmentIds);

  // 2. Process updates - add or update segments
  for (const segmentId of serverSegmentIds) {
    // Only process if we have an update for this segment
    if (segmentId in updates) {
      const component = updates[segmentId];

      // Parse segment ID to extract type and index
      const parsed = parseSegmentId(segmentId);
      if (!parsed) {
        console.warn(`Invalid segment ID: ${segmentId}`);
        continue;
      }

      const { type, index } = parsed;

      // Create segment object
      const segment: Segment = {
        id: segmentId,
        type,
        index,
        component,
        path: '', // Path will be set by application context
      };

      // Add or update segment
      if (store.has(segmentId)) {
        store.updateSegment(segmentId, segment);
      } else {
        store.addSegment(segment);
      }
    }
  }
}

/**
 * Reconstruct React tree from segments using OutletProvider
 *
 * Implements the client-side tree reconstruction algorithm described in the
 * design doc (lines 369-400). Builds a nested React tree where each layout
 * wraps its children via OutletProvider.
 *
 * The tree is built from innermost to outermost:
 * - Start with route content (innermost)
 * - Add parallel routes alongside route content
 * - Wrap with layouts from last to first (outermost)
 *
 * @param segments - Array of segments to render (will be sorted by index)
 * @returns React tree ready for rendering, or null if no segments
 *
 * @example
 * ```typescript
 * const segments = store.getAll(); // Already sorted by index
 * const tree = reconstructTreeFromSegments(segments);
 *
 * // Render the tree
 * root.render(tree);
 * ```
 *
 * @example
 * ```typescript
 * // Given segments: [L0, L1, R2, P3]
 * // Produces tree:
 * // <OutletProvider content={<OutletProvider content={<Fragment><R2 /><P3 /></Fragment>}>}>
 * //   <L0 />
 * // </OutletProvider>
 * //
 * // L0's <Outlet /> renders L1
 * // L1's <Outlet /> renders R2 + P3
 * ```
 */
export function reconstructTreeFromSegments(segments: Segment[]): ReactNode {
  // Handle empty segments
  if (!segments || segments.length === 0) {
    return null;
  }

  // Sort segments by index to ensure correct order
  const sortedSegments = [...segments].sort((a, b) => a.index - b.index);

  // Separate segments by type
  const layouts = sortedSegments.filter((s) => s.type === 'layout');
  const routeSegment = sortedSegments.find((s) => s.type === 'route');
  const parallelSegments = sortedSegments.filter((s) => s.type === 'parallel');

  // Start with the innermost content (route + parallel routes)
  let content: ReactNode = null;

  // Render route content
  if (routeSegment && routeSegment.component) {
    const Component = routeSegment.component as any;

    // If component is a function, invoke it
    if (typeof Component === 'function') {
      content = createElement(Component);
    } else {
      // If it's already a ReactNode, use it directly
      content = Component;
    }
  }

  // Handle parallel routes (render alongside main content)
  if (parallelSegments.length > 0) {
    const parallelNodes = parallelSegments.map((segment) => {
      if (!segment.component) return null;

      const Component = segment.component as any;

      // If component is a function, invoke it
      if (typeof Component === 'function') {
        return createElement(Component, { key: segment.id });
      } else {
        // If it's already a ReactNode, wrap it
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
      content = createElement(OutletProviderComponent, {
        content,
        children: createElement(LayoutComponent),
      });
    } else {
      // If it's already a ReactNode, just use it (rare case)
      content = LayoutComponent;
    }
  }

  return content;
}
