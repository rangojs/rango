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
import {
  filterSegmentOrder,
  filterRouteSegmentIds,
} from "./react/filter-segment-order.js";
import { notifyListeners } from "./notify-listeners.js";

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
  /** Whether a navigation is active (fetching or streaming, before commit) */
  isNavigating: boolean;
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
 * Internal handle state stored in controller.
 *
 * Two segment lists are exposed because they serve different consumers:
 *
 * - `segmentOrder` drives handle collection (collectHandleData). Includes
 *   parallel slot ids and reorders them after their parent so later-wins
 *   collect functions (e.g. Meta) get the right precedence.
 * - `routeSegmentIds` is the layouts-and-routes-only list documented by
 *   `useSegments().segmentIds`. Parallels and loader sub-ids are stripped;
 *   raw matched order is preserved.
 *
 * Both are derived from the same `matched` input on each setHandleData call
 * so they stay in sync.
 */
export interface HandleState {
  data: HandleData;
  segmentOrder: string[];
  routeSegmentIds: string[];
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
  /**
   * Claim the subset of a location-state payload this action may write. A key
   * is claimed only if no later-initiated action in the SAME cohort has already
   * claimed it, so same-key concurrent writes resolve to the last-initiated
   * action while distinct keys from every action survive. Recording the claim
   * stops a later-settling earlier action from overwriting it. Arbitration is
   * scoped to the action's cohort (its originating history entry, captured at
   * startAction), so an action on one entry cannot suppress an action on
   * another that happens to write the same slot.
   *
   * Contract: this guarantees the FINAL value is the last-initiated action's,
   * not that the loser is never momentarily visible. When an earlier-initiated
   * action settles first, its value is merged and observable until the
   * later-initiated winner's response lands and overwrites it.
   */
  claimLocationState(state: Record<string, unknown>): Record<string, unknown>;
  /** Complete the action with result */
  complete(result?: unknown): void;
  /** Fail the action with error */
  fail(error: unknown): void;
  /** Whether action was completed (success or failure) */
  readonly settled: boolean;
  /** Check if any concurrent actions were started */
  hadConcurrentActions: boolean;
  /** Get raw set of segments revalidated by concurrent actions */
  getRevalidatedSegments(): Set<string>;
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
  startAction(
    actionId: string,
    args: unknown[],
    /** Originating history entry key; scopes location-state arbitration. */
    cohort?: string,
  ): ActionHandle;
  abortAllActions(): void;

  // State access
  getState(): DerivedNavigationState;
  getActionState(actionId: string): TrackedActionState;
  getLocation(): NavigationLocation;

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
    /**
     * Segment ids that were re-resolved on the server this request (the
     * partial response's `diff`). On a partial update, any existing bucket
     * keyed under one of these ids that has no incoming entry is treated as
     * stale and cleared. Without this, a parallel slot that revalidates but
     * pushes nothing leaves its previous bucket in place forever.
     */
    resolvedIds?: string[],
  ): void;
  getHandleState(): HandleState;
  /**
   * Update ONLY `routeSegmentIds` (what `useSegments` reads) from `matched`,
   * leaving `data` and `segmentOrder` (what `useHandle` collects over) untouched.
   * Used while a deferred handle is resolving: the route has changed (so
   * `useSegments` must reflect the new segment ids) but `useHandle` still holds
   * its previous value until the deferred snapshot is applied.
   */
  setRouteSegmentIds(matched: string[]): void;

  // Params operations
  setParams(params: Record<string, string>): void;
  getParams(): Record<string, string>;

  // Direct state access for advanced use
  getCurrentNavigation(): NavigationEntry | null;
  getInflightActions(): Map<string, ActionEntry>;
  /** Whether any concurrent actions have occurred (shared across all handles) */
  hadAnyConcurrentActions(): boolean;
}

type LocationChangeController = Pick<EventController, "getState" | "subscribe">;

interface LocationChangeSubscription {
  registrations: Map<
    symbol,
    { href: string; listener: (href: string) => void }
  >;
  notificationVersion: number;
  unsubscribe: () => void;
}

const locationChangeSubscriptions = new WeakMap<
  LocationChangeController,
  LocationChangeSubscription
