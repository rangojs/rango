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

/**
 * Store state - only lifecycle, no result/error
 */
interface StoreActionState {
  state: ActionLifecycleState;
  actionId: string | null;
  payload: unknown[] | FormData | null;
}

/**
 * Local state - includes result/error captured from store emission
 */
interface LocalActionState extends StoreActionState {
  error: unknown | null;
  result: unknown | null;
}

/**
 * Default action state (idle with no payload)
 */
const DEFAULT_ACTION_STATE: LocalActionState = {
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
 * Extract action ID from a server action function or string
 * Server actions have a $$id property that contains the action ID
 */
function getActionId(action: ServerActionFunction | string): string {
  if (typeof action === "string") {
    return normalizeActionId(action);
  }

  // Server actions created by the RSC compiler have $$id property
  const actionId = (action as any).name || (action as any).$$id;
  if (!actionId) {
    throw new Error(
      "useAction: Invalid action. Must be a server action function or action ID string."
    );
  }
  return normalizeActionId(actionId);
}

/**
 * Server action function type
 * Server actions have a $$id property added by the RSC compiler
 */
type ServerActionFunction = ((...args: any[]) => Promise<any>) & {
  $$id?: string;
};

/**
 * Hook to track the lifecycle of a specific server action
 *
 * Unlike useNavigation which tracks global navigation state, useAction
 * tracks the state of individual server action invocations.
 *
 * Features:
 * - Tracks action lifecycle: idle → loading → streaming → idle
 * - Captures result/error locally (React handles cleanup)
 * - If multiple actions fire, tracks only the last one
 * - Supports selector pattern like useNavigation
 *
 * @example
 * ```tsx
 * import { addToCart } from './actions';
 *
 * // Track full action state
 * const actionState = useAction(addToCart);
 *
 * // With selector for specific values
 * const isLoading = useAction(addToCart, state => state.state === 'loading');
 * const error = useAction(addToCart, state => state.error);
 *
 * // Using action ID string directly
 * const state = useAction('addToCart');
 * ```
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
  const [baseState, setBaseState] = useState<T | TrackedActionState>(() =>
    selector
      ? selector?.(ctx?.store.getActionState(actionId) ?? DEFAULT_ACTION_STATE)
      : (ctx?.store.getActionState(actionId) ?? DEFAULT_ACTION_STATE)
  );

  // useOptimistic allows immediate updates during transitions/actions
  const [optimisticState, setOptimisticState] = useOptimistic<
    T | TrackedActionState
  >(null!);

  // Memoize the selector to avoid unnecessary re-subscriptions
  const dataRef = useRef<{
    result: TrackedActionState["result"];
    error: TrackedActionState["error"];
  }>(null);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  // Subscribe to action state changes from store
  useEffect(() => {
    if (!ctx) return;

    // Subscribe to action-specific updates
    const unsubscribe = ctx.store.subscribeToAction(actionId, (storeState) => {
      if (
        storeState.result !== null &&
        storeState.result !== dataRef.current?.result
      ) {
        dataRef.current = {
          result: storeState.result,
          error: storeState.error,
        };
      }
      if (
        storeState.error !== null &&
        storeState.error !== dataRef.current?.error
      ) {
        dataRef.current = {
          result: storeState.result,
          error: storeState.error,
        };
      }
      const newState: LocalActionState = {
        state: storeState.state,
        actionId: storeState.actionId,
        payload: storeState.payload,
        // Capture result/error when idle, clear when loading
        error: dataRef.current?.error,
        result: dataRef.current?.result,
      };

      // Use optimistic update for immediate feedback during transitions
      // assumes transition is in progress
      const selectedState = selectorRef.current
        ? selectorRef.current(newState)
        : newState;
      if (!isShallowEqual(selectedState, baseState)) {
        setBaseState(selectedState);
        startTransition(() => {
          setOptimisticState(selectedState);
        });
      }
    });

    return () => {
      unsubscribe();
    };
  }, [actionId, ctx]);

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
