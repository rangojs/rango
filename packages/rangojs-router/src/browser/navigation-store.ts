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
  TrackedActionState,
  ActionStateListener,
  HandleData,
} from "./types.js";
import { clearPrefetchCache } from "./prefetch/cache.js";

/**
 * Default action state (idle with no payload)
 */
const DEFAULT_ACTION_STATE: TrackedActionState = {
  state: "idle",
  actionId: null,
  payload: null,
  error: null,
  result: null,
};

// Maximum number of history entries to cache (URLs visited)
const HISTORY_CACHE_SIZE = 20;

// Cache entry: [url-key, segments, stale, handleData?]
// stale=true means the data may be outdated and should be revalidated on access
type HistoryCacheEntry = [string, ResolvedSegment[], boolean, HandleData?];

/**
 * Shallow clone handleData to avoid reference sharing between cache entries.
 * Only clones the structure (objects and arrays), not the data items themselves,
 * since mutations happen at the array level, not on individual data objects.
 * This preserves any non-serializable types (React elements, functions, etc.)
 */
function cloneHandleData(handleData: HandleData): HandleData {
  const cloned: HandleData = {};
  for (const [handleKey, segmentMap] of Object.entries(handleData)) {
    cloned[handleKey] = {};
    for (const [segmentId, dataArray] of Object.entries(segmentMap)) {
      cloned[handleKey][segmentId] = [...dataArray];
    }
  }
  return cloned;
}

// BroadcastChannel for cross-tab cache invalidation
const CACHE_INVALIDATION_CHANNEL = "rsc-router-cache-invalidation";

// BroadcastChannel instance (lazily initialized)
let cacheInvalidationChannel: BroadcastChannel | null = null;

/**
 * Get or create the BroadcastChannel for cache invalidation
 */
function getCacheInvalidationChannel(): BroadcastChannel | null {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return null;
  }
  if (!cacheInvalidationChannel) {
    cacheInvalidationChannel = new BroadcastChannel(CACHE_INVALIDATION_CHANNEL);
  }
  return cacheInvalidationChannel;
}

/**
 * Options for generating a history key
 */
export interface HistoryKeyOptions {
  /** If true, append :intercept suffix to differentiate intercept entries */
  intercept?: boolean;
}

/**
 * Generate a cache key from a URL.
 * Uses pathname + search (query params) directly as the key.
 * Hash fragments (#) are excluded since they don't affect server data.
 *
 * For intercept routes, append `:intercept` suffix to cache them separately
 * from non-intercept versions of the same URL.
 */
export function generateHistoryKey(
  url?: string,
  options?: HistoryKeyOptions,
): string {
  if (!url) {
    url = typeof window !== "undefined" ? window.location.href : "/";
  }

  // Parse URL and use only pathname + search (exclude hash fragment)
  const parsed = new URL(url, "http://localhost");
  let key = parsed.pathname + parsed.search;

  // Append intercept suffix for separate caching
  if (options?.intercept) {
    key += ":intercept";
  }

  return key;
}

/**
 * Configuration for creating a navigation store
 */
export interface NavigationStoreConfig {
  initialLocation?: { href: string };
  initialSegmentIds?: string[];
  initialHistoryKey?: string;
  initialSegments?: ResolvedSegment[];

  /**
   * Maximum number of history entries to cache (default: 20)
   * Older entries are evicted when limit is reached
   */
  cacheSize?: number;

  /**
   * Enable cross-tab cache invalidation via BroadcastChannel (default: true)
   * When cache is cleared (via server actions or useClientCache().clear()),
   * other tabs will also clear their cache
   */
  crossTabSync?: boolean;

  /**
   * Auto-refresh when another tab mutates data on the same path (default: true)
   * Triggered when cache is cleared via server actions or useClientCache().clear()
   * Requires crossTabSync to be enabled
   */
  crossTabAutoRefresh?: boolean;

  /**
   * Callback to invoke when cross-tab refresh is triggered
   * Called when another tab invalidates the cache for a related route
   */
  onCrossTabRefresh?: () => void;
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
  config?: NavigationStoreConfig,
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
    pendingUrl: null,
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

