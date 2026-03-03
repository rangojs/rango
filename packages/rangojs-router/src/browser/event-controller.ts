import type { ReactNode } from "react";
import type {
  NavigationLocation,
  NavigateOptions,
  TrackedActionState,
  ActionLifecycleState,
  InflightAction,
  ResolvedSegment,
  RscMetadata,
  HandleData,
  StreamingToken,
} from "./types.js";

// Polyfill Symbol.dispose for Safari and older browsers
if (typeof Symbol.dispose === "undefined") {
  (Symbol as any).dispose = Symbol("Symbol.dispose");
}
if (typeof Symbol.asyncDispose === "undefined") {
  (Symbol as any).asyncDispose = Symbol("Symbol.asyncDispose");
}

// ============================================================================
// Types
// ============================================================================

/**
 * Phase of a navigation operation
 */
export type NavigationPhase = "fetching" | "streaming";

/**
 * Phase of an action operation
 */
export type ActionPhase = "fetching" | "streaming" | "settling";

/**
 * Entry tracking an in-flight navigation
 */
export interface NavigationEntry {
  url: string;
  abort: AbortController;
  phase: NavigationPhase;
  startedAt: number;
  options?: NavigateOptions & { skipLoadingState?: boolean };
}

/**
 * Entry tracking an in-flight action
 */
export interface ActionEntry {
  /** Unique instance ID for this action invocation */
  id: string;
  /** Server action function ID (normalized name like "addToCart") */
  actionId: string;
  /** Abort controller for this action */
  abort: AbortController;
  /** Current phase of the action */
  phase: ActionPhase;
  /** Action arguments */
  payload: unknown[];
  /** Result from action (set on completion) */
  result?: unknown;
  /** Error from action (set on failure) */
  error?: unknown;
  /** Segment IDs that were revalidated by this action */
  revalidatedSegments: string[];
  /** Timestamp when action started */
  startedAt: number;
  /** Whether action processing is complete (may still be streaming) */
  completed?: boolean;
}

/**
 * Derived navigation state (computed from source of truth)
 */
export interface DerivedNavigationState {
  /** Navigation lifecycle state */
  state: "idle" | "loading";
  /** Whether any operation is streaming */
  isStreaming: boolean;
  /** Current committed location */
  location: NavigationLocation;
  /** URL being navigated to (null if idle) */
  pendingUrl: string | null;
  /** List of inflight actions (for compatibility) */
  inflightActions: InflightAction[];
}

/**
 * Callback for UI updates when root should re-render
 */
export type UpdateCallback = (update: {
  root: ReactNode | Promise<ReactNode>;
  metadata: RscMetadata;
}) => void;

/**
 * State change listener
 */
export type StateListener = () => void;

/**
 * Action state listener
 */
export type ActionStateListener = (state: TrackedActionState) => void;

/**
 * Handle state listener
 */
export type HandleListener = () => void;

/**
 * Internal handle state stored in controller
 */
export interface HandleState {
  data: HandleData;
  segmentOrder: string[];
}

/**
 * Result from starting a navigation
 * Implements Disposable for use with `using` keyword
 */
export interface NavigationHandle extends Disposable {
  /** Abort controller for this navigation */
  abort: AbortController;
  /** Signal for this navigation */
  signal: AbortSignal;
  /** Start streaming and get a token to end it later */
  startStreaming(): StreamingToken;
  /** Complete the navigation successfully */
  complete(location: NavigationLocation): void;
  /** Whether navigation was completed successfully */
  readonly completed: boolean;
}

/**
 * Result from starting an action
 * Implements Disposable for use with `using` keyword
 */
export interface ActionHandle extends Disposable {
  /** Unique instance ID */
  id: string;
  /** Abort controller for this action */
  abort: AbortController;
  /** Signal for this action */
  signal: AbortSignal;
  /** Start streaming and get a token to end it later */
  startStreaming(): StreamingToken;
  /** Record segments that were revalidated */
  recordRevalidatedSegments(segmentIds: string[]): void;
  /** Complete the action with result */
  complete(result?: unknown): void;
  /** Fail the action with error */
  fail(error: unknown): void;
  /** Whether action was completed (success or failure) */
  readonly settled: boolean;
  /** Check if any concurrent actions were started */
  hadConcurrentActions: boolean;
  /** Get segments to consolidate (only valid when this is the last action) */
  getConsolidationSegments(): string[] | null;
  /** Clear consolidation tracking */
  clearConsolidation(): void;
}

/**
 * Event controller interface
 */
