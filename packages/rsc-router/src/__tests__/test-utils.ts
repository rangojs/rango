import { vi } from "vitest";
import type {
  RscPayload,
  RscMetadata,
  ResolvedSegment,
  NavigationStore,
  NavigationClient,
  FetchPartialOptions,
  FetchPartialResult,
  NavigationState,
  SegmentState,
  TrackedActionState,
  ActionStateListener,
  StateListener,
  UpdateSubscriber,
  NavigationUpdate,
  InflightAction,
} from "../browser/types.js";

// ============================================================================
// Mock Payload Helpers
// ============================================================================

/**
 * Options for creating a mock RSC payload
 */
export interface MockPayloadOptions {
  segments?: ResolvedSegment[];
  matched?: string[];
  diff?: string[];
  isPartial?: boolean;
  pathname?: string;
  slots?: Record<string, { active: boolean }>;
  returnValue?: { ok: boolean; data: unknown };
}

/**
 * Create a mock RSC payload for testing
 */
export function createMockPayload(options: MockPayloadOptions = {}): RscPayload {
  const {
    segments = [],
    matched = [],
    diff = [],
    isPartial = true,
    pathname = "/test",
    slots,
    returnValue,
  } = options;

  return {
    root: null,
    metadata: {
      pathname,
      segments,
      matched,
      diff,
      isPartial,
      slots,
    },
    returnValue,
  };
}

/**
 * Options for creating a mock segment
 */
export interface MockSegmentOptions {
  type?: "layout" | "route" | "loader" | "parallel";
  index?: number;
  namespace?: string;
  loaderData?: unknown;
  component?: unknown;
}

/**
 * Create a mock segment for testing
 */
export function createMockSegment(
  id: string,
  options: MockSegmentOptions = {}
): ResolvedSegment {
  const {
    type = "layout",
    index = 0,
    namespace,
    loaderData,
    component = null,
  } = options;

  return {
    id,
    type,
    index,
    component,
    namespace,
    loaderData,
  } as ResolvedSegment;
}

// ============================================================================
// Mock Navigation Store
// ============================================================================

export interface MockNavigationStore extends NavigationStore {
  // Test helpers
  _cache: Map<string, { segments: ResolvedSegment[]; stale: boolean }>;
  _setCache: (
    key: string,
    segments: ResolvedSegment[],
    stale?: boolean
  ) => void;
  _getInterceptSourceUrl: () => string | null;
}

/**
 * Create a mock navigation store for testing
 */
