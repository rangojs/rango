"use client";

import {
  useContext,
  useState,
  useEffect,
  useRef,
  useOptimistic,
  startTransition,
} from "react";
import { NavigationStoreContext } from "./context.js";
import type { TrackedActionState, ActionLifecycleState } from "../types.js";
import { invariant } from "../../errors.js";

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

/**
 * Normalize action ID to just the function name
 * Server actions have IDs like "/src/handlers/shop/actions/shop.actions.ts#updateCartQuantity"
 * We normalize to just "updateCartQuantity" for consistency
 */
function normalizeActionId(actionId: string): string {
  if (actionId.includes("#")) {
    return actionId.split("#").pop()!;
  }
  return actionId;
}

/**
 * Extract action ID from a server action function or string.
 *
 * Actions passed as props from server components lose their metadata
 * during RSC serialization - use a string action name instead.
 */
export function getActionId(action: ServerActionFunction | string): string {
  invariant(
    typeof action === "function" || typeof action === "string",
    `useAction: action must be a function or string, got ${typeof action}`
  );
  const actionId = (action as any)?.$$id;
  if (actionId) {
    return normalizeActionId(actionId);
  }

  // If action is a string, use it directly
  if (typeof action === "string") {
    return action;
  }

  // If we get here, this is likely an action passed as prop from a server component
  // These lose their metadata during RSC serialization
  throw new Error(
    `useAction: Cannot extract action ID from function reference.

This typically happens when an action is passed as a prop from a server component.
Actions passed through RSC lose their metadata during serialization.

Solutions:
1. Import the action directly in your client component:
   import { myAction } from './actions';
   const state = useAction(myAction);

2. Use the action name as a string:
   const state = useAction("myAction");

The string must match the exported function name from your "use server" file.`
  );
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
 * - If multiple actions fire, tracks only the last one
 * - Supports selector pattern like useNavigation
 *
 * @param action - Either a server action function or a string action name.
 *   - **Function**: Must be directly imported in the client component.
 *     Actions passed as props from server components will throw an error.
 *   - **String**: The exported function name from your "use server" file.
 *     This is the recommended approach when the action is passed as a prop.
 *
 * @example
 * ```tsx
 * // Option 1: Direct import (recommended for client components)
 * import { addToCart } from './actions';
 * const actionState = useAction(addToCart);
 *
 * // Option 2: String-based (required when action is passed as prop)
 * const actionState = useAction('addToCart');
 *
 * // With selector for specific values
 * const isLoading = useAction(addToCart, state => state.state === 'loading');
 * const error = useAction(addToCart, state => state.error);
 * ```
 *
 * @note Actions passed as props from server components lose their metadata
 * during RSC serialization. Use a string action name or import directly.
 */
export function useAction(
  action: ServerActionFunction | string
): TrackedActionState;
export function useAction<T>(
  action: ServerActionFunction | string,
  selector: (state: TrackedActionState) => T
): T;
export function useAction<T>(
  action: ServerActionFunction | string,
  selector?: (state: TrackedActionState) => T
): T | TrackedActionState {
  const ctx = useContext(NavigationStoreContext);
  const actionId =
    typeof window !== "undefined" && typeof document !== "undefined"
      ? getActionId(action)
      : "";

  // Base state for useOptimistic
  const [baseState, setBaseState] = useState<T | TrackedActionState>(() => {
    if (!ctx) {
      return selector ? selector(DEFAULT_ACTION_STATE) : DEFAULT_ACTION_STATE;
    }
    const state = ctx.eventController.getActionState(actionId);
    return selector ? selector(state) : state;
  });
  const prevSelected = useRef(baseState);
  prevSelected.current = baseState;
  // useOptimistic allows immediate updates during transitions/actions
  const [optimisticState, setOptimisticState] = useOptimistic<
    T | TrackedActionState
  >(null!);

  // Memoize the selector to avoid unnecessary re-subscriptions
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to action state changes from event controller
  useEffect(() => {
    if (!ctx) return;

    // Subscribe to action-specific updates
    const unsubscribe = ctx.eventController.subscribeToAction(
      actionId,
      (state) => {
        const selectedState = selectorRef.current
          ? selectorRef.current(state)
          : state;

        if (!isShallowEqual(selectedState, prevSelected.current)) {
          prevSelected.current = selectedState;
          setBaseState(selectedState);
          startTransition(() => {
            setOptimisticState(selectedState);
          });
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, [actionId]);

  return (optimisticState ?? baseState) as T | TrackedActionState;
}

function isShallowEqual<T, U>(selectedState: T, baseState: U): boolean {
  // If references are equal, they're shallow equal
  //@ts-expect-error -- TS doesn't like comparing generics
  if (selectedState === baseState) {
    return true;
  }

  // If either is null/undefined and they're not equal, they're not shallow equal
  if (selectedState == null || baseState == null) {
    return false;
  }

  // If types are different, they're not shallow equal
  if (typeof selectedState !== typeof baseState) {
    return false;
  }

  // For primitives, === comparison is sufficient (already checked above)
  if (typeof selectedState !== "object") {
    return false;
  }

  // For objects, compare keys and values shallowly
  const keysA = Object.keys(selectedState as object);
  const keysB = Object.keys(baseState as object);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (
      !Object.prototype.hasOwnProperty.call(baseState, key) ||
      (selectedState as any)[key] !== (baseState as any)[key]
    ) {
      return false;
    }
  }

  return true;
}

export type { TrackedActionState };