export interface EventController {
  // Navigation operations
  startNavigation(
    url: string,
    options?: NavigateOptions & { skipLoadingState?: boolean },
  ): NavigationHandle;
  abortNavigation(): void;

  // Action operations
  startAction(actionId: string, args: unknown[]): ActionHandle;
  abortAllActions(): void;

  // State access
  getState(): DerivedNavigationState;
  getActionState(actionId: string): TrackedActionState;

  // Location updates (for popstate where navigation doesn't go through startNavigation)
  setLocation(location: NavigationLocation): void;

  // Subscriptions
  subscribe(listener: StateListener): () => void;
  subscribeToAction(
    actionId: string,
    listener: ActionStateListener,
  ): () => void;
  subscribeToHandles(listener: HandleListener): () => void;

  // Handle operations
  setHandleData(
    data: HandleData,
    matched?: string[],
    isPartial?: boolean,
  ): void;
  getHandleState(): HandleState;

  // Params operations
  setParams(params: Record<string, string>): void;
  getParams(): Record<string, string>;

  // Direct state access for advanced use
  getCurrentNavigation(): NavigationEntry | null;
  getInflightActions(): Map<string, ActionEntry>;
}

// ============================================================================
// Default States
// ============================================================================

const DEFAULT_ACTION_STATE: TrackedActionState = {
  state: "idle",
  actionId: null,
  payload: null,
  error: null,
  result: null,
};

/**
 * Check if a subscription ID matches an action's full ID.
 *
 * When subscriptionId contains '#', it's a full ID and requires exact match.
 * When subscriptionId has no '#', it's just an action name and matches by suffix.
 * This allows useAction("addToCart") to match "hash#addToCart" or "src/file.ts#addToCart".
 */
