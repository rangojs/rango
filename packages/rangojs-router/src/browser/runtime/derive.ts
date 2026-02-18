/**
 * Client Segment Runtime - Derived State
 *
 * Pure functions for deriving hook-consumed state from ClientRuntimeState.
 * Used by the store to power useAction, useNavigation, useHandle, etc.
 *
 * Depends only on types.ts and transaction.ts.
 */

import type {
  Transaction,
  DerivedActionState,
  DerivedSegmentState,
  HandleState,
  ClientRuntimeState,
} from "./types.js";
import { isTerminalPhase } from "./transaction.js";

// ---------------------------------------------------------------------------
// Per-action state derivation (for useAction)
// ---------------------------------------------------------------------------

/**
 * Derive the current state for a specific server action.
 *
 * Finds the most recent transaction matching the actionId (by exact match
 * on full ID "hash#name", or suffix match on name only).
 *
 * Phase mapping:
 *   created/fetching  -> "loading"
 *   streaming         -> "streaming"
 *   received          -> "loading" (still processing batch commit)
 *   committed         -> "idle" with result
 *   failed            -> "idle" with error
 *   no match          -> "idle"
 */
export function deriveActionState(
  transactions: Map<string, Transaction>,
  actionId: string
): DerivedActionState {
  const idle: DerivedActionState = {
    state: "idle",
    actionId: null,
    payload: null,
    error: null,
    result: null,
  };

  // Find the most recent matching action tx (highest txId)
  let latestTx: Transaction | undefined;
  for (const tx of transactions.values()) {
    if (tx.kind !== "action") continue;
    if (!matchesActionId(tx.actionId, actionId)) continue;
    if (!latestTx || tx.txId > latestTx.txId) {
      latestTx = tx;
    }
  }

  if (!latestTx) return idle;

  switch (latestTx.phase) {
    case "created":
    case "fetching":
    case "received":
      return {
        state: "loading",
        actionId: latestTx.actionId ?? null,
        payload: latestTx.actionArgs ?? null,
        error: null,
        result: null,
      };
    case "streaming":
      return {
        state: "streaming",
        actionId: latestTx.actionId ?? null,
        payload: latestTx.actionArgs ?? null,
        error: null,
        result: null,
      };
    case "committed":
      return {
        state: "idle",
        actionId: latestTx.actionId ?? null,
        payload: latestTx.actionArgs ?? null,
        error: null,
        result: latestTx.resultReturnValue ?? null,
      };
    case "failed":
      return {
        state: "idle",
        actionId: latestTx.actionId ?? null,
        payload: latestTx.actionArgs ?? null,
        error: latestTx.resultError ?? null,
        result: null,
      };
    case "aborted":
      return idle;
    default:
      return idle;
  }
}

/**
 * Match an action transaction's actionId against a query.
 * Supports exact match ("hash#name") or suffix match on name portion.
 */
function matchesActionId(
  txActionId: string | undefined,
  query: string
): boolean {
  if (!txActionId) return false;
  if (txActionId === query) return true;
  // Suffix match: query "doSomething" matches "abc123#doSomething"
  if (txActionId.includes("#") && txActionId.endsWith(`#${query}`)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Segment state derivation (for useSegment / useNavigation)
// ---------------------------------------------------------------------------

/**
 * Derive per-segment state from runtime state.
 */
export function deriveSegmentState(
  state: ClientRuntimeState,
  segmentPath: string
): DerivedSegmentState {
  return {
    path: segmentPath,
    currentUrl: state.current.url,
    currentSegmentIds: Array.from(state.current.segmentIndex.keys()),
  };
}

// ---------------------------------------------------------------------------
// Handle state derivation
// ---------------------------------------------------------------------------

/**
 * Derive handle state for useHandle hook.
 * HandleData is accumulated from streaming handle generators
 * as segments load.
 */
export function deriveHandleState(state: ClientRuntimeState): HandleState {
  return state.handleState;
}

// ---------------------------------------------------------------------------
// Navigation derived state (for useNavigation)
// ---------------------------------------------------------------------------

export interface DerivedNavigationState {
  phase: "idle" | "loading" | "streaming";
  pendingUrl: string | null;
  currentUrl: string;
  interceptSourceUrl: string | null;
  networkError: Error | null;
}

/**
 * Derive navigation state for useNavigation hook.
 */
export function deriveNavigationState(
  state: ClientRuntimeState
): DerivedNavigationState {
  return {
    phase: state.phase,
    pendingUrl: state.pendingUrl,
    currentUrl: state.current.url,
    interceptSourceUrl: state.interceptSourceUrl,
    networkError: state.networkError,
  };
}
