import type {
  NavigationLocation,
  SegmentState,
  NavigationStore,
  NavigationUpdate,
  UpdateSubscriber,
  ResolvedSegment,
  HandleData,
} from "./types.js";
import { clearPrefetchCache } from "./prefetch/cache.js";

// Maximum number of history entries to cache (URLs visited)
const HISTORY_CACHE_SIZE = 20;

// Cache entry:
//   [url-key, segments, stale, handleData?, routerId?, navInstance?, handlesPending?]
// stale=true means the data may be outdated and should be revalidated on access.
// navInstance is the monotonic nav-instance token (see navInstance below): it
// identifies the per-commit visit that owns this entry. generateHistoryKey is
// URL-only, so A->B->A reuses the same key; the token lets a late async
// resolution tell its own visit's entry apart from a newer same-URL visit's, so
// a stale nav can never clobber a fresher one.
// handlesPending=true means the entry's handle data is INCOMPLETE (a deferred
// Meta was still pending when the user navigated away, so it never streamed). A
// popstate return must REVALIDATE WITH A FULL RE-RENDER (no client segment IDs)
// to re-stream the handles — a diff-only revalidation omits unchanged segments'
// handles, so the deferred Meta would never land. Cleared once the deferred Meta
// resolves while the entry is still owned.
type HistoryCacheEntry = [
  string,
  ResolvedSegment[],
  boolean,
  HandleData?,
  string?,
  number?,
  boolean?,
];

/**
 * Clone the handleData CONTAINERS (the handle-name map and each segment map) so
 * a cache entry is decoupled from the live map that eventController mutates — it
 * adds/deletes segment keys and REPLACES bucket arrays in place. The bucket
 * arrays themselves are shared by reference, NOT copied: a bucket array is only
 * ever replaced wholesale (eventController.setHandleData reassigns it,
 * resolveDeferredHandleValues builds a fresh one) and collect functions read it
 * without mutating, so sharing is safe and skips an O(elements) copy on every
 * cache write — the per-yield streaming hot path. This also preserves any
 * non-serializable bucket contents (React elements, functions, etc.).
 */
