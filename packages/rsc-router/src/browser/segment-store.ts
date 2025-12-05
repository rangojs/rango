import type { ResolvedSegment } from "../types.js";

/**
 * Listener function called when a segment changes
 */
export type SegmentListener = () => void;

/**
 * Selector function to derive data from a segment
 */
export type SegmentSelector<T> = (segment: ResolvedSegment) => T;

/**
 * Store for managing segment state with granular subscriptions
 *
 * Instead of passing full segment data through React context (which causes
 * cascading re-renders), this store allows components to subscribe to
 * specific segments. When a segment updates, only its subscribers re-render.
 */
export interface SegmentStore {
  /**
   * Get a segment by ID
   */
  get(id: string): ResolvedSegment | undefined;

  /**
   * Get all segments as an array
   */
  getAll(): ResolvedSegment[];

  /**
   * Get all segment IDs
   */
  getIds(): string[];

  /**
   * Subscribe to changes for a specific segment
   * Returns unsubscribe function
   */
  subscribe(id: string, listener: SegmentListener): () => void;

  /**
   * Set all segments (used on initial load or full update)
   * Notifies all existing subscribers
   */
  setAll(segments: ResolvedSegment[]): void;

  /**
   * Update specific segments (used on partial update)
   * Only notifies subscribers of the updated segment IDs
   *
   * @param updates - Map of segment ID to new segment data
   * @param diff - Array of segment IDs that changed (for notification)
   */
  update(updates: Map<string, ResolvedSegment>, diff: string[]): void;

  /**
   * Get segments grouped by parent for parallel/loader lookup
   * Returns parallels and loaders associated with a given segment ID
   */
  getChildren(parentId: string): {
    parallels: ResolvedSegment[];
    loaders: ResolvedSegment[];
  };

  /**
   * Find the child segment (layout's next layer or route)
   */
  getChildSegment(parentId: string): ResolvedSegment | undefined;
}

/**
 * Create a segment store
 *
 * @example
 * ```typescript
 * const store = createSegmentStore();
 *
 * // Set initial segments from server
 * store.setAll(payload.metadata.segments);
 *
 * // Subscribe to a specific segment
 * const unsubscribe = store.subscribe('L0R1', () => {
 *   const segment = store.get('L0R1');
 *   console.log('Segment changed:', segment);
 * });
 *
 * // Partial update - only 'L0R1' subscribers notified
 * store.update(newSegmentsMap, ['L0R1']);
 * ```
 */
