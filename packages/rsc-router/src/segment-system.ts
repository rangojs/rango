/**
 * Segment ID System - L0, R1, P2 identification for partial rendering
 */

import type { ReactNode } from 'react';

/**
 * Segment type identifiers
 */
export type SegmentType = 'layout' | 'route' | 'parallel';

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
   */
  component: ReactNode;

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
  component: ReactNode,
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