export function cloneHandleData(handleData: HandleData): HandleData {
  const cloned: HandleData = {};
  for (const [handleKey, segmentMap] of Object.entries(handleData)) {
    const clonedMap: Record<string, unknown[]> = {};
    for (const [segmentId, dataArray] of Object.entries(segmentMap)) {
      clonedMap[segmentId] = dataArray;
    }
    cloned[handleKey] = clonedMap;
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
   * When cache is cleared (via server actions or invalidateClientCache()),
   * other tabs will also clear their cache
   */
  crossTabSync?: boolean;

  /**
   * Auto-refresh when another tab mutates data on the same path (default: true)
   * Triggered when cache is cleared via server actions or invalidateClientCache()
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
 * Create a navigation store for browser-side segment and history state.
 *
 * The public navigation lifecycle lives in EventController; this store owns
 * segment reconciliation, history snapshots, and cross-tab cache invalidation.
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

  // History-based segment cache: array of [url-key, segments] tuples
  // Each URL gets its own complete snapshot of segments for back/forward and partial merging
  // Oldest entries (at front) are removed when over cacheSize limit
  const historyCache: HistoryCacheEntry[] = [];

  // Monotonic nav-instance token. Bumped each time a cache entry is created or
  // replaced in cacheSegmentsForHistory (i.e. once per commit). Because
  // generateHistoryKey is URL-only, two visits to the same URL share a key; this
  // token gives each visit a distinct identity so a late async handle resolution
  // can tell whether it still owns the live page / the target cache entry, and
  // never overwrite a newer same-URL visit's state.
  let navInstance = 0;

  // Current history key (set on navigation, stored in history.state)
  let currentHistoryKey = config?.initialHistoryKey || generateHistoryKey();

  // Store initial segments if provided (not stale)
  if (config?.initialHistoryKey && config?.initialSegments) {
    historyCache.push([
      config.initialHistoryKey,
      config.initialSegments,
      false,
      undefined,
      undefined,
      ++navInstance,
      false,
    ]);
  }

  // UI update subscribers (for re-rendering)
  const updateSubscribers = new Set<UpdateSubscriber>();

  // Intercept source URL - tracks where the intercept was triggered from
  // Used to maintain intercept context during action revalidation
  let interceptSourceUrl: string | null = null;

  // Router identity - tracks which router is currently active.
  // When this changes on a partial response, the client forces a full
  // tree replacement instead of reconciling with stale segments.
  let currentRouterId: string | undefined;

  /**
   * Clear the history cache (internal - does not broadcast)
   */
  function clearCacheInternal(): void {
    historyCache.length = 0;
    clearPrefetchCache();
  }

  /**
   * Mark every history entry stale WITHOUT touching the prefetch caches or the
   * rango state. Used by the jar-divergence observer: an external rotation has
   * already changed the state value (so prefetch/HTTP entries strand under the
   * retired key), and this tab must NOT re-rotate — only the history cache,
   * which is not state-keyed, needs marking.
   */
  function markHistoryStale(): void {
    for (let i = 0; i < historyCache.length; i++) {
      historyCache[i][2] = true;
    }
  }

  /**
   * Mark all cache entries as stale (internal - does not broadcast). Also
   * clears the prefetch caches, which rotates the rango state.
   */
  function markCacheAsStaleInternal(): void {
    markHistoryStale();
    clearPrefetchCache();
  }

  /**
   * Clear the history cache and broadcast to other tabs
   */
  function clearCacheAndBroadcast(): void {
    clearCacheInternal();
    broadcastInvalidation();
  }

  /**
   * Mark cache as stale and broadcast to other tabs
   */
  function markStaleAndBroadcast(): void {
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

          markCacheAsStaleInternal();

          // Auto-refresh if enabled and callback is registered
          if (crossTabAutoRefresh && crossTabRefreshCallback) {
            crossTabRefreshCallback();
          }
        }
      };
    }
  }

  return {
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
     * Current nav-instance token: the instance of the most recently committed
     * navigation (the value last written by cacheSegmentsForHistory). A late
     * async handle resolution captures this at the start of its own nav and
     * compares it back here to detect whether a NEWER navigation has since
     * committed (token advanced), guarding against a stale nav writing a fresher
     * nav's live state.
     */
    getNavInstance(): number {
      return navInstance;
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

      // Each commit (create or replace) is a new nav instance. The bump happens
      // here, exactly once per cacheSegmentsForHistory call, so getNavInstance()
      // reflects the visit whose entry this is.
      const instance = ++navInstance;

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
          currentRouterId,
          instance,
          false, // fresh commit: handles complete unless a deferred apply marks it
        ];
      } else {
        // Add new entry at the end (not stale)
        historyCache.push([
          historyKey,
          segments,
          false,
          clonedHandleData,
          currentRouterId,
          instance,
          false,
        ]);
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
    getCachedSegments(historyKey: string):
      | {
          segments: ResolvedSegment[];
          stale: boolean;
          handleData?: HandleData;
          routerId?: string;
          handlesPending?: boolean;
        }
      | undefined {
      const entry = historyCache.find(([key]) => key === historyKey);
      if (!entry) return undefined;
      return {
        segments: entry[1],
        stale: entry[2],
        handleData: entry[3],
        routerId: entry[4],
        handlesPending: entry[6],
      };
    },

    /**
     * Check if segments are cached for a history entry
     */
    hasHistoryCache(historyKey: string): boolean {
      return historyCache.some(([key]) => key === historyKey);
    },

    /**
     * Update only the handleData (and optionally the stale flag) for an existing
     * cache entry. Does nothing if the cache entry doesn't exist.
     *
     * Used to fix stale handleData after async handles processing AND to flip an
     * entry's stale / handlesPending bits for the deferred-Meta
     * invalidate+revalidate path: while a nav's Meta is deferred-pending its
     * entry is marked stale + handlesPending (a popstate return then revalidates
     * with a full re-render instead of serving the carry/seed as fresh), and once
     * the deferred Meta resolves both are cleared. When a flag is omitted the
     * entry's current value is preserved.
     */
    updateCacheHandleData(
      historyKey: string,
      handleData: HandleData,
      stale?: boolean,
      handlesPending?: boolean,
    ): void {
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
          stale ?? entry[2], // set stale when provided, else preserve current
          clonedHandleData,
          entry[4], // preserve routerId
          entry[5], // preserve navInstance (entry ownership identity)
          handlesPending ?? entry[6], // set when provided, else preserve current
        ];
      }
    },

    /**
     * Owner-guarded handle-data write: locate the entry, and write ONLY when it
     * is still owned by `ownerInstance` (the nav-instance token that seeded it).
     * Folds the streaming hot path's separate getCacheEntryInstance() ownership
     * probe and updateCacheHandleData() write into a SINGLE historyCache scan
     * (processHandles calls this per yield). Semantics otherwise match
     * updateCacheHandleData: no-op on a missing entry, clone the handleData
     * containers, and preserve stale / handlesPending when the flag is omitted.
     */
    updateCacheHandleDataIfOwned(
      historyKey: string,
      handleData: HandleData,
      ownerInstance: number,
      stale?: boolean,
      handlesPending?: boolean,
    ): void {
      const existingIndex = historyCache.findIndex(
        ([key]) => key === historyKey,
      );
      if (existingIndex === -1) return;
      const entry = historyCache[existingIndex];
      if (entry[5] !== ownerInstance) return;
      const clonedHandleData = cloneHandleData(handleData);
      historyCache[existingIndex] = [
        entry[0],
        entry[1],
        stale ?? entry[2],
        clonedHandleData,
        entry[4],
        entry[5],
        handlesPending ?? entry[6],
      ];
    },

    /**
     * Mark every history entry stale WITHOUT clearing the prefetch caches or
     * rotating the rango state. The jar-divergence observer calls this after an
     * external rotation has already changed the state value, so re-rotating
     * here would ping-pong with the tab that rotated.
     */
    markHistoryCacheStale(): void {
      markHistoryStale();
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

    getRouterId(): string | undefined {
      return currentRouterId;
    },

    setRouterId(id: string): void {
      currentRouterId = id;
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