>();

/** Share one controller subscription across all location-change consumers. */
export function subscribeToLocationChange(
  eventController: LocationChangeController,
  listener: (href: string) => void,
): () => void {
  let subscription = locationChangeSubscriptions.get(eventController);
  if (!subscription) {
    subscription = {
      registrations: new Map(),
      notificationVersion: 0,
      unsubscribe: () => {},
    };
    locationChangeSubscriptions.set(eventController, subscription);
    const currentSubscription = subscription;
    subscription.unsubscribe = eventController.subscribe(() => {
      const notificationVersion = ++currentSubscription.notificationVersion;
      const nextHref = eventController.getState().location.href;
      notifyListeners(
        [...currentSubscription.registrations],
        ([, registration]) => {
          if (registration.href === nextHref) return;
          registration.href = nextHref;
          registration.listener(nextHref);
        },
        ([token, registration]) =>
          currentSubscription.registrations.get(token) === registration,
        () => notificationVersion === currentSubscription.notificationVersion,
      );
    });
  }

  const token = Symbol();
  subscription.registrations.set(token, {
    href: eventController.getState().location.href,
    listener,
  });
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscription!.registrations.delete(token);
    if (subscription!.registrations.size > 0) return;
    if (locationChangeSubscriptions.get(eventController) === subscription) {
      locationChangeSubscriptions.delete(eventController);
    }
    subscription!.unsubscribe();
  };
}

const DEFAULT_ACTION_STATE: TrackedActionState = {
  state: "idle",
  actionId: null,
  payload: null,
  error: null,
  result: null,
};

// Shared empty inflight-actions list. getState() hands back this exact reference
// whenever no action is inflight (the overwhelmingly common case), so the derived
// snapshot's `inflightActions` is referentially stable across notifies instead of
// a fresh [] each call. Read-only by contract (consumers only read length/spread),
// same as the shared DEFAULT_ACTION_STATE.
const EMPTY_INFLIGHT_ACTIONS: InflightAction[] = [];

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
    return subscriptionId === entryActionId;
  }
  return entryActionId.endsWith(`#${subscriptionId}`);
}

