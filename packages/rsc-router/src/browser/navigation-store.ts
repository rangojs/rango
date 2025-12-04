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
import type {
  StoreEvent,
  StoreEventType,
  StoreEventListener,
  StoreSnapshot,
  StorePhase,
  InflightNavigation,
  IdleCallback,
} from "./store-events.js";

// Maximum number of history entries to cache (URLs visited)
const HISTORY_CACHE_SIZE = 20;

// Cache entry: [url-key, segments]
type HistoryCacheEntry = [string, ResolvedSegment[]];

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

  /**
   * Maximum number of history entries to cache (default: 20)
   * Older entries are evicted when limit is reached
   */
  cacheSize?: number;
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

  // Configuration with defaults
  const cacheSize = config?.cacheSize ?? HISTORY_CACHE_SIZE;

  // History-based segment cache: array of [url-key, segments] tuples
  // Each URL gets its own complete snapshot of segments for back/forward and partial merging
  // Oldest entries (at front) are removed when over cacheSize limit
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

  // Intercept source URL - tracks where the intercept was triggered from
  // Used to maintain intercept context during action revalidation
  let interceptSourceUrl: string | null = null;

  // ========================================================================
  // Event Emitter State
  // ========================================================================

  // Event listeners by event type
  const eventListeners = new Map<string, Set<StoreEventListener<any>>>();

  // Hydration tracking
  let isHydrated = false;
  const hydrationStartTime = Date.now();

  // Inflight navigation tracking (separate from actions)
  let inflightNavigation: InflightNavigation | null = null;

  // Action phases (track streaming state per action)
  const actionPhases = new Map<string, "loading" | "streaming">();

  // Queued callbacks to run when idle
  const idleQueue: IdleCallback[] = [];

  // Track if we were busy before (for emitting global idle)
  let wasBusy = false;

  /**
   * Notify all state listeners of a change
   */
  function notifyStateListeners(): void {
    stateListeners.forEach((listener) => listener());
  }

  /**
   * Get current URL for events
   */
  function getCurrentUrl(): string {
    return typeof window !== "undefined" ? window.location.href : "/";
  }

  /**
   * Emit an event to all listeners
   */
  function emitEvent(event: StoreEvent): void {
    // Track busy state before emitting
    const currentPhase = computePhase();
    const isBusy = currentPhase !== "idle";

    // Emit to specific listeners
    const listeners = eventListeners.get(event.type);
    if (listeners) {
      listeners.forEach((listener) => listener(event));
    }

    // Emit to wildcard listeners
    const wildcardListeners = eventListeners.get("*");
    if (wildcardListeners) {
      wildcardListeners.forEach((listener) => listener(event));
    }

    // Check if we transitioned to idle - emit global "idle" event
    if (wasBusy && !isBusy) {
      const idleEvent: StoreEvent = {
        type: "idle",
        url: getCurrentUrl(),
      };
      const idleListeners = eventListeners.get("idle");
      if (idleListeners) {
        idleListeners.forEach((listener) => listener(idleEvent));
      }
      if (wildcardListeners) {
        wildcardListeners.forEach((listener) => listener(idleEvent));
      }
    }

    wasBusy = isBusy;

    // Check if we should run idle queue
    if (!isBusy) {
      maybeRunIdleQueue();
    }
  }

  /**
   * Compute current store phase based on inflight state
   */
  function computePhase(): StorePhase {
    // Check if any action is streaming
    for (const phase of actionPhases.values()) {
      if (phase === "streaming") return "streaming";
    }
    // Check navigation streaming
    if (inflightNavigation?.phase === "streaming") return "streaming";

    // Check if anything is loading
    for (const phase of actionPhases.values()) {
      if (phase === "loading") return "loading";
    }
    if (inflightNavigation?.phase === "loading") return "loading";

    return "idle";
  }

  /**
   * Check if store is idle and run queued callbacks
   */
  function maybeRunIdleQueue(): void {
    if (computePhase() !== "idle") return;
    if (idleQueue.length === 0) return;

    // Run all queued callbacks
    const callbacks = [...idleQueue];
    idleQueue.length = 0;

    for (const callback of callbacks) {
      try {
        const result = callback();
        if (result instanceof Promise) {
          result.catch((err) => console.error("[Store] Idle callback error:", err));
        }
      } catch (err) {
        console.error("[Store] Idle callback error:", err);
      }
    }
  }

  /**
   * Clear the history cache
   */
  function clearCache(): void {
    historyCache.length = 0;
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
        while (historyCache.length > cacheSize) {
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
     * Clear the history cache
     * Called after server action commit to invalidate stale data
     */
    clearHistoryCache(): void {
      clearCache();
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
    // Event Emitter
    // ========================================================================

    /**
     * Subscribe to store events
     */
    on<T extends StoreEventType | "*">(
      event: T,
      listener: StoreEventListener<any>
    ): () => void {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners!.delete(listener);
        if (listeners!.size === 0) {
          eventListeners.delete(event);
        }
      };
    },

    /**
     * Remove an event listener
     */
    off<T extends StoreEventType | "*">(
      event: T,
      listener: StoreEventListener<any>
    ): void {
      const listeners = eventListeners.get(event);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          eventListeners.delete(event);
        }
      }
    },

    /**
     * Emit a store event
     *
     * Automatically updates NavigationState based on event type:
     * - navigation:start → { state: "loading", location: toUrl }
     * - navigation:streaming → { isStreaming: true }
     * - navigation:idle/cancelled/error → { state: "idle", isStreaming: false }
     * - action:start → { state: "loading" } (if no navigation in progress)
     * - action:streaming → { isStreaming: true }
     * - action:idle/cancelled/error → { state: "idle", isStreaming: false } (if last action)
     */
    emit(event: StoreEvent): void {
      // Update internal tracking based on event type
      switch (event.type) {
        // Global events
        case "hydrated":
          isHydrated = true;
          break;
        case "idle":
        case "error":
          // No internal state changes for these
          break;

        // Navigation events
        case "navigation:start":
          inflightNavigation = {
            fromUrl: event.fromUrl,
            toUrl: event.toUrl,
            startedAt: Date.now(),
            phase: "loading",
          };
          // Derive NavigationState: set loading and update location optimistically
          navState = {
            ...navState,
            state: "loading",
            location: new URL(event.toUrl, navState.location.origin),
            isStreaming: false,
          };
          notifyStateListeners();
          break;

        case "navigation:loaded":
          if (inflightNavigation) {
            inflightNavigation.phase = "loading";
          }
          // No NavigationState change - still loading
          break;

        case "navigation:streaming":
          if (inflightNavigation) {
            inflightNavigation.phase = "streaming";
          }
          // Derive NavigationState: streaming started
          // state becomes "idle" because we're no longer waiting for initial response
          // isStreaming stays true until stream completes
          navState = { ...navState, state: "idle", isStreaming: true };
          notifyStateListeners();
          break;

        case "navigation:idle":
        case "navigation:cancelled":
        case "navigation:error":
          inflightNavigation = null;
          // Derive NavigationState: navigation complete
          // Only go idle if no actions are in flight
          if (actionPhases.size === 0) {
            navState = { ...navState, state: "idle", isStreaming: false };
            notifyStateListeners();
          }
          break;

        // Action events
        case "action:start":
          actionPhases.set(event.id, "loading");
          // Derive NavigationState: set loading (even if navigation is in progress)
          // Actions always trigger loading state
          navState = { ...navState, state: "loading" };
          notifyStateListeners();
          break;

        case "action:loaded":
          actionPhases.set(event.id, "loading");
          // No NavigationState change - still loading
          break;

        case "action:streaming":
          actionPhases.set(event.id, "streaming");
          // Derive NavigationState: streaming started
          // state becomes "idle" because we're no longer waiting for initial response
          // isStreaming stays true until stream completes
          navState = { ...navState, state: "idle", isStreaming: true };
          notifyStateListeners();
          break;

        case "action:idle":
        case "action:cancelled":
        case "action:error":
          actionPhases.delete(event.id);
          // Derive NavigationState: only go idle if this was the last action
          // AND no navigation is in progress
          if (actionPhases.size === 0 && !inflightNavigation) {
            navState = { ...navState, state: "idle", isStreaming: false };
            notifyStateListeners();
          }
          break;
      }

      emitEvent(event);
    },

    /**
     * Get a readonly snapshot of current store state
     */
    getSnapshot(): StoreSnapshot {
      const phase = computePhase();
      const actions = navState.inflightActions.map((a) => ({
        id: a.id,
        actionId: a.actionId,
        payload: a.payload as readonly unknown[],
        startedAt: a.startedAt,
        phase: actionPhases.get(a.id) ?? ("loading" as const),
      }));

      return {
        phase,
        isHydrated,
        inflightNavigation: inflightNavigation
          ? { ...inflightNavigation }
          : null,
        inflightActions: actions,
        location: navState.location,
        isBusy: phase !== "idle",
        isNavigating: inflightNavigation !== null,
        hasInflightActions: actions.length > 0,
      };
    },

    /**
     * Enqueue a callback to run when store becomes idle
     */
    enqueue(callback: IdleCallback): void {
      if (computePhase() === "idle") {
        // Already idle, run immediately
        try {
          const result = callback();
          if (result instanceof Promise) {
            result.catch((err) => console.error("[Store] Enqueue callback error:", err));
          }
        } catch (err) {
          console.error("[Store] Enqueue callback error:", err);
        }
      } else {
        idleQueue.push(callback);
      }
    },

    /**
     * Cancel pending operations and run queued callbacks
     */
    flush(): void {
      // Clear inflight state
      if (inflightNavigation) {
        emitEvent({
          type: "navigation:cancelled",
          fromUrl: inflightNavigation.fromUrl,
          toUrl: inflightNavigation.toUrl,
          reason: "aborted",
        });
        inflightNavigation = null;
      }

      // Clear action phases (actions themselves are tracked externally)
      for (const [id] of actionPhases) {
        const action = navState.inflightActions.find((a) => a.id === id);
        if (action) {
          emitEvent({
            type: "action:cancelled",
            id,
            actionId: action.actionId,
            url: getCurrentUrl(),
            reason: "aborted",
          });
        }
      }
      actionPhases.clear();

      // Run queued callbacks
      const callbacks = [...idleQueue];
      idleQueue.length = 0;

      for (const callback of callbacks) {
        try {
          const result = callback();
          if (result instanceof Promise) {
            result.catch((err) => console.error("[Store] Flush callback error:", err));
          }
        } catch (err) {
          console.error("[Store] Flush callback error:", err);
        }
      }
    },

    /**
     * Mark the store as hydrated.
     * Should be called once after initial client-side hydration completes.
     */
    markHydrated(): void {
      if (isHydrated) return;

      const duration = Date.now() - hydrationStartTime;
      emitEvent({
        type: "hydrated",
        url: getCurrentUrl(),
        duration,
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