export function createSegmentStore(): SegmentStore {
  // Segments indexed by ID
  const segments = new Map<string, ResolvedSegment>();

  // Per-segment listeners
  const listeners = new Map<string, Set<SegmentListener>>();

  // Cache for parent → children relationships (rebuilt on setAll)
  let parallelsByParent = new Map<string, ResolvedSegment[]>();
  let loadersByParent = new Map<string, ResolvedSegment[]>();

  // Ordered list of main segment IDs (layouts + routes, for tree traversal)
  // Preserves original order from server for correct rendering hierarchy
  let mainSegmentIds: string[] = [];

  // Map from segment ID to its index in the main segment order
  let segmentOrder: Map<string, number> = new Map();

  /**
   * Rebuild relationship caches from current segments
   * Preserves original insertion order for rendering hierarchy
   */
  function rebuildCaches(): void {
    parallelsByParent.clear();
    loadersByParent.clear();
    mainSegmentIds = [];
    segmentOrder.clear();

    // segments is a Map which preserves insertion order
    // The order from server represents the correct rendering hierarchy
    for (const segment of segments.values()) {
      if (segment.type === "parallel") {
        // "L0R1.@modal" → parent "L0R1"
        const parentId = segment.id.split(".")[0];
        if (!parallelsByParent.has(parentId)) {
          parallelsByParent.set(parentId, []);
        }
        parallelsByParent.get(parentId)!.push(segment);
      } else if (segment.type === "loader") {
        // "L0D0.cart" → parent "L0"
        const parentId = segment.id.split("D")[0];
        if (!loadersByParent.has(parentId)) {
          loadersByParent.set(parentId, []);
        }
        loadersByParent.get(parentId)!.push(segment);
      } else {
        // Main tree segments (layout, route, error, notFound)
        // Track order for getChildSegment
        segmentOrder.set(segment.id, mainSegmentIds.length);
        mainSegmentIds.push(segment.id);
      }
    }

    // DO NOT sort - preserve original order from server
    // The server sends segments in rendering order (layouts first, then routes)
  }

  /**
   * Notify listeners for a specific segment
   */
  function notifyListeners(id: string): void {
    const segmentListeners = listeners.get(id);
    if (segmentListeners) {
      segmentListeners.forEach((listener) => listener());
    }
  }

  return {
    get(id: string): ResolvedSegment | undefined {
      return segments.get(id);
    },

    getAll(): ResolvedSegment[] {
      return Array.from(segments.values());
    },

    getIds(): string[] {
      return Array.from(segments.keys());
    },

    subscribe(id: string, listener: SegmentListener): () => void {
      if (!listeners.has(id)) {
        listeners.set(id, new Set());
      }
      listeners.get(id)!.add(listener);

      return () => {
        const segmentListeners = listeners.get(id);
        if (segmentListeners) {
          segmentListeners.delete(listener);
          if (segmentListeners.size === 0) {
            listeners.delete(id);
          }
        }
      };
    },

    setAll(newSegments: ResolvedSegment[]): void {
      segments.clear();
      for (const segment of newSegments) {
        segments.set(segment.id, segment);
      }
      rebuildCaches();

      // Notify all existing listeners
      for (const id of listeners.keys()) {
        notifyListeners(id);
      }
    },

    update(updates: Map<string, ResolvedSegment>, diff: string[]): void {
      // Replace all segments (navigation gives us the complete new set)
      // This ensures old route segments are removed
      segments.clear();
      for (const [id, segment] of updates) {
        segments.set(id, segment);
      }

      // Rebuild caches with new segment set
      rebuildCaches();

      // Notify diff subscribers (changed segments)
      for (const id of diff) {
        notifyListeners(id);
      }

      // Also notify parent outlets when child segment changes
      // This handles route transitions (e.g., R0 -> R1 under same parent)
      for (const id of diff) {
        // Find parent by looking at segment that would have this as child
        const idx = segmentOrder.get(id);
        if (idx !== undefined && idx > 0) {
          const parentId = mainSegmentIds[idx - 1];
          if (parentId && !diff.includes(parentId)) {
            notifyListeners(parentId);
          }
        }
      }
    },

    getChildren(parentId: string): {
      parallels: ResolvedSegment[];
      loaders: ResolvedSegment[];
    } {
      return {
        parallels: parallelsByParent.get(parentId) || [],
        loaders: loadersByParent.get(parentId) || [],
      };
    },

    getChildSegment(parentId: string): ResolvedSegment | undefined {
      // Get index of parent in the rendering order
      const parentIndex = segmentOrder.get(parentId);
      if (parentIndex === undefined || parentIndex >= mainSegmentIds.length - 1) {
        return undefined;
      }

      // The child is simply the next segment in rendering order
      // Server sends segments in the correct hierarchy order
      const childId = mainSegmentIds[parentIndex + 1];
      return segments.get(childId);
    },
  };
}

// Global segment store instance
let segmentStoreInstance: SegmentStore | null = null;

/**
 * Initialize the global segment store
 */
export function initSegmentStore(): SegmentStore {
  if (!segmentStoreInstance) {
    segmentStoreInstance = createSegmentStore();
  }
  return segmentStoreInstance;
}

/**
 * Get the global segment store
 */
export function getSegmentStore(): SegmentStore {
  if (!segmentStoreInstance) {
    throw new Error(
      "Segment store not initialized. Call initSegmentStore first."
    );
  }
  return segmentStoreInstance;
}

/**
 * Reset the store instance (for testing)
 */
export function resetSegmentStore(): void {
  segmentStoreInstance = null;
}