// Batch rapid notifications into one microtask to prevent render storms
function makeDebouncedNotifier(listeners: Set<() => void>): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timeout = null;
      notifyListeners(
        [...listeners],
        (listener) => listener(),
        (listener) => listeners.has(listener),
      );
    }, 0);
  };
}

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
  let currentNavigation: NavigationEntry | null = null;

  const inflightActions = new Map<string, ActionEntry>();

  let location: NavigationLocation =
    config?.initialLocation ??
    (typeof window !== "undefined"
      ? new URL(window.location.href)
      : new URL("/", "http://localhost"));

  let hadAnyConcurrentActions = false;

  const concurrentRevalidatedSegments = new Set<string>();

  // Monotonic dispatch counter: every startAction() takes the next value
  // (private), so a larger sequence means the action was initiated later.
  let actionDispatchSeq = 0;

  // Concurrent location-state arbitration, scoped PER COHORT (history entry).
  // Each cohort owns a slotKey->winningDispatchSeq map plus a refcount of its
  // inflight actions; claimLocationState() consults its own cohort's map so
  // same-key writes within one entry resolve to the last-initiated action
  // regardless of settle order, while actions on different entries never
  // compete. A cohort's map is freed once its LAST action's cleanup runs — the
  // same brief post-settle grace (doSettle's 100ms timer) as other action
  // teardown, not when every action everywhere settles — so a long-running
  // action in one cohort can never retain arbitration keys from other cohorts
  // that have since drained. It is never cleared in clearConsolidation, which
  // fires
  // per-action on divert/error and would let a later-settling earlier action
  // wrongly reclaim a key a sibling already won.
  const cohortArbitration = new Map<
    string,
    { keySeq: Map<string, number>; inflight: number }
  >();

  let activeStreamCount = 0;

  let handleData: HandleData = {};
  let handleSegmentOrder: string[] = [];
  let routeSegmentIds: string[] = [];

  let routeParams: Record<string, string> = {};

  const stateListeners = new Set<StateListener>();
  const actionListeners = new Map<string, Set<ActionStateListener>>();
  const handleListeners = new Set<HandleListener>();

  const notifyStateListeners = makeDebouncedNotifier(stateListeners);

  // Memoized derived snapshot. Every state mutation already funnels through
  // notify(), so invalidating here (synchronously, before the debounced fire)
  // means a getState() call between two mutations reuses the same object — an
  // unchanged state returns the SAME reference — while any real change recomputes
  // on the next read. Kept null when dirty.
  let cachedDerivedState: DerivedNavigationState | null = null;

  function notify(): void {
    cachedDerivedState = null;
    notifyStateListeners();
  }

  const actionNotifyTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  function notifyActionListenerSets(
    subscriptions: Iterable<[string, Set<ActionStateListener>]>,
  ): void {
    const subscriptionSnapshots = [...subscriptions].map(
      ([subscriptionId, listeners]) => ({
        listenerSnapshot: [...listeners],
        listeners,
        subscriptionId,
      }),
    );
    function* notifications(): Generator<{
      listener: ActionStateListener;
      listeners: Set<ActionStateListener>;
      state: TrackedActionState;
    }> {
      for (const {
        listenerSnapshot,
        listeners,
        subscriptionId,
      } of subscriptionSnapshots) {
        const state = getActionState(subscriptionId);
        for (const listener of listenerSnapshot) {
          yield { listener, listeners, state };
        }
      }
    }
    notifyListeners(
      notifications(),
      ({ listener, state }) => listener(state),
      ({ listener, listeners }) => listeners.has(listener),
    );
  }

  function notifyAction(actionId: string) {
    const existing = actionNotifyTimeouts.get(actionId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    actionNotifyTimeouts.set(
      actionId,
      setTimeout(() => {
        actionNotifyTimeouts.delete(actionId);
        notifyActionListenerSets(
          [...actionListeners].filter(([subscriptionId]) =>
            matchesActionId(subscriptionId, actionId),
          ),
        );
      }, 0),
    );
  }

  const notifyHandles = makeDebouncedNotifier(handleListeners);

  function getState(): DerivedNavigationState {
    if (cachedDerivedState) return cachedDerivedState;

    // Skip the spread/filter/map entirely when idle — the common case — and hand
    // back the shared frozen empty list for referential stability.
    const inflightActionsList: InflightAction[] =
      inflightActions.size === 0
        ? EMPTY_INFLIGHT_ACTIONS
        : [...inflightActions.values()]
            .filter((a) => a.phase !== "settling")
            .map((a) => ({
              id: a.id,
              actionId: a.actionId,
              payload: a.payload,
              startedAt: a.startedAt,
            }));

    const hasActiveActions = inflightActionsList.length > 0;
    const isVisibleNavigation =
      currentNavigation !== null &&
      !currentNavigation.options?.skipLoadingState;
    const state = isVisibleNavigation || hasActiveActions ? "loading" : "idle";

    const isStreaming = activeStreamCount > 0 || state === "loading";

    cachedDerivedState = {
      state,
      isStreaming,
      // True when a navigation is active (fetching or streaming, before
      // commit). Broader than pendingUrl which clears during streaming.
      isNavigating: currentNavigation !== null,
      location,
      // pendingUrl only during fetching phase - once streaming starts (URL changed), not pending.
      // Background revalidations (skipLoadingState) don't expose a pending URL.
      pendingUrl:
        currentNavigation?.phase === "fetching" &&
        !currentNavigation.options?.skipLoadingState
          ? currentNavigation.url
          : null,
      inflightActions: inflightActionsList,
    };
    return cachedDerivedState;
  }

  function getActionState(actionId: string): TrackedActionState {
    // Nothing inflight — skip building/scanning the list and return the shared
    // idle snapshot (the same reference use-action falls back to).
    if (inflightActions.size === 0) return DEFAULT_ACTION_STATE;

    const entry = [...inflightActions.values()]
      .filter((a) => matchesActionId(actionId, a.actionId))
      .reduce<ActionEntry | undefined>((best, a) => {
        if (!best) return a;
        const aActive = a.phase !== "settling";
        const bActive = best.phase !== "settling";
        if (aActive !== bActive) return aActive ? a : best;
        return a.startedAt > best.startedAt ? a : best;
      }, undefined);

    if (!entry) {
      return { ...DEFAULT_ACTION_STATE };
    }

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
        entry.phase = "streaming";
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

  function startAction(
    actionId: string,
    args: unknown[],
    cohort?: string,
  ): ActionHandle {
    const id = `${actionId}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    // Private to this handle: never exposed on the returned ActionHandle.
    const dispatchSeq = actionDispatchSeq++;
    const abort = new AbortController();

    // Register this action under its cohort (originating history entry). The
    // cohort's arbitration is created on first use and freed when its last
    // action settles (see doSettle). Keyless entries share the "" cohort.
    const cohortId = cohort ?? "";
    let arb = cohortArbitration.get(cohortId);
    if (!arb) {
      arb = { keySeq: new Map<string, number>(), inflight: 0 };
      cohortArbitration.set(cohortId, arb);
    }
    // const so the captured reference stays non-undefined inside doSettle.
    const arbitration = arb;
    arbitration.inflight++;

    // Track if this action started while another was genuinely in-flight.
    // Completed entries don't count: complete()/fail() ran, so the prior
    // action's response was fully processed and applied — a request dispatched
    // after that point is strictly ordered behind the prior action's server
    // execution, and there is no skipped render or order uncertainty for
    // consolidation to repair. Completed entries still linger in the map for
    // the 100ms doSettle window (useAction reads) and, on a slow connection,
    // while the Flight stream drains its EOF after complete(). Counting them
    // latched hadAnyConcurrentActions for back-to-back sequential actions,
    // which made the LAST action classify as consolidation-needed; the
    // consolidation refetch omits every concurrently-revalidated segment id
    // from _rsc_segments, so the server re-ran gated loaders as "new-segment"
    // — bypassing revalidate(({ isAction }) => ...) on a plain GET (#675).
    const hadConcurrent = [...inflightActions.values()].some(
      (a) => !a.completed,
    );
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
    let cohortReleased = false;
    let pendingResult:
      | { type: "success"; value?: unknown }
      | { type: "error"; value: unknown }
      | null = null;

    // Release this action's hold on its cohort arbitration exactly once: drop
    // the refcount and, only if the map still points at THIS arbitration object,
    // delete it. A newer generation may have replaced it (e.g. abortAllActions
    // cleared the map and a fresh action recreated the same cohort id), so a
    // stale settlement must never delete the newer one by id.
    function releaseCohort() {
      if (cohortReleased) return;
      cohortReleased = true;
      if (
        --arbitration.inflight <= 0 &&
        cohortArbitration.get(cohortId) === arbitration
      ) {
        cohortArbitration.delete(cohortId);
      }
    }

    function doSettle() {
      if (settled) return;
      settled = true;

      // Cleanup after brief delay (allow useAction to read result)
      setTimeout(() => {
        inflightActions.delete(id);
        // Free this cohort's arbitration once its last action has settled, so
        // a long-running action elsewhere cannot pin keys from a drained entry.
        releaseCohort();
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

    // streamingEnded is forced here for the "streaming never started" case so
    // tryFinalize can run; otherwise the streaming token's end() finalizes.
    function settleWith(result: NonNullable<typeof pendingResult>) {
      if (!inflightActions.has(id) || settled) return;
      actionCompleted = true;
      entry.completed = true;
      pendingResult = result;
      if (entry.phase === "fetching" || streamingEnded) {
        streamingEnded = true;
        tryFinalize();
      }
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

      claimLocationState(state: Record<string, unknown>) {
        const winning: Record<string, unknown> = {};
        // Arbitrate against this action's OWN captured arbitration object, not a
        // live map lookup: a concurrent map clear/replace (abortAllActions, a
        // stale settlement) must not make this action silently stop recording
        // and accept every key.
        const keySeq = arbitration.keySeq;
        for (const key of Object.keys(state)) {
          const prevSeq = keySeq.get(key);
          // Strictly-greater: a later-initiated action wins a key over an
          // earlier one in the same cohort regardless of arrival order. Equal
          // cannot happen (dispatchSeq is unique per action).
          if (prevSeq === undefined || dispatchSeq > prevSeq) {
            keySeq.set(key, dispatchSeq);
            winning[key] = state[key];
          }
        }
        return winning;
      },

      complete(result?: unknown) {
        settleWith({ type: "success", value: result });
      },

      fail(error: unknown) {
        settleWith({ type: "error", value: error });
      },

      getRevalidatedSegments(): Set<string> {
        return concurrentRevalidatedSegments;
      },

      clearConsolidation() {
        concurrentRevalidatedSegments.clear();
        hadAnyConcurrentActions = false;
      },

      // Disposable: cleanup if not settled (e.g., error thrown without calling fail)
      [Symbol.dispose]() {
        // If aborted, another navigation/error took over - don't touch state
        if (abort.signal.aborted) {
          // Aborted actions skip doSettle, so release the cohort hold here to
          // keep the per-cohort refcount balanced (no leak when an action is
          // aborted individually rather than via abortAllActions).
          releaseCohort();
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
    for (const [id, entry] of inflightActions) {
      // Preserve settling entries — they have already been handled by
      // fail()/complete() and will self-cleanup via the settlement timeout.
      // Clearing them here would prevent debounced notifications from
      // delivering the error/result state to subscribers.
      if (entry.phase === "settling") continue;
      entry.abort.abort();
      inflightActions.delete(id);
    }
    hadAnyConcurrentActions = false;
    concurrentRevalidatedSegments.clear();
    cohortArbitration.clear();
    notify();
    // Notify all action listeners directly by subscription ID.
    // actionListeners keys are subscription IDs (possibly short names like
    // "addToCart"), not full entry actionIds. Passing them to notifyAction
    // would fail the suffix matcher — instead, notify each subscriber with
    // its own state.
    notifyActionListenerSets(actionListeners);
  }

  // ========================================================================
  // Handle Operations
  // ========================================================================

  function setHandleData(
    data: HandleData,
    matched?: string[],
    isPartial?: boolean,
    resolvedIds?: string[],
  ): void {
    const rawMatched = matched ?? [];
    const newSegmentOrder = filterSegmentOrder(rawMatched);
    // Separate list for useSegments(): "layouts and routes only" — strip
    // parallels (".@") and loader sub-ids (D digit) without reordering.
    const newRouteSegmentIds = filterRouteSegmentIds(rawMatched);

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
      const resolvedIdSet =
        resolvedIds && resolvedIds.length > 0 ? new Set(resolvedIds) : null;
      // Cleanup pass:
      //   a) segment dropped from the match list — delete its bucket.
      //   b) segment was re-resolved this request but pushed nothing for
      //      this handle — its previous bucket is stale.
      // (a) is the existing behavior; (b) requires resolvedIds.
      for (const handleName of Object.keys(handleData)) {
        for (const segmentId of Object.keys(handleData[handleName])) {
          const droppedFromMatch = !newSegmentOrder.includes(segmentId);
          const reresolvedWithoutPush =
            resolvedIdSet?.has(segmentId) && !data[handleName]?.[segmentId];
          if (droppedFromMatch || reresolvedWithoutPush) {
            delete handleData[handleName][segmentId];
          }
        }
      }
    } else {
      // Full update: replace all data
      handleData = data;
    }
    handleSegmentOrder = newSegmentOrder;
    routeSegmentIds = newRouteSegmentIds;

    notifyHandles();
  }

  function getHandleState(): HandleState {
    return {
      data: handleData,
      segmentOrder: handleSegmentOrder,
      routeSegmentIds,
    };
  }

  function setRouteSegmentIds(matched: string[]): void {
    const next = filterRouteSegmentIds(matched);
    if (
      next.length === routeSegmentIds.length &&
      next.every((id, i) => id === routeSegmentIds[i])
    ) {
      return;
    }
    routeSegmentIds = next;
    notifyHandles();
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
    getLocation: () => location,
    setLocation,

    // Handles
    setHandleData,
    getHandleState,
    setRouteSegmentIds,

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
    hadAnyConcurrentActions: () => hadAnyConcurrentActions,
  };
}
