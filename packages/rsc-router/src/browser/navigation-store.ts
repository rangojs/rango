import type {
  NavigationState,
  NavigationLocation,
  SegmentState,
  NavigationStore,
  NavigationUpdate,
  UpdateSubscriber,
  StateListener,
  ResolvedSegment,
  InflightAction,
} from "./types.js";

/**
 * Configuration for creating a navigation store
 */
export interface NavigationStoreConfig {
  initialLocation?: { href: string };
  initialSegmentIds?: string[];
}

/**
 * Create a URL instance from window.location or custom values
 */
function createLocation(loc: { href: string }): NavigationLocation {
  return new URL(loc.href);
}

/**
 * Create a navigation store for managing browser-side navigation state
 *
 * The store manages two types of state:
 * - NavigationState: Public state exposed via useNavigation hook
 * - SegmentState: Internal segment management for partial RSC updates
 *
 * @param config - Initial configuration
 * @returns NavigationStore instance
 *
 * @example
 * ```typescript
 * const store = createNavigationStore({
 *   initialLocation: window.location,
 *   initialSegmentIds: [],
 * });
 *
 * // Subscribe to state changes (for useNavigation hook)
 * const unsubscribe = store.subscribe(() => {
 *   const state = store.getState();
 *   console.log('Navigation state:', state);
 * });
 *
 * // Update state
 * store.setState({ state: 'loading' });
 *
 * // Subscribe to UI updates (for re-rendering)
 * store.onUpdate((update) => {
 *   console.log('New root:', update.root);
 * });
 * ```
 */
export function createNavigationStore(
  config?: NavigationStoreConfig
): NavigationStore {
  // Default location from window or config
  const defaultLocation: NavigationLocation =
    typeof window !== "undefined"
      ? createLocation(window.location)
      : new URL("/", "http://localhost");

  // Public navigation state (for useNavigation hook)
  // isStreaming starts false to match SSR and avoid hydration mismatch
  // After hydration, entry.browser.tsx sets it to true if stream is still open
  let navState: NavigationState = {
    state: "idle",
    isStreaming: false,
    location: config?.initialLocation
      ? createLocation(config.initialLocation)
      : defaultLocation,
    formData: null,
    formAction: null,
    inflightActions: [],
  };

  // Resolve the initial location for segment state
  const initialLoc = config?.initialLocation
    ? createLocation(config.initialLocation)
    : defaultLocation;

  // Internal segment state (for partial updates)
  const segmentState: SegmentState = {
    path: initialLoc.pathname,
    currentUrl: initialLoc.href,
    currentSegmentIds: config?.initialSegmentIds ?? [],
    storedSegments: new Map(),
  };

  // State change listeners (for useNavigation subscriptions)
  const stateListeners = new Set<StateListener>();

  // UI update subscribers (for re-rendering)
  const updateSubscribers = new Set<UpdateSubscriber>();

  // Internal flag to track if a server action is in progress
  let actionInProgress = false;

  /**
   * Notify all state listeners of a change
   */
  function notifyStateListeners(): void {
    stateListeners.forEach((listener) => listener());
  }

  return {
    // ========================================================================
    // Public State (for useNavigation hook)
    // ========================================================================

    /**
     * Get current navigation state
     */
    getState(): NavigationState {
      return navState;
    },

    /**
     * Update navigation state and notify listeners
     */
    setState(partial: Partial<NavigationState>): void {
      navState = { ...navState, ...partial };
      notifyStateListeners();
    },

    /**
     * Subscribe to state changes
     * Returns unsubscribe function
     */
    subscribe(listener: StateListener): () => void {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },

    // ========================================================================
    // Inflight Action Management
    // ========================================================================

    /**
     * Add an inflight action to the list
     */
    addInflightAction(action: InflightAction): void {
      navState = {
        ...navState,
        inflightActions: [...navState.inflightActions, action],
      };
      notifyStateListeners();
    },

    /**
     * Remove an inflight action by ID
     */
    removeInflightAction(id: string): void {
      navState = {
        ...navState,
        inflightActions: navState.inflightActions.filter((a) => a.id !== id),
      };
      notifyStateListeners();
    },

    // ========================================================================
    // Action State (for controlling update behavior during server actions)
    // ========================================================================

    /**
     * Check if a server action is currently in progress
     */
    isActionInProgress(): boolean {
      return actionInProgress;
    },

    /**
     * Set the action in progress flag
     */
    setActionInProgress(value: boolean): void {
      actionInProgress = value;
    },

    // ========================================================================
    // Internal Segment State (for bridges)
    // ========================================================================

    /**
     * Get internal segment state
     */
    getSegmentState(): SegmentState {
      return segmentState;
    },

    /**
     * Set current path
     */
    setPath(path: string): void {
      segmentState.path = path;
    },

    /**
     * Set current URL
     */
    setCurrentUrl(url: string): void {
      segmentState.currentUrl = url;
    },

    /**
     * Set current segment IDs
     */
    setSegmentIds(ids: string[]): void {
      segmentState.currentSegmentIds = ids;
    },

    /**
     * Store a single segment
     */
    storeSegment(segment: ResolvedSegment): void {
      segmentState.storedSegments.set(segment.id, segment);
    },

    /**
     * Store multiple segments
     */
    storeSegments(segments: ResolvedSegment[]): void {
      segments.forEach((segment) => {
        segmentState.storedSegments.set(segment.id, segment);
      });
    },

    /**
     * Prune stored segments, keeping only those in the provided list
     * Call after navigation completes to prevent memory leaks
     */
    pruneSegments(keepIds: string[]): void {
      const keepSet = new Set(keepIds);
      for (const id of segmentState.storedSegments.keys()) {
        if (!keepSet.has(id)) {
          segmentState.storedSegments.delete(id);
        }
      }
    },

    // ========================================================================
    // UI Update Notifications
    // ========================================================================

    /**
     * Subscribe to UI updates (when root needs to re-render)
     */
    onUpdate(callback: UpdateSubscriber): () => void {
      updateSubscribers.add(callback);
      return () => {
        updateSubscribers.delete(callback);
      };
    },

    /**
     * Emit a UI update to all subscribers
     */
    emitUpdate(update: NavigationUpdate): void {
      updateSubscribers.forEach((callback) => {
        callback(update);
      });
    },
  };
}

// Singleton store instance
let storeInstance: NavigationStore | null = null;

/**
 * Initialize the global navigation store
 *
 * Should be called once during app initialization.
 * Subsequent calls return the existing instance.
 */
export function initNavigationStore(
  config?: NavigationStoreConfig
): NavigationStore {
  if (!storeInstance) {
    storeInstance = createNavigationStore(config);
  }
  return storeInstance;
}

/**
 * Get the global navigation store
 *
 * Throws if store hasn't been initialized.
 */
export function getNavigationStore(): NavigationStore {
  if (!storeInstance) {
    throw new Error(
      "Navigation store not initialized. Call initNavigationStore first."
    );
  }
  return storeInstance;
}

/**
 * Reset the store instance (for testing)
 */
export function resetNavigationStore(): void {
  storeInstance = null;
}
