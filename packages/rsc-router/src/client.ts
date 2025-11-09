// Client-side exports for rsc-router
'use client';

export { Link } from './Link';
export { Outlet, OutletProvider, useOutlet } from './Outlet';
export type { LinkProps } from './Link';

import type { Segment } from './segment-system';

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