  // Configuration with defaults
  const cacheSize = config?.cacheSize ?? HISTORY_CACHE_SIZE;
  const crossTabSync = config?.crossTabSync !== false; // Default: true
  const crossTabAutoRefresh = config?.crossTabAutoRefresh !== false; // Default: true

  // Cross-tab refresh callback (set by navigation bridge)
  let crossTabRefreshCallback: (() => void) | null =
    config?.onCrossTabRefresh ?? null;

  // Track pending cross-tab refresh to prevent duplicate refreshes
  let pendingCrossTabRefresh = false;

  // History-based segment cache: array of [url-key, segments] tuples
  // Each URL gets its own complete snapshot of segments for back/forward and partial merging
  // Oldest entries (at front) are removed when over cacheSize limit
  const historyCache: HistoryCacheEntry[] = [];

  // Current history key (set on navigation, stored in history.state)
  let currentHistoryKey = config?.initialHistoryKey || generateHistoryKey();

  // Store initial segments if provided (not stale)
  if (config?.initialHistoryKey && config?.initialSegments) {
    historyCache.push([
      config.initialHistoryKey,
      config.initialSegments,
      false,
    ]);
  }

  // State change listeners (for useNavigation subscriptions)
  const stateListeners = new Set<StateListener>();

  // UI update subscribers (for re-rendering)
  const updateSubscribers = new Set<UpdateSubscriber>();

  // Internal flag to track if a server action is in progress
  let actionInProgress = false;

  // Intercept source URL - tracks where the intercept was triggered from
  // Used to maintain intercept context during action revalidation
  let interceptSourceUrl: string | null = null;

  // Action state tracking (for useAction hook)
  // Maps action function ID to its tracked state
  const actionStates = new Map<string, TrackedActionState>();

  // Action state listeners (per action ID)
  // Maps action function ID to set of listeners
  const actionListeners = new Map<string, Set<ActionStateListener>>();