export function createMockStore(): MockNavigationStore {
  const cache = new Map<string, { segments: ResolvedSegment[]; stale: boolean }>();
  const stateListeners = new Set<StateListener>();
  const updateListeners = new Set<UpdateSubscriber>();
  const actionListeners = new Map<string, Set<ActionStateListener>>();
  const actionStates = new Map<string, TrackedActionState>();

  let historyKey = "/";
  let currentSegmentIds: string[] = [];
  let currentUrl = "http://localhost/";
  let path = "/";
  let interceptSourceUrl: string | null = null;
  let actionInProgress = false;
  let inflightActions: InflightAction[] = [];

  const navState: NavigationState = {
    state: "idle",
    isStreaming: false,
    location: new URL("http://localhost/"),
    inflightActions: [],
  };

  const store: MockNavigationStore = {
    // Public state
    getState: vi.fn(() => ({ ...navState, inflightActions })),
    setState: vi.fn((partial: Partial<NavigationState>) => {
      Object.assign(navState, partial);
      stateListeners.forEach((l) => l());
    }),
    subscribe: vi.fn((listener: StateListener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),

    // Inflight actions
    addInflightAction: vi.fn((action: InflightAction) => {
      inflightActions.push(action);
    }),
    removeInflightAction: vi.fn((id: string) => {
      inflightActions = inflightActions.filter((a) => a.id !== id);
    }),

    // Action state
    isActionInProgress: vi.fn(() => actionInProgress),
    setActionInProgress: vi.fn((value: boolean) => {
      actionInProgress = value;
    }),

    // Segment state
    getSegmentState: vi.fn(
      (): SegmentState => ({
        currentSegmentIds,
        currentUrl,
        path,
      })
    ),
    setPath: vi.fn((p: string) => {
      path = p;
    }),
    setCurrentUrl: vi.fn((url: string) => {
      currentUrl = url;
    }),
    setSegmentIds: vi.fn((ids: string[]) => {
      currentSegmentIds = ids;
    }),

    // History cache
    getHistoryKey: vi.fn(() => historyKey),
    setHistoryKey: vi.fn((key: string) => {
      historyKey = key;
    }),
    cacheSegmentsForHistory: vi.fn((key: string, segments: ResolvedSegment[]) => {
      cache.set(key, { segments, stale: false });
    }),
    getCachedSegments: vi.fn((key: string) => cache.get(key)),
    hasHistoryCache: vi.fn((key: string) => cache.has(key)),
    markCacheAsStale: vi.fn(() => {
      cache.forEach((entry) => {
        entry.stale = true;
      });
    }),
    markCacheAsStaleAndBroadcast: vi.fn(() => {
      cache.forEach((entry) => {
        entry.stale = true;
      });
    }),
    clearHistoryCache: vi.fn(() => {
      cache.clear();
    }),
    broadcastCacheInvalidation: vi.fn(),

    // Cross-tab refresh
    setCrossTabRefreshCallback: vi.fn(),

    // Intercept context
    getInterceptSourceUrl: vi.fn(() => interceptSourceUrl),
    setInterceptSourceUrl: vi.fn((url: string | null) => {
      interceptSourceUrl = url;
    }),

    // UI updates
    onUpdate: vi.fn((callback: UpdateSubscriber) => {
      updateListeners.add(callback);
      return () => updateListeners.delete(callback);
    }),
    emitUpdate: vi.fn((update: NavigationUpdate) => {
      updateListeners.forEach((l) => l(update));
    }),

    // Action state tracking
    getActionState: vi.fn((actionId: string): TrackedActionState => {
      return (
        actionStates.get(actionId) || {
          state: "idle",
          actionId: null,
          payload: null,
          error: null,
          result: null,
        }
      );
    }),
    setActionState: vi.fn(
      (actionId: string, state: Partial<TrackedActionState>) => {
        const current = actionStates.get(actionId) || {
          state: "idle",
          actionId: null,
          payload: null,
          error: null,
          result: null,
        };
        actionStates.set(actionId, { ...current, ...state });
        const listeners = actionListeners.get(actionId);
        if (listeners) {
          const newState = actionStates.get(actionId)!;
          listeners.forEach((l) => l(newState));
        }
      }
    ),
    subscribeToAction: vi.fn(
      (actionId: string, listener: ActionStateListener) => {
        let listeners = actionListeners.get(actionId);
        if (!listeners) {
          listeners = new Set();
          actionListeners.set(actionId, listeners);
        }
        listeners.add(listener);
        return () => {
          listeners!.delete(listener);
          if (listeners!.size === 0) {
            actionListeners.delete(actionId);
          }
        };
      }
    ),

    // Test helpers
    _cache: cache,
    _setCache: (key: string, segments: ResolvedSegment[], stale = false) => {
      cache.set(key, { segments, stale });
    },
    _getInterceptSourceUrl: () => interceptSourceUrl,
  };

  return store;
}

// ============================================================================
// Mock RSC Client
// ============================================================================

export interface MockNavigationClient extends NavigationClient {
  // Test helpers
  _queueResponse: (payload: RscPayload) => void;
  _queueError: (error: Error) => void;
  _resetResponses: () => void;
  _getLastFetchOptions: () => FetchPartialOptions | undefined;
}

/**
 * Create a mock RSC navigation client for testing
 */
export function createMockClient(): MockNavigationClient {
  const responseQueue: Array<{ type: "success"; payload: RscPayload } | { type: "error"; error: Error }> = [];
  let lastFetchOptions: FetchPartialOptions | undefined;

  return {
    fetchPartial: vi.fn(
      async (options: FetchPartialOptions): Promise<FetchPartialResult> => {
        lastFetchOptions = options;

        const response = responseQueue.shift();
        if (response?.type === "error") {
          throw response.error;
        }

        const payload = response?.payload || createMockPayload({});

        return {
          payload,
          streamComplete: Promise.resolve(),
        };
      }
    ),

    // Test helpers
    _queueResponse: (payload: RscPayload) => {
      responseQueue.push({ type: "success", payload });
    },
    _queueError: (error: Error) => {
      responseQueue.push({ type: "error", error });
    },
    _resetResponses: () => {
      responseQueue.length = 0;
      lastFetchOptions = undefined;
    },
    _getLastFetchOptions: () => lastFetchOptions,
  };
}

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Wait for debounced notifications to be processed
 */
export async function flushNotifications(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Wait for a specific number of milliseconds
 */
export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise for async testing
 */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

/**
 * Mock render segments function
 */
export function createMockRenderSegments(): {
  renderSegments: (
    segments: ResolvedSegment[],
    options?: { isAction?: boolean; forceAwait?: boolean; interceptSegments?: ResolvedSegment[] }
  ) => Promise<null>;
  getLastCall: () => { segments: ResolvedSegment[]; options?: unknown } | undefined;
  resetCalls: () => void;
} {
  let lastCall: { segments: ResolvedSegment[]; options?: unknown } | undefined;

  const renderSegments = vi.fn(
    async (segments: ResolvedSegment[], options?: unknown): Promise<null> => {
      lastCall = { segments, options };
      return null;
    }
  );

  return {
    renderSegments,
    getLastCall: () => lastCall,
    resetCalls: () => {
      lastCall = undefined;
      renderSegments.mockClear();
    },
  };
}