function matchesActionId(
  subscriptionId: string,
  entryActionId: string,
): boolean {
  if (subscriptionId.includes("#")) {
    // Full ID: exact match
    return subscriptionId === entryActionId;
  }
  // Action name only: suffix match (matches "anything#actionName")
  return entryActionId.endsWith(`#${subscriptionId}`);
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Configuration for creating an event controller
 */
export interface EventControllerConfig {
  initialLocation?: NavigationLocation;
}

/**
 * Create an event controller for managing navigation and action state
 *
 * The controller uses a reactive model where:
 * - Source of truth: currentNavigation, inflightActions, location
 * - Derived state: navState, isStreaming computed from source
 *
 * Navigation uses switchMap semantics (new nav cancels previous).
 * Actions use mergeMap semantics (all run concurrently, consolidate at end).
 */
export function createEventController(
  config?: EventControllerConfig,
): EventController {
  // ========================================================================
  // Source of Truth
  // ========================================================================

  // Current navigation in progress (null = idle)
  let currentNavigation: NavigationEntry | null = null;

  // All in-flight actions (keyed by unique instance ID)
  const inflightActions = new Map<string, ActionEntry>();

  // Committed location (updated when navigation completes)
  let location: NavigationLocation =
    config?.initialLocation ??
    (typeof window !== "undefined"
      ? new URL(window.location.href)
      : new URL("/", "http://localhost"));

  // Track if any concurrent actions occurred (for consolidation)
  let hadAnyConcurrentActions = false;

  // Track segments revalidated by concurrent actions
  const concurrentRevalidatedSegments = new Set<string>();

  // Active streaming count (independent of navigation/action lifecycle)
  let activeStreamCount = 0;

  // Handle data from RSC payload
  let handleData: HandleData = {};
  let handleSegmentOrder: string[] = [];

  // Merged route params from current match
  let routeParams: Record<string, string> = {};

  // ========================================================================
  // Listeners
  // ========================================================================

  const stateListeners = new Set<StateListener>();
  const actionListeners = new Map<string, Set<ActionStateListener>>();
  const handleListeners = new Set<HandleListener>();

  // Debounce state notifications to batch rapid updates
  let notifyTimeout: ReturnType<typeof setTimeout> | null = null;

  function notify() {
    if (notifyTimeout !== null) {
      clearTimeout(notifyTimeout);
    }
    notifyTimeout = setTimeout(() => {
      notifyTimeout = null;
      stateListeners.forEach((listener) => listener());
    }, 0);
  }

  // Debounce per-action notifications
  const actionNotifyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function notifyAction(actionId: string) {
    const existing = actionNotifyTimeouts.get(actionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    actionNotifyTimeouts.set(
      actionId,
      setTimeout(() => {
        actionNotifyTimeouts.delete(actionId);
        // Notify all listeners whose subscription ID matches this action
        // This includes exact matches and suffix matches (e.g., "addToCart" matches "hash#addToCart")
        for (const [subscriptionId, listeners] of actionListeners) {
          if (matchesActionId(subscriptionId, actionId)) {
            const state = getActionState(subscriptionId);
            listeners.forEach((listener) => listener(state));
          }
        }
      }, 0),
    );
  }

  // Debounce handle notifications
  let handleNotifyTimeout: ReturnType<typeof setTimeout> | null = null;

  function notifyHandles() {
    if (handleNotifyTimeout !== null) {
      clearTimeout(handleNotifyTimeout);
    }
    handleNotifyTimeout = setTimeout(() => {
      handleNotifyTimeout = null;
      handleListeners.forEach((listener) => listener());
    }, 0);
  }

  // ========================================================================
  // Derived State
  // ========================================================================

  function getState(): DerivedNavigationState {
    // Build inflight actions list (for compatibility with existing API)
    const inflightActionsList: InflightAction[] = [...inflightActions.values()]
      .filter((a) => a.phase !== "settling")
      .map((a) => ({
        id: a.id,
        actionId: a.actionId,
        payload: a.payload,
        startedAt: a.startedAt,
      }));

    // State: loading if navigation OR actions are in progress
    // Background revalidations (skipLoadingState) don't affect visible state
    const hasActiveActions = inflightActionsList.length > 0;
    const isVisibleNavigation =
      currentNavigation !== null &&
      !currentNavigation.options?.skipLoadingState;
    const state = isVisibleNavigation || hasActiveActions ? "loading" : "idle";

    // Streaming: true if any active streams (navigation or action) or loading
    const isStreaming = activeStreamCount > 0 || state === "loading";

    return {
      state,
      isStreaming,
      location,
      // pendingUrl only during fetching phase - once streaming starts (URL changed), not pending
      // Background revalidations don't expose a pending URL
      pendingUrl:
        currentNavigation?.phase === "fetching" &&
        !currentNavigation.options?.skipLoadingState
          ? currentNavigation.url
          : null,
      inflightActions: inflightActionsList,
    };
  }

  function getActionState(actionId: string): TrackedActionState {
    // Find the most recent action with this ID that's not settling
    // Uses suffix matching when actionId is just a name (no #)
    const activeEntry = [...inflightActions.values()]
      .filter(
        (a) => matchesActionId(actionId, a.actionId) && a.phase !== "settling",
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];

    // Also check for settling entries to get result/error
    const settlingEntry = [...inflightActions.values()]
      .filter(
        (a) => matchesActionId(actionId, a.actionId) && a.phase === "settling",
      )
      .sort((a, b) => b.startedAt - a.startedAt)[0];

    const entry = activeEntry || settlingEntry;

    if (!entry) {
      return { ...DEFAULT_ACTION_STATE };
    }

    // Derive state from phase
    let state: ActionLifecycleState;
    switch (entry.phase) {
      case "fetching":
        state = "loading";
        break;
      case "streaming":
        state = "streaming";
        break;
      case "settling":
        state = "idle";
        break;
    }

    return {
      state,
      actionId: entry.actionId,
      payload: entry.payload,
      error: entry.error ?? null,
      result: entry.result ?? null,
    };
  }

  // ========================================================================
  // Navigation Operations
  // ========================================================================

  function startNavigation(
    url: string,
    options?: NavigateOptions & { skipLoadingState?: boolean },
  ): NavigationHandle {
    // Cancel existing navigation (switchMap semantics)
    if (currentNavigation) {
      currentNavigation.abort.abort();
      currentNavigation = null;
    }

    const abort = new AbortController();
    const entry: NavigationEntry = {
      url,
      abort,
      phase: "fetching",
      startedAt: Date.now(),
      options,
    };

    currentNavigation = entry;
    notify();

    let completed = false;

    return {
      abort,
      signal: abort.signal,

      get completed() {
        return completed;
      },

      startStreaming(): StreamingToken {
        let ended = false;
        activeStreamCount++;
        notify();

        return {
          end() {
            if (ended) return;
            ended = true;
            activeStreamCount = Math.max(0, activeStreamCount - 1);
            notify();
          },
        };
      },

      complete(newLocation: NavigationLocation) {
        if (currentNavigation === entry) {
          completed = true;
          location = newLocation;
          currentNavigation = null;
          notify();
        }
      },

      // Disposable: cleanup if not completed (e.g., error thrown)
      [Symbol.dispose]() {
        // If aborted by another navigation, don't touch state
        if (abort.signal.aborted) return;

        // If not completed, reset to idle
        if (!completed && currentNavigation === entry) {
          currentNavigation = null;
          notify();
        }
      },
    };
  }

  function abortNavigation() {
    if (currentNavigation) {
      currentNavigation.abort.abort();
      currentNavigation = null;
      notify();
    }
  }

  function setLocation(newLocation: NavigationLocation) {
    location = newLocation;
    notify();
  }

  // ========================================================================
  // Action Operations
  // ========================================================================

  function startAction(actionId: string, args: unknown[]): ActionHandle {
    const id = `${actionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const abort = new AbortController();

    // Track if this action started while others were pending (concurrent)
    const hadConcurrent = inflightActions.size > 0;
    if (hadConcurrent) {
      hadAnyConcurrentActions = true;
    }

    const entry: ActionEntry = {
      id,
      actionId,
      abort,
      phase: "fetching",
      payload: args,
      revalidatedSegments: [],
      startedAt: Date.now(),
    };

    inflightActions.set(id, entry);
    notify();
    notifyAction(actionId);

    let settled = false;
    let streamingEnded = false;
    let actionCompleted = false;
    let pendingResult:
      | { type: "success"; value?: unknown }
      | { type: "error"; value: unknown }
      | null = null;

    function doSettle() {
      if (settled) return;
      settled = true;

      // Cleanup after brief delay (allow useAction to read result)
      setTimeout(() => {
        inflightActions.delete(id);
        // Check for consolidation
        if (inflightActions.size === 0) {
          // All actions done - reset tracking
          hadAnyConcurrentActions = false;
          concurrentRevalidatedSegments.clear();
        }
        notify();
        notifyAction(actionId);
      }, 100);
    }

    // Called when both action is done AND streaming has ended
    function tryFinalize() {
      if (!actionCompleted || !streamingEnded) return;
      if (settled) return;

      // Apply the pending result
      if (pendingResult?.type === "error") {
        entry.error = pendingResult.value;
      } else if (pendingResult?.type === "success") {
        entry.result = pendingResult.value;
      }
      entry.phase = "settling";
      notify();
      notifyAction(actionId);
      doSettle();
    }

    return {
      id,
      abort,
      signal: abort.signal,
      hadConcurrentActions: hadConcurrent,

      get settled() {
        return settled;
      },

      startStreaming(): StreamingToken {
        let ended = false;
        activeStreamCount++;
        entry.phase = "streaming";
        notify();
        notifyAction(actionId);

        return {
          end() {
            if (ended) return;
            ended = true;
            streamingEnded = true;
            activeStreamCount = Math.max(0, activeStreamCount - 1);
            notify();
            // Try to finalize if action was already completed
            tryFinalize();
          },
        };
      },

      recordRevalidatedSegments(segmentIds: string[]) {
        entry.revalidatedSegments.push(...segmentIds);
        segmentIds.forEach((id) => concurrentRevalidatedSegments.add(id));
      },

      complete(result?: unknown) {
        if (!inflightActions.has(id) || settled) return;

        actionCompleted = true;
        entry.completed = true;
        pendingResult = { type: "success", value: result };

        // If streaming never started or already ended, finalize immediately
        // Otherwise wait for streaming to end
        if (entry.phase === "fetching" || streamingEnded) {
          streamingEnded = true; // Mark as ended if never started
          tryFinalize();
        }
        // If streaming is in progress, tryFinalize() will be called when streaming ends
      },

      fail(error: unknown) {
        if (!inflightActions.has(id) || settled) return;

        actionCompleted = true;
        entry.completed = true;
        pendingResult = { type: "error", value: error };

        // If streaming never started or already ended, finalize immediately
        // Otherwise wait for streaming to end
        if (entry.phase === "fetching" || streamingEnded) {
          streamingEnded = true; // Mark as ended if never started
          tryFinalize();
        }
        // If streaming is in progress, tryFinalize() will be called when streaming ends
      },

      getConsolidationSegments(): string[] | null {
        // Only consolidate if all actions have at least received their response
        // We don't need to wait for streaming to complete since we're refetching anyway
        // Count actions that are still fetching (waiting for server response)
        const stillFetchingCount = [...inflightActions.values()].filter(
          (a) => a.phase === "fetching",
        ).length;

        if (stillFetchingCount > 0) {
          return null; // Some actions still waiting for server response
        }
        if (!hadAnyConcurrentActions) {
          return null; // No concurrent actions occurred
        }
        if (concurrentRevalidatedSegments.size === 0) {
          return null; // No segments to consolidate
        }
        return Array.from(concurrentRevalidatedSegments);
      },

      clearConsolidation() {
        concurrentRevalidatedSegments.clear();
        hadAnyConcurrentActions = false;
      },

      // Disposable: cleanup if not settled (e.g., error thrown without calling fail)
      [Symbol.dispose]() {
        // If aborted, another navigation/error took over - don't touch state
        if (abort.signal.aborted) {
          inflightActions.delete(id);
          notify();
          notifyAction(actionId);
          return;
        }

        // If action was already completed, let the streaming token handle finalization
        // The action is legitimately waiting for streaming to end
        if (actionCompleted) {
          return;
        }

        // If not settled and not completed, this is an error case - force finalize
        if (!settled && inflightActions.has(id)) {
          actionCompleted = true;
          streamingEnded = true;
          tryFinalize();
        }
      },
    };
  }

  function abortAllActions() {
    for (const entry of inflightActions.values()) {
      entry.abort.abort();
    }
    inflightActions.clear();
    hadAnyConcurrentActions = false;
    concurrentRevalidatedSegments.clear();
    notify();
    // Notify all action listeners
    for (const actionId of actionListeners.keys()) {
      notifyAction(actionId);
    }
  }

  // ========================================================================
  // Handle Operations
  // ========================================================================

  /**
   * Filter segment IDs to only include routes and layouts.
   * Excludes parallels (contain .@) and loaders (contain D followed by digit).
   */
  function filterSegmentOrder(matched: string[]): string[] {
    return matched.filter((id) => {
      if (id.includes(".@")) return false;
      if (/D\d+\./.test(id)) return false;
      return true;
    });
  }

  function setHandleData(
    data: HandleData,
    matched?: string[],
    isPartial?: boolean,
  ): void {
    const newSegmentOrder = filterSegmentOrder(matched ?? []);

    if (isPartial && newSegmentOrder.length > 0) {
      // Partial update: merge new data with existing
      for (const handleName of Object.keys(data)) {
        if (!handleData[handleName]) {
          handleData[handleName] = {};
        }
        for (const segmentId of Object.keys(data[handleName])) {
          handleData[handleName][segmentId] = data[handleName][segmentId];
        }
      }
      // Clean up data from segments no longer in the matched list
      for (const handleName of Object.keys(handleData)) {
        for (const segmentId of Object.keys(handleData[handleName])) {
          if (!newSegmentOrder.includes(segmentId)) {
            delete handleData[handleName][segmentId];
          }
        }
      }
    } else {
      // Full update: replace all data
      handleData = data;
    }
    handleSegmentOrder = newSegmentOrder;

    notifyHandles();
  }

  function getHandleState(): HandleState {
    return {
      data: handleData,
      segmentOrder: handleSegmentOrder,
    };
  }

  // ========================================================================
  // Subscriptions
  // ========================================================================

  function subscribe(listener: StateListener): () => void {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  function subscribeToAction(
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
      if (listeners!.size === 0) {
        actionListeners.delete(actionId);
      }
    };
  }

  function subscribeToHandles(listener: HandleListener): () => void {
    handleListeners.add(listener);
    return () => handleListeners.delete(listener);
  }

  // ========================================================================
  // Params Operations
  // ========================================================================

  function setParams(params: Record<string, string>): void {
    routeParams = params;
    notify();
  }

  function getParams(): Record<string, string> {
    return routeParams;
  }

  // ========================================================================
  // Return Controller
  // ========================================================================

  return {
    // Navigation
    startNavigation,
    abortNavigation,

    // Actions
    startAction,
    abortAllActions,

    // State
    getState,
    getActionState,
    setLocation,

    // Handles
    setHandleData,
    getHandleState,

    // Params
    setParams,
    getParams,

    // Subscriptions
    subscribe,
    subscribeToAction,
    subscribeToHandles,

    // Direct access
    getCurrentNavigation: () => currentNavigation,
    getInflightActions: () => inflightActions,
  };
}

// ============================================================================
// Singleton
// ============================================================================

let controllerInstance: EventController | null = null;

/**
 * Initialize the global event controller
 */
export function initEventController(
  config?: EventControllerConfig,
): EventController {
  if (!controllerInstance) {
    controllerInstance = createEventController(config);
  }
  return controllerInstance;
}

/**
 * Get the global event controller
 */
export function getEventController(): EventController {
  if (!controllerInstance) {
    throw new Error(
      "Event controller not initialized. Call initEventController first.",
    );
  }
  return controllerInstance;
}

/**
 * Reset the controller instance (for testing)
 */
export function resetEventController(): void {
  controllerInstance = null;
}