  /**
   * Create a debounced function that batches rapid calls
   */
  function createDebouncedNotifier<T extends (...args: any[]) => void>(
    fn: T,
    ms: number = 20,
  ): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return ((...args: Parameters<T>) => {
      if (timeout !== null) clearTimeout(timeout);
      timeout = setTimeout(() => {
        timeout = null;
        fn(...args);
      }, ms);
    }) as T;
  }

  /**
   * Create a keyed debounced function (separate timers per key)
   */
  function createKeyedDebouncedNotifier<
    T extends (key: string, ...args: any[]) => void,
  >(fn: T, ms: number = 20): T {
    const timeouts = new Map<string, ReturnType<typeof setTimeout>>();
    return ((key: string, ...args: any[]) => {
      const existing = timeouts.get(key);
      if (existing !== undefined) clearTimeout(existing);
      timeouts.set(
        key,
        setTimeout(() => {
          timeouts.delete(key);
          fn(key, ...args);
        }, ms),
      );
    }) as T;
  }

  const notifyStateListeners = createDebouncedNotifier(() => {
    stateListeners.forEach((listener) => listener());
  });

  const notifyActionListeners = createKeyedDebouncedNotifier(
    (actionId: string, state: TrackedActionState) => {
      const listeners = actionListeners.get(actionId);
      if (listeners) {
        listeners.forEach((listener) => listener(state));
      }
    },
  );

  /**
   * Clear the history cache (internal - does not broadcast)
   */
  function clearCacheInternal(): void {
    historyCache.length = 0;
    clearPrefetchCache();
  }

  /**
   * Mark all cache entries as stale (internal - does not broadcast)
   */
  function markCacheAsStaleInternal(): void {
    for (let i = 0; i < historyCache.length; i++) {
      historyCache[i][2] = true;
    }
    clearPrefetchCache();
  }

  /**
   * Clear the history cache and broadcast to other tabs
   */
  function clearCacheAndBroadcast(): void {
    console.log("[Browser] Clearing cache and broadcasting to other tabs");
    clearCacheInternal();
    broadcastInvalidation();
  }

  /**
   * Mark cache as stale and broadcast to other tabs
   */
  function markStaleAndBroadcast(): void {
    console.log(
      "[Browser] Marking cache as stale and broadcasting to other tabs",
    );
    markCacheAsStaleInternal();
    broadcastInvalidation();
  }

  /**
   * Broadcast cache invalidation to other tabs without clearing local cache
   * Used after consolidation fetch where local cache has fresh data
   */
  function broadcastInvalidation(): void {
    // Only broadcast if cross-tab sync is enabled
    if (!crossTabSync) return;

    const channel = getCacheInvalidationChannel();
    if (channel) {
      // Broadcast path and segment IDs - receiver checks for shared segments
      const currentPath = window.location.pathname;
      const currentSegmentIds = segmentState.currentSegmentIds;
      channel.postMessage({
        type: "invalidate",
        path: currentPath,
        segmentIds: currentSegmentIds,
      });
      console.log(
        "[Browser] Broadcast sent for path:",
        currentPath,
        "segments:",
        currentSegmentIds.join(", "),
      );
    } else {
      console.warn("[Browser] No BroadcastChannel available");
    }
  }

  // Set up cross-tab cache invalidation listener (only if enabled)
  if (crossTabSync) {
    const channel = getCacheInvalidationChannel();
    if (channel) {
      channel.onmessage = (event) => {
        if (event.data?.type === "invalidate") {
          const mutatedPath = event.data.path;
          const mutatedSegmentIds: string[] = event.data.segmentIds ?? [];
          const currentSegmentIds = segmentState.currentSegmentIds;

          // Check for shared segments between tabs
          // Routes sharing any segment (layout, loader, etc.) should invalidate together
          const hasSharedSegment = mutatedSegmentIds.some((id) =>
            currentSegmentIds.includes(id),
          );

          if (!hasSharedSegment) {
            // No shared segments - routes are unrelated, ignore invalidation
            return;
          }

          console.log(
            "[Browser] Cache marked stale by another tab, shared segments:",
            mutatedSegmentIds
              .filter((id) => currentSegmentIds.includes(id))
              .join(", "),
          );
          markCacheAsStaleInternal();

          // Auto-refresh if enabled and callback is registered
          if (crossTabAutoRefresh && crossTabRefreshCallback) {
            // If idle, refresh immediately. If loading, wait for idle then refresh.
            if (navState.state === "idle") {
              console.log("[Browser] Cross-tab refresh triggered (idle)");
              crossTabRefreshCallback();
            } else if (!pendingCrossTabRefresh) {
              // Only queue one refresh, ignore subsequent events while loading
              pendingCrossTabRefresh = true;
              console.log(
                "[Browser] Navigation in progress, deferring cross-tab refresh",
              );
              // Subscribe to state changes, refresh when idle
              const listener: StateListener = () => {
                if (navState.state === "idle") {
                  stateListeners.delete(listener);
                  pendingCrossTabRefresh = false;
                  console.log(
                    "[Browser] Cross-tab refresh triggered (deferred)",
                  );
                  crossTabRefreshCallback?.();
                }
              };
              stateListeners.add(listener);
            }
          }
        }
      };
    }
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
     * Removes oldest entries (from front) when over configured cacheSize
     * Fresh data is always stored as not stale (stale=false)
     */
    cacheSegmentsForHistory(
      historyKey: string,
      segments: ResolvedSegment[],
      handleData?: HandleData,
    ): void {
      // Shallow clone handleData arrays to avoid reference sharing between cache entries
      // We only clone the structure (objects and arrays), not the data items themselves,
      // since mutations happen at the array level, not on individual data objects
      const clonedHandleData = handleData
        ? cloneHandleData(handleData)
        : undefined;

      // Check if entry already exists and update it
      const existingIndex = historyCache.findIndex(
        ([key]) => key === historyKey,
      );
      if (existingIndex !== -1) {
        historyCache[existingIndex] = [
          historyKey,
          segments,
          false,
          clonedHandleData,
        ];
      } else {
        // Add new entry at the end (not stale)
        historyCache.push([historyKey, segments, false, clonedHandleData]);
        // Remove oldest entries if over limit
        while (historyCache.length > cacheSize) {
          historyCache.shift();
        }
      }
    },

    /**
     * Get cached segments for a history entry
     * Returns { segments, stale, handleData } or undefined if not cached
     */
    getCachedSegments(
      historyKey: string,
    ):
      | { segments: ResolvedSegment[]; stale: boolean; handleData?: HandleData }
      | undefined {
      const entry = historyCache.find(([key]) => key === historyKey);
      if (!entry) return undefined;
      return { segments: entry[1], stale: entry[2], handleData: entry[3] };
    },

    /**
     * Check if segments are cached for a history entry
     */
    hasHistoryCache(historyKey: string): boolean {
      return historyCache.some(([key]) => key === historyKey);
    },

    /**
     * Update only the handleData for an existing cache entry
     * Does nothing if the cache entry doesn't exist
     * This is used to fix stale handleData after async handles processing
     */
    updateCacheHandleData(historyKey: string, handleData: HandleData): void {
      const existingIndex = historyCache.findIndex(
        ([key]) => key === historyKey,
      );
      if (existingIndex !== -1) {
        const entry = historyCache[existingIndex];
        // Shallow clone handleData arrays to avoid reference sharing
        const clonedHandleData = cloneHandleData(handleData);
        historyCache[existingIndex] = [
          entry[0],
          entry[1],
          entry[2],
          clonedHandleData,
        ];
      }
    },

    /**
     * Mark all cache entries as stale
     * Called after server actions to indicate data may be outdated
     */
    markCacheAsStale(): void {
      markCacheAsStaleInternal();
      console.log(
        "[Browser] Marked",
        historyCache.length,
        "cache entries as stale",
      );
    },

    /**
     * Clear the history cache and broadcast to other tabs
     * Use this for hard invalidation when data is definitely stale
     */
    clearHistoryCache(): void {
      clearCacheAndBroadcast();
    },

    /**
     * Mark cache as stale and broadcast to other tabs
     * Called after server actions - allows SWR pattern for popstate
     */
    markCacheAsStaleAndBroadcast(): void {
      markStaleAndBroadcast();
    },

    /**
     * Broadcast cache invalidation to other tabs without clearing local cache
     * Used after consolidation fetch where local cache has fresh data
     */
    broadcastCacheInvalidation(): void {
      broadcastInvalidation();
    },

    /**
     * Set the callback to invoke when cross-tab refresh is triggered
     * Called by navigation bridge during initialization
     */
    setCrossTabRefreshCallback(callback: () => void): void {
      crossTabRefreshCallback = callback;
    },

    // ========================================================================
    // Intercept Context Tracking
    // ========================================================================

    /**
     * Get the intercept source URL
     * This is the URL where the intercept was triggered from (e.g., /shop)
     * Used to maintain intercept context during action revalidation
     */
    getInterceptSourceUrl(): string | null {
      return interceptSourceUrl;
    },

    /**
     * Set the intercept source URL
     * Called when an intercept navigation is detected
     * Set to null when leaving intercept context (e.g., closing modal)
     */
    setInterceptSourceUrl(url: string | null): void {
      interceptSourceUrl = url;
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

    // ========================================================================
    // Action State Tracking (for useAction hook)
    // ========================================================================

    /**
     * Get the current state for a tracked action
     * Returns default idle state if action hasn't been tracked
     */
    getActionState(actionId: string): TrackedActionState {
      return actionStates.get(actionId) ?? { ...DEFAULT_ACTION_STATE };
    },

    /**
     * Update the state for a tracked action
     * Merges partial state with existing state and notifies listeners
     */
    setActionState(
      actionId: string,
      partial: Partial<TrackedActionState>,
    ): void {
      const current = actionStates.get(actionId) ?? { ...DEFAULT_ACTION_STATE };
      const updated: TrackedActionState = {
        ...current,
        ...partial,
        actionId, // Always set the actionId
      };
      actionStates.set(actionId, updated);
      notifyActionListeners(actionId, updated);
    },

    /**
     * Subscribe to state changes for a specific action
     * Returns unsubscribe function
     */
    subscribeToAction(
      actionId: string,
      listener: ActionStateListener,
    ): () => void {
      let listeners = actionListeners.get(actionId);
      if (!listeners) {
        listeners = new Set();
        actionListeners.set(actionId, listeners);
      }
      listeners.add(listener);

      return () => {
        listeners!.delete(listener);
        // Clean up empty listener sets
        if (listeners!.size === 0) {
          actionListeners.delete(actionId);
        }
      };
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
  config?: NavigationStoreConfig,
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
      "Navigation store not initialized. Call initNavigationStore first.",
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
