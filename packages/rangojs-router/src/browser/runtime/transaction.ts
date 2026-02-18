/**
 * Client Segment Runtime - Transaction Functions
 *
 * Pure functions for transaction lifecycle, commit gate, phase derivation,
 * and isolation rules. No side effects, no DOM access.
 *
 * Depends only on types.ts.
 */

import type {
  Transaction,
  TxPhase,
  TxKind,
  TxIsolation,
  ClientRuntimeState,
  CommitDecision,
  RouteSnapshot,
  NavOptions,
} from "./types.js";

export type { Transaction, TxPhase, CommitDecision };

// ---------------------------------------------------------------------------
// Terminal phase check
// ---------------------------------------------------------------------------

const TERMINAL_PHASES: Set<TxPhase> = new Set(["committed", "aborted", "failed"]);

export function isTerminalPhase(phase: TxPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

// ---------------------------------------------------------------------------
// Transaction factory
// ---------------------------------------------------------------------------

export function createTransaction(
  state: { txCounter: number; navEpoch: number; actionEpoch: number; current: RouteSnapshot },
  kind: TxKind,
  isolation: TxIsolation,
  url: string,
  extra?: Partial<Pick<Transaction, "actionId" | "actionArgs" | "targetCacheKey" | "navOptions" | "parentTxId">>
): { tx: Transaction; nextTxCounter: number } {
  const txId = `tx-${state.txCounter + 1}`;
  const epoch = kind === "nav" || kind === "hmr" ? state.navEpoch : state.actionEpoch;

  const tx: Transaction = {
    txId,
    kind,
    isolation,
    phase: "created",
    epoch,
    navEpochAtStart: state.navEpoch,
    url,
    blueprintSnapshot: state.current,
    startedAt: Date.now(),
    hasActiveStream: false,
    ...extra,
  };

  return { tx, nextTxCounter: state.txCounter + 1 };
}

// ---------------------------------------------------------------------------
// Commit gate
// ---------------------------------------------------------------------------

/**
 * Central commit gate. All staleness, epoch, abort, and concurrency checks
 * happen here. The reducer calls this for every response event.
 */
export function canCommit(state: ClientRuntimeState, tx: Transaction): CommitDecision {
  // Already terminal
  if (tx.phase === "aborted") {
    return { allowed: false, reason: "TX_ABORTED", action: "ignore" };
  }
  if (tx.phase === "failed") {
    return { allowed: false, reason: "TX_FAILED", action: "ignore" };
  }

  // Navigation epoch staleness
  if (tx.kind === "nav" && tx.epoch < state.navEpoch) {
    return { allowed: false, reason: "NAV_EPOCH_STALE", action: "abort" };
  }

  // Revalidation: target key no longer current
  if (tx.kind === "revalidate" && tx.targetCacheKey !== state.current.key) {
    return { allowed: false, reason: "REVALIDATE_KEY_MISMATCH", action: "abort" };
  }

  // Action: user navigated away since action started
  if (tx.kind === "action" && tx.navEpochAtStart !== state.navEpoch) {
    return { allowed: false, reason: "ACTION_NAVIGATED_AWAY", action: "abort" };
  }

  // Action: other action tx still in flight (batch commit)
  if (tx.kind === "action") {
    const siblings = findActionTxSiblings(state.transactions, tx.txId);
    const anyStillInFlight = siblings.some(
      (s) => s.phase === "created" || s.phase === "fetching" || s.phase === "streaming"
    );
    if (anyStillInFlight) {
      return { allowed: false, reason: "CONCURRENT_PENDING", action: "ignore" };
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Phase derivation
// ---------------------------------------------------------------------------

/**
 * Derive UI phase from active transactions.
 * Background transactions do not affect phase.
 */
export function derivePhase(transactions: Map<string, Transaction>): "idle" | "loading" | "streaming" {
  let hasLoading = false;
  let hasStreaming = false;

  for (const tx of transactions.values()) {
    if (isTerminalPhase(tx.phase)) continue;
    if (tx.isolation === "background") continue;

    if (tx.hasActiveStream || tx.phase === "streaming") {
      hasStreaming = true;
    }
    if (tx.phase === "created" || tx.phase === "fetching" || tx.phase === "received") {
      hasLoading = true;
    }
  }

  if (hasStreaming) return "streaming";
  if (hasLoading) return "loading";
  return "idle";
}

/**
 * Derive pending URL from active nav transaction.
 */
export function derivePendingUrl(transactions: Map<string, Transaction>): string | null {
  for (const tx of transactions.values()) {
    if (tx.kind === "nav" && !isTerminalPhase(tx.phase)) {
      // Only show pending during fetching phase (not during streaming or skipLoadingState)
      if (tx.phase === "fetching" || tx.phase === "created") {
        if (!tx.navOptions?.skipLoadingState) {
          return tx.url;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transaction queries
// ---------------------------------------------------------------------------

/**
 * Find the active (non-terminal) navigation transaction, if any.
 */
export function getActiveNavTx(transactions: Map<string, Transaction>): Transaction | undefined {
  for (const tx of transactions.values()) {
    if (tx.kind === "nav" && !isTerminalPhase(tx.phase)) {
      return tx;
    }
  }
  return undefined;
}

/**
 * Get txIds of all inflight (non-terminal) action transactions.
 */
export function getInflightActionTxIds(transactions: Map<string, Transaction>): string[] {
  const ids: string[] = [];
  for (const tx of transactions.values()) {
    if (tx.kind === "action" && !isTerminalPhase(tx.phase)) {
      ids.push(tx.txId);
    }
  }
  return ids;
}

/**
 * Find sibling action transactions (same kind, excluding self).
 * Includes terminal tx that haven't been pruned yet.
 */
export function findActionTxSiblings(
  transactions: Map<string, Transaction>,
  excludeTxId: string
): Transaction[] {
  const siblings: Transaction[] = [];
  for (const tx of transactions.values()) {
    if (tx.kind === "action" && tx.txId !== excludeTxId) {
      siblings.push(tx);
    }
  }
  return siblings;
}

/**
 * Find all action transactions that are in "received" phase (have response, pending batch commit).
 */
export function getReceivedActionTxs(transactions: Map<string, Transaction>): Transaction[] {
  const result: Transaction[] = [];
  for (const tx of transactions.values()) {
    if (tx.kind === "action" && tx.phase === "received") {
      result.push(tx);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * Apply isolation rules when creating a new transaction.
 * Returns txIds that should be aborted.
 */
export function applyIsolation(
  transactions: Map<string, Transaction>,
  newTx: Transaction
): string[] {
  if (newTx.isolation !== "exclusive") return [];

  const toAbort: string[] = [];
  for (const tx of transactions.values()) {
    if (tx.kind === newTx.kind && !isTerminalPhase(tx.phase) && tx.txId !== newTx.txId) {
      toAbort.push(tx.txId);
    }
  }
  return toAbort;
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

/**
 * Transition a transaction to aborted, cleaning up stream state.
 * Returns a new Transaction (does not mutate).
 */
export function abortTransaction(tx: Transaction): Transaction {
  if (isTerminalPhase(tx.phase)) return tx;
  return { ...tx, phase: "aborted", hasActiveStream: false };
}

/**
 * Transition a transaction to failed, cleaning up stream state.
 */
export function failTransaction(tx: Transaction, error?: unknown): Transaction {
  if (isTerminalPhase(tx.phase)) return tx;
  return { ...tx, phase: "failed", hasActiveStream: false, resultError: error };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/**
 * Remove terminal transactions from the map.
 * Keeps committed action tx for one cycle if they have result/error
 * (so useAction can read the result before pruning).
 *
 * @param previouslyTerminal - Set of txIds that were already terminal in
 *   the previous reduce step. These are safe to prune now.
 */
export function pruneTerminalTransactions(
  transactions: Map<string, Transaction>,
  previouslyTerminal: Set<string>
): { pruned: Map<string, Transaction>; nowTerminal: Set<string> } {
  const pruned = new Map<string, Transaction>();
  const nowTerminal = new Set<string>();

  for (const [txId, tx] of transactions) {
    if (previouslyTerminal.has(txId)) {
      // Was terminal in previous cycle, prune it now
      continue;
    }
    if (isTerminalPhase(tx.phase)) {
      // Just became terminal, keep for one more cycle
      nowTerminal.add(txId);
    }
    pruned.set(txId, tx);
  }

  return { pruned, nowTerminal };
}
