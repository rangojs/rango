"use client";

import { useContext, useState, useEffect, useRef } from "react";
import { NavigationStoreContext } from "./context.js";
import { shallowEqual } from "./shallow-equal.js";
import type { TrackedActionState } from "../types.js";
import {
  DEFAULT_ACTION_STATE,
  type RouteStateSignal,
} from "../event-controller.js";
import { invariant } from "../../errors.js";

/**
 * Extract action ID from a server action function or string.
 *
 * Actions passed as props from server components lose their metadata
 * during RSC serialization - use a string action name instead.
 *
 * The extracted $$id (e.g. "hash#actionName" or "src/actions.ts#actionName")
 * is returned as-is. Suffix-vs-exact matching against this ID happens
 * downstream in the event controller, not here.
 */
function getActionId(action: ServerActionFunction | string): string {
  invariant(
    typeof action === "function" || typeof action === "string",
    `useAction: action must be a function or string, got ${typeof action}`,
  );
  const actionId = (action as any)?.$$id;
  if (actionId) {
    return actionId;
  }

  // If action is a string, use it directly
  if (typeof action === "string") {
    return action;
  }

  // If we get here, this is likely an action passed as prop from a server
  // component: these lose their metadata during RSC serialization. The
  // guidance is dev-only: it was about 225 B gzip of every client build that
  // calls useAction.
  throw new Error(
    process.env.NODE_ENV !== "production"
      ? `useAction: Cannot extract action ID from function reference.

This typically happens when an action is passed as a prop from a server component.
Actions passed through RSC lose their metadata during serialization.

Solutions:
1. Import the action directly in your client component:
   import { myAction } from './actions';
   const state = useAction(myAction);

2. Use the action name as a string:
   const state = useAction("myAction");

The string must match the exported function name from your "use server" file.`
      : "useAction: Cannot extract action ID from function reference.",
  );
}

/** The state a value was selected from, and the value. */
interface Snapshot<T> {
  state: TrackedActionState;
  value: T;
}

/**
 * Server action function type
 * Server actions have a $$id property added by the RSC compiler
 */
export type ServerActionFunction = ((...args: any[]) => Promise<any>) & {
  $$id?: string;
};

/**
 * Hook to track the lifecycle of a specific server action
 *
 * Unlike useNavigation which tracks global navigation state, useAction
 * tracks the state of individual server action invocations.
 *
 * Uses the event controller for reactive state management.
 * State is derived from the inflight actions tracked by the controller.
 *
 * Features:
 * - Tracks action lifecycle: idle → loading → streaming → idle
 * - Captures result/error locally (React handles cleanup)
 * - If the same action fires several times, reports the latest call to
 *   start. An earlier call that settles later changes nothing it reports;
 *   a latest call that was aborted reports idle with nothing. One call at a
 *   time, not one per argument: a reader filtering on `payload` cannot track
 *   an earlier call once a later one starts.
 * - Supports selector pattern like useNavigation
 *
 * Matching behavior:
 * - **Function reference**: Uses full $$id for exact matching. This is precise
 *   and distinguishes between actions with the same name in different files.
 * - **String**: Matches by suffix (action name after #). This is convenient
 *   but may be ambiguous if multiple files export the same action name: it
 *   follows the latest call of any action with that export name.
 *
 * @param action - Either a server action function or a string action name.
 *   - **Function**: Must be directly imported in the client component.
 *     Actions passed as props from server components will throw an error.
 *   - **String**: The exported function name from your "use server" file.
 *     Matches any action ending with "#actionName" (suffix match).
 *
 * @example
 * ```tsx
 * // Option 1: Direct import (precise matching)
 * import { addToCart } from './actions';
 * const actionState = useAction(addToCart);
 *
 * // Option 2: String-based (suffix matching)
 * // Matches "hash#addToCart" or "src/actions.ts#addToCart"
 * const actionState = useAction('addToCart');
 *
 * // With selector for specific values
 * const isLoading = useAction(addToCart, state => state.state === 'loading');
 * const error = useAction(addToCart, state => state.error);
 * ```
 *
 * @note The selector is expected to be stable for a given hook instance.
 * This hook tracks one projection of one action. Changing selector semantics
 * for the same action ID without a new action event is not a supported pattern;
 * use separate useAction() subscriptions if you need different projections.
 *
 * @note Actions passed as props from server components lose their metadata
 * during RSC serialization. Use a string action name or import directly.
 */
export function useAction(
  action: ServerActionFunction | string,
): TrackedActionState;
export function useAction<T>(
  action: ServerActionFunction | string,
  selector: (state: TrackedActionState) => T,
): T;
export function useAction<T>(
  action: ServerActionFunction | string,
  selector?: (state: TrackedActionState) => T,
): T | TrackedActionState {
  const ctx = useContext(NavigationStoreContext);
  const actionId =
    typeof window !== "undefined" && typeof document !== "undefined"
      ? getActionId(action)
      : "";

  // Set urgently, never in a transition of its own: it would take a held
  // page's transition types (see useNavigation).
  const [snapshot, setSnapshot] = useState<Snapshot<T | TrackedActionState>>(
    () => {
      // The document renders no action in flight.
      const state =
        !ctx || ctx.eventController.getHydrationSnapshot()
          ? DEFAULT_ACTION_STATE
          : ctx.eventController.getActionState(actionId);
      return { state, value: selector ? selector(state) : state };
    },
  );
  // What React ends on once every set so far commits.
  const latest = useRef(snapshot);

  // Ref keeps the latest selector for subscription callbacks without
  // re-subscribing on every render. Selector changes themselves are not
  // treated as a reactive input; this hook expects a stable selector and
  // represents one subscription/projection for one action.
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to action state changes from event controller. While React
  // holds a page (its anchor until its release, as useNavigation reads
  // them), a call that starts or streams shows at once, and one that settles
  // waits for the page's commit (rango-d152): the release brings it in the
  // commit's task, and the controller keeps the call's entry until then.
  useEffect(() => {
    if (!ctx) return;

    let pageHeld = false;
    const select = (state: TrackedActionState) =>
      selectorRef.current ? selectorRef.current(state) : state;
    const update = (signal?: RouteStateSignal) => {
      if (signal) pageHeld = signal === "anchor";
      const live = ctx.eventController.getActionState(actionId);
      const held = pageHeld && !signal;
      const next = (
        base: Snapshot<T | TrackedActionState>,
      ): Snapshot<T | TrackedActionState> => {
        const state = held && live.state === "idle" ? base.state : live;
        return { state, value: select(state) };
      };
      const target = next(latest.current);
      if (shallowEqual(target.value, latest.current.value)) return;
      latest.current = target;
      setSnapshot(held ? next : target);
    };
    // Sync current state for the (possibly new) actionId so that switching
    // actions on an idle page doesn't leave stale data from the old action.
    update();
    const unsubscribe = ctx.eventController.subscribeToAction(actionId, () =>
      update(),
    );
    const unsubscribeSignals = ctx.eventController.subscribeToHandles(
      (signal) => signal && update(signal),
    );
    return () => {
      unsubscribe();
      unsubscribeSignals();
    };
  }, [actionId]);

  return snapshot.value;
}

export type { TrackedActionState };
