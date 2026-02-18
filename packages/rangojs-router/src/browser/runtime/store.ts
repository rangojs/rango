/**
 * Client Segment Runtime - Store
 *
 * Reactive state container wrapping the reducer. Single entry point for
 * all events. Bridges to React via useSyncExternalStore-compatible subscriptions.
 *
 * Replaces both NavigationStore and EventController.
 */

import type {
  ClientRuntimeState,
  RuntimeEvent,
  RuntimeCommand,
  ReduceResult,
  RouteSnapshot,
  RenderPlan,
  DerivedActionState,
  HandleState,
  CacheEntry,
} from "./types.js";
import { reduce } from "./reducer.js";
import { deriveActionState, deriveNavigationState, type DerivedNavigationState } from "./derive.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandExecutor = (commands: RuntimeCommand[], dispatch: (event: RuntimeEvent) => void) => void;

export type RenderCallback = (plan: RenderPlan) => void;

export interface RuntimeStore {
  /** Dispatch an event through the reducer and execute commands. */
  dispatch(event: RuntimeEvent): void;

  /** Get current state (snapshot for useSyncExternalStore). */
  getState(): ClientRuntimeState;

  /** Subscribe to state changes (useSyncExternalStore compatible). */
  subscribe(listener: () => void): () => void;

  /** Subscribe to per-action state changes. */
  subscribeToAction(actionId: string, listener: (state: DerivedActionState) => void): () => void;

  /** Subscribe to handle state changes. */
  subscribeToHandles(listener: (state: HandleState) => void): () => void;

  /** Register render callback (called when RENDER commands are emitted). */
  onRender(callback: RenderCallback): () => void;

  /** Set the command executor (wired by runtime.ts). */
  setExecutor(executor: CommandExecutor): void;

  /** Derive navigation state for useNavigation. */
  getNavigationState(): DerivedNavigationState;

  /** Derive action state for useAction. */
  getActionState(actionId: string): DerivedActionState;

  /** Derive handle state for useHandle. */
  getHandleState(): HandleState;
}

// ---------------------------------------------------------------------------
// Create store
// ---------------------------------------------------------------------------

export function createRuntimeStore(initialState: ClientRuntimeState): RuntimeStore {
  let state = initialState;
  let previouslyTerminal = new Set<string>();
  let executor: CommandExecutor | null = null;

  // Subscription lists
  const stateListeners = new Set<() => void>();
  const actionListeners = new Map<string, Set<(state: DerivedActionState) => void>>();
  const handleListeners = new Set<(state: HandleState) => void>();
  const renderCallbacks = new Set<RenderCallback>();

  // Debounce notification (batch rapid state updates)
  let notifyScheduled = false;
  let prevNavState: DerivedNavigationState | null = null;
  let prevHandleState: HandleState | null = null;

  function scheduleNotify() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    // Use microtask for synchronous batching within a single event loop tick
    queueMicrotask(() => {
      notifyScheduled = false;
      notifyAll();
    });
  }

  function notifyAll() {
    // State listeners (useNavigation, general subscribers)
    const currentNavState = deriveNavigationState(state);
    if (!prevNavState || !shallowEqual(prevNavState as any, currentNavState as any)) {
      prevNavState = currentNavState;
      for (const listener of stateListeners) {
        listener();
      }
    }

    // Action listeners (useAction)
    for (const [actionId, listeners] of actionListeners) {
      const actionState = deriveActionState(state.transactions, actionId);
      for (const listener of listeners) {
        listener(actionState);
      }
    }

    // Handle listeners (useHandle)
    const currentHandleState = state.handleState;
    if (prevHandleState !== currentHandleState) {
      prevHandleState = currentHandleState;
      for (const listener of handleListeners) {
        listener(currentHandleState);
      }
    }
  }

  function dispatch(event: RuntimeEvent): void {
    const result = reduce(state, event, previouslyTerminal);
    state = result.state;
    previouslyTerminal = result.nowTerminal;

    // Execute commands via executor
    if (executor && result.commands.length > 0) {
      // Extract RENDER commands for render callbacks
      const renderCmds = result.commands.filter((c) => c.kind === "RENDER");
      if (renderCmds.length > 0) {
        // Only execute the last RENDER (batching)
        const lastRender = renderCmds[renderCmds.length - 1];
        if (lastRender.kind === "RENDER") {
          const plan: RenderPlan = {
            segments: lastRender.payload.snapshot.segments,
            interceptSegments: lastRender.payload.snapshot.interceptSegments,
            options: {
              forceAwait: lastRender.payload.forceAwait,
              scrollBehavior: "none", // Scroll is handled by separate SCROLL command
            },
          };
          for (const cb of renderCallbacks) {
            cb(plan);
          }
        }
      }

      // Execute non-RENDER commands via executor
      const nonRenderCmds = result.commands.filter((c) => c.kind !== "RENDER");
      if (nonRenderCmds.length > 0) {
        executor(nonRenderCmds, dispatch);
      }
    }

    // Schedule subscriber notifications
    scheduleNotify();
  }

  return {
    dispatch,

    getState() {
      return state;
    },

    subscribe(listener: () => void): () => void {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    subscribeToAction(actionId: string, listener: (s: DerivedActionState) => void): () => void {
      if (!actionListeners.has(actionId)) {
        actionListeners.set(actionId, new Set());
      }
      actionListeners.get(actionId)!.add(listener);
      return () => {
        const set = actionListeners.get(actionId);
        if (set) {
          set.delete(listener);
          if (set.size === 0) actionListeners.delete(actionId);
        }
      };
    },

    subscribeToHandles(listener: (s: HandleState) => void): () => void {
      handleListeners.add(listener);
      return () => handleListeners.delete(listener);
    },

    onRender(callback: RenderCallback): () => void {
      renderCallbacks.add(callback);
      return () => renderCallbacks.delete(callback);
    },

    setExecutor(exec: CommandExecutor): void {
      executor = exec;
    },

    getNavigationState(): DerivedNavigationState {
      return deriveNavigationState(state);
    },

    getActionState(actionId: string): DerivedActionState {
      return deriveActionState(state.transactions, actionId);
    },

    getHandleState(): HandleState {
      return state.handleState;
    },
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
