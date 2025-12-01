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

// Maximum number of history entries to cache (URLs visited)
const HISTORY_CACHE_SIZE = 20;

// Cache entry: [url-key, segments]
type HistoryCacheEntry = [string, ResolvedSegment[]];

// BroadcastChannel for cross-tab cache invalidation
const CACHE_INVALIDATION_CHANNEL = "rsc-router-cache-invalidation";

// BroadcastChannel instance (lazily initialized)
let cacheInvalidationChannel: BroadcastChannel | null = null;

/**
 * Get or create the BroadcastChannel for cache invalidation
 */
function getCacheInvalidationChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (!cacheInvalidationChannel) {
    cacheInvalidationChannel = new BroadcastChannel(CACHE_INVALIDATION_CHANNEL);
  }
  return cacheInvalidationChannel;
}

/**
 * Generate a cache key from a URL.
 * Uses pathname + search (query params) directly as the key.
 * Hash fragments (#) are excluded since they don't affect server data.
 */
export function generateHistoryKey(url?: string): string {
  if (!url) {
    url = typeof window !== "undefined" ? window.location.href : "/";
  }

  // Parse URL and use only pathname + search (exclude hash fragment)
  const parsed = new URL(url, "http://localhost");
  return parsed.pathname + parsed.search;
}

/**
 * Configuration for creating a navigation store
 */
export interface NavigationStoreConfig {
  initialLocation?: { href: string };
  initialSegmentIds?: string[];
  initialHistoryKey?: string;
  initialSegments?: ResolvedSegment[];
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
  };

  // History-based segment cache: array of [url-key, segments] tuples
  // Each URL gets its own complete snapshot of segments for back/forward and partial merging
  // Oldest entries (at front) are removed when over HISTORY_CACHE_SIZE
  const historyCache: HistoryCacheEntry[] = [];

  // Current history key (set on navigation, stored in history.state)
  let currentHistoryKey = config?.initialHistoryKey || generateHistoryKey();

  // Store initial segments if provided
  if (config?.initialHistoryKey && config?.initialSegments) {
    historyCache.push([config.initialHistoryKey, config.initialSegments]);
  }

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

  /**
   * Clear the history cache (internal - does not broadcast)
   */
  function clearCacheInternal(): void {
    historyCache.length = 0;
  }

  /**
   * Clear the history cache and broadcast to other tabs
   */
  function clearCacheAndBroadcast(): void {
    clearCacheInternal();
    const channel = getCacheInvalidationChannel();
    if (channel) {
      channel.postMessage({ type: "invalidate" });
    }
  }

  // Set up cross-tab cache invalidation listener
  const channel = getCacheInvalidationChannel();
  if (channel) {
    channel.onmessage = (event) => {
      if (event.data?.type === "invalidate") {
        console.log("[Browser] Cache invalidated by another tab");
        clearCacheInternal();
      }
    };
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

    // ========================================================================
    // History-based Segment Cache (for back/forward navigation and partial merging)
    // ========================================================================

    /**
     * Get the current history key
     */
    getHistoryKey(): string {
      return currentHistoryKey;
    },

    /**
     * Set the current history key (called when navigating to a new entry)
     */
    setHistoryKey(key: string): void {
      currentHistoryKey = key;
    },

    /**
     * Store segments for a history entry
     * Updates existing entry if key exists, otherwise adds new entry
     * Removes oldest entries (from front) when over HISTORY_CACHE_SIZE
     */
    cacheSegmentsForHistory(historyKey: string, segments: ResolvedSegment[]): void {
      // Check if entry already exists and update it
      const existingIndex = historyCache.findIndex(([key]) => key === historyKey);
      if (existingIndex !== -1) {
        historyCache[existingIndex] = [historyKey, segments];
      } else {
        // Add new entry at the end
        historyCache.push([historyKey, segments]);
        // Remove oldest entries if over limit
        while (historyCache.length > HISTORY_CACHE_SIZE) {
          historyCache.shift();
        }
      }
    },

    /**
     * Get cached segments for a history entry
     */
    getCachedSegments(historyKey: string): ResolvedSegment[] | undefined {
      const entry = historyCache.find(([key]) => key === historyKey);
      return entry?.[1];
    },

    /**
     * Check if segments are cached for a history entry
     */
    hasHistoryCache(historyKey: string): boolean {
      return historyCache.some(([key]) => key === historyKey);
    },

    /**
     * Clear the history cache and broadcast to other tabs
     * Called after server action commit to invalidate stale data
     */
    clearHistoryCache(): void {
      clearCacheAndBroadcast();
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
