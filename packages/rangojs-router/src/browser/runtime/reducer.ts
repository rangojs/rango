/**
 * Client Segment Runtime - Reducer
 *
 * Pure function: (state, event) => { state, commands }
 * No side effects. No async. No DOM access.
 *
 * All behavior lives here. Executors are logic-free translators.
 */

import type {
  ClientRuntimeState,
  RuntimeEvent,
  RuntimeCommand,
  ReduceResult,
  Transaction,
  FetchCommand,
  ServerPatch,
  RouteSnapshot,
  CacheEntry,
} from "./types.js";
import {
  createTransaction,
  canCommit,
  derivePhase,
  derivePendingUrl,
  applyIsolation,
  abortTransaction,
  failTransaction,
  getActiveNavTx,
  getReceivedActionTxs,
  isTerminalPhase,
  pruneTerminalTransactions,
} from "./transaction.js";
import { reconcileSnapshot } from "./reconcile.js";
import {
  cacheKey,
  cacheGet,
  cacheWrite,
  cacheMarkStale,
  mergeSharedSegmentFreshness,
  cacheClear,
} from "./cache.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Set a transaction in the map, returning a new Map. */
function setTx(
  txs: Map<string, Transaction>,
  tx: Transaction
): Map<string, Transaction> {
  const next = new Map(txs);
  next.set(tx.txId, tx);
  return next;
}

/** Build a FetchCommand for a transaction. */
function fetchCmd(
  tx: Transaction,
  segmentIds: string[],
  previousUrl: string,
  mode: FetchCommand["mode"],
  headers?: Record<string, string>
): RuntimeCommand {
  return {
    kind: "FETCH",
    payload: {
      txId: tx.txId,
      url: tx.url,
      segmentIds,
      previousUrl,
      mode,
      headers,
    },
  };
}

/** Re-derive phase and pendingUrl on state. */
function rederive(state: ClientRuntimeState): ClientRuntimeState {
  return {
    ...state,
    phase: derivePhase(state.transactions),
    pendingUrl: derivePendingUrl(state.transactions),
  };
}

// ---------------------------------------------------------------------------
// Reduce: top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Main reducer. Pure function dispatching on event type.
 * Each handler returns { state, commands }.
 *
 * Terminal transaction pruning uses a two-cycle approach:
 * transactions that were terminal BEFORE this reduce step are pruned,
 * and newly-terminal transactions are tracked for the next cycle.
 * The caller (store) must pass previouslyTerminal and track nowTerminal.
 */
export function reduce(
  state: ClientRuntimeState,
  event: RuntimeEvent,
  previouslyTerminal: Set<string> = new Set()
): ReduceResult & { nowTerminal: Set<string> } {
  let result: ReduceResult;

  switch (event.type) {
    case "NAV_START":
      result = handleNavStart(state, event.url, event.options);
      break;
    case "NAV_RESPONSE":
      result = handleNavResponse(state, event.txId, event.patch);
      break;
    case "POPSTATE":
      result = handlePopstate(state, event.url, event.historyKey, event.interceptState);
      break;
    case "ACTION_START":
      result = handleActionStart(state, event.actionId, event.args);
      break;
    case "ACTION_RESPONSE":
      result = handleActionResponse(state, event.txId, event.patch, event.returnValue);
      break;
    case "ACTION_ERROR_RESPONSE":
      result = handleActionErrorResponse(state, event.txId, event.patch, event.error);
      break;
    case "REVALIDATE_DONE":
      result = handleRevalidateDone(state, event.txId, event.patch);
      break;
    case "STREAM_START":
      result = handleStreamStart(state, event.txId);
      break;
    case "STREAM_END":
      result = handleStreamEnd(state, event.txId);
      break;
    case "HMR_UPDATE":
      result = handleHmrUpdate(state);
      break;
    case "SEGMENTS_MISSING":
      result = handleSegmentsMissing(state, event.txId, event.missing);
      break;
    case "HANDLES_UPDATE":
      result = handleHandlesUpdate(state, event.txId, event.handles, event.matched);
      break;
    case "CROSS_TAB_INVALIDATION":
      result = handleCrossTabInvalidation(state, event.path, event.segmentIds);
      break;
    case "CACHE_CLEAR_REQUESTED":
      result = { state: { ...state, cache: cacheClear() }, commands: [] };
      break;
    case "TX_ABORT_REQUESTED":
      result = handleTxAbort(state, event.txId);
      break;
    case "NETWORK_ERROR":
      result = handleNetworkError(state, event.txId, event.error);
      break;
    case "VERSION_MISMATCH":
      result = {
        state,
        commands: [{ kind: "HARD_RELOAD", payload: { url: event.reloadUrl } }],
      };
      break;
    default: {
      const _exhaustive: never = event;
      result = { state, commands: [] };
    }
  }

  // Prune terminal transactions (two-cycle GC)
  const { pruned, nowTerminal } = pruneTerminalTransactions(
    result.state.transactions,
    previouslyTerminal
  );

  const finalState = rederive({ ...result.state, transactions: pruned });

  return { state: finalState, commands: result.commands, nowTerminal };
}

// ---------------------------------------------------------------------------
// NAV_START
// ---------------------------------------------------------------------------

function handleNavStart(
  state: ClientRuntimeState,
  url: string,
  options: import("./types.js").NavOptions
): ReduceResult {
  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  // 1. Increment navEpoch
  const navEpoch = state.navEpoch + 1;

  // 2. Create nav transaction
  const { tx, nextTxCounter } = createTransaction(
    { txCounter: state.txCounter, navEpoch, actionEpoch: state.actionEpoch, current: state.current },
    "nav",
    "exclusive",
    url,
    { navOptions: options }
  );

  // 3. Apply isolation: abort existing nav transactions
  const toAbort = applyIsolation(txs, tx);
  for (const abortId of toAbort) {
    const existing = txs.get(abortId);
    if (existing) {
      txs = setTx(txs, abortTransaction(existing));
      commands.push({ kind: "ABORT_FETCH", payload: { txId: abortId } });
    }
  }

  // 4. Check cache
  const key = cacheKey(url, options.interceptSourceUrl);
  const cached = cacheGet(state.cache, key);
  let current = state.current;
  let cache = state.cache;
  let updatedTx = { ...tx, phase: "fetching" as const };

  if (cached) {
    // Cache hit: optimistic render with shared-segment freshness
    const freshSnapshot = mergeSharedSegmentFreshness(cached.snapshot, state.current);
    updatedTx = { ...updatedTx, optimisticSnapshot: freshSnapshot };
    current = freshSnapshot;

    // Emit RENDER for optimistic snapshot
    commands.push({
      kind: "RENDER",
      payload: { snapshot: freshSnapshot, forceAwait: false },
    });

    // Emit PUSH or REPLACE history
    const historyCmd = options.replace ? "REPLACE_HISTORY" : "PUSH_HISTORY";
    commands.push({
      kind: historyCmd,
      payload: {
        url,
        key,
        state: options.interceptSourceUrl
          ? { interceptSourceUrl: options.interceptSourceUrl }
          : {},
      },
    });
  }

  // 5. Emit FETCH (partial: send current segment IDs for diff)
  const segmentIds = Array.from(state.current.segmentIndex.keys());
  commands.push(
    fetchCmd(updatedTx, segmentIds, state.current.url, "nav")
  );

  txs = setTx(txs, updatedTx);

  const newState: ClientRuntimeState = {
    ...state,
    navEpoch,
    txCounter: nextTxCounter,
    transactions: txs,
    current,
    cache,
    interceptSourceUrl: options.interceptSourceUrl ?? null,
  };

  return { state: newState, commands };
}

// ---------------------------------------------------------------------------
// NAV_RESPONSE
// ---------------------------------------------------------------------------

function handleNavResponse(
  state: ClientRuntimeState,
  txId: string,
  patch: ServerPatch
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  const decision = canCommit(state, tx);
  if (!decision.allowed) {
    if (decision.action === "abort") {
      txs = setTx(txs, abortTransaction(tx));
    }
    return { state: { ...state, transactions: txs }, commands };
  }

  // Reconcile
  const base = tx.optimisticSnapshot ?? tx.blueprintSnapshot;
  const result = reconcileSnapshot(base, patch, "navigate");

  if (!result.ok) {
    if (result.reason === "MISSING_MATCHED_SEGMENT" || result.reason === "STRUCTURE_VIOLATION") {
      // Full refetch with same txId
      commands.push(fetchCmd(tx, [], state.current.url, "nav"));
      return { state, commands };
    }
    return { state, commands };
  }

  // Commit: update snapshot URL/key from nav
  const snapshot: RouteSnapshot = {
    ...result.snapshot,
    url: tx.url,
    key: cacheKey(tx.url, tx.navOptions?.interceptSourceUrl),
    interceptSourceUrl: tx.navOptions?.interceptSourceUrl ?? null,
    handleData: patch.cachedHandleData ?? result.snapshot.handleData,
  };

  // Write to cache (fresh)
  const cache = cacheWrite(
    state.cache,
    snapshot.key,
    snapshot,
    false,
    state.cacheMaxSize,
    snapshot.key
  );

  // Transition tx to committed
  const committedTx: Transaction = { ...tx, phase: "committed", hasActiveStream: false };
  txs = setTx(txs, committedTx);

  // Commands: if optimistic was set, just replace history + render
  if (tx.optimisticSnapshot) {
    commands.push({
      kind: "REPLACE_HISTORY",
      payload: {
        url: tx.url,
        key: snapshot.key,
        state: tx.navOptions?.interceptSourceUrl
          ? { interceptSourceUrl: tx.navOptions.interceptSourceUrl }
          : {},
      },
    });
    commands.push({
      kind: "RENDER",
      payload: { snapshot, forceAwait: false },
    });
  } else {
    // No optimistic: push history, render, scroll
    const historyCmd = tx.navOptions?.replace ? "REPLACE_HISTORY" : "PUSH_HISTORY";
    commands.push({
      kind: historyCmd,
      payload: {
        url: tx.url,
        key: snapshot.key,
        state: tx.navOptions?.interceptSourceUrl
          ? { interceptSourceUrl: tx.navOptions.interceptSourceUrl }
          : {},
      },
    });
    commands.push({
      kind: "RENDER",
      payload: { snapshot, forceAwait: false },
    });
    if (tx.navOptions?.scroll !== false) {
      commands.push({
        kind: "SCROLL",
        payload: { behavior: "top" },
      });
    }
  }

  const handleState = patch.cachedHandleData
    ? { data: patch.cachedHandleData, segmentOrder: patch.matched }
    : state.handleState;

  const newState: ClientRuntimeState = {
    ...state,
    current: snapshot,
    transactions: txs,
    cache,
    handleState,
    interceptSourceUrl: snapshot.interceptSourceUrl ?? null,
  };

  return { state: newState, commands };
}

// ---------------------------------------------------------------------------
// POPSTATE
// ---------------------------------------------------------------------------

function handlePopstate(
  state: ClientRuntimeState,
  url: string,
  historyKey: string,
  interceptState?: { interceptSourceUrl: string; slots?: Record<string, import("./types.js").SlotState> }
): ReduceResult {
  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  // Abort any active nav tx
  const activeNav = getActiveNavTx(txs);
  if (activeNav) {
    txs = setTx(txs, abortTransaction(activeNav));
    commands.push({ kind: "ABORT_FETCH", payload: { txId: activeNav.txId } });
  }

  // Look up cache
  const cached = cacheGet(state.cache, historyKey);

  if (cached) {
    // Cache hit: render immediately
    const snapshot = interceptState
      ? { ...cached.snapshot, interceptSourceUrl: interceptState.interceptSourceUrl, slots: { ...cached.snapshot.slots, ...interceptState.slots } }
      : cached.snapshot;

    commands.push({
      kind: "RENDER",
      payload: { snapshot, forceAwait: true },
    });
    commands.push({
      kind: "SCROLL",
      payload: { behavior: "restore" },
    });

    let newState: ClientRuntimeState = {
      ...state,
      current: snapshot,
      transactions: txs,
      interceptSourceUrl: interceptState?.interceptSourceUrl ?? null,
    };

    // If stale: create background revalidate tx
    if (cached.stale) {
      const { tx: revalTx, nextTxCounter } = createTransaction(
        { txCounter: state.txCounter, navEpoch: state.navEpoch, actionEpoch: state.actionEpoch, current: snapshot },
        "revalidate",
        "background",
        url,
        { targetCacheKey: historyKey }
      );
      const fetchingRevalTx: Transaction = { ...revalTx, phase: "fetching" };
      txs = setTx(txs, fetchingRevalTx);
      commands.push(
        fetchCmd(fetchingRevalTx, Array.from(snapshot.segmentIndex.keys()), url, "revalidate")
      );
      newState = { ...newState, transactions: txs, txCounter: nextTxCounter };
    }

    return { state: newState, commands };
  }

  // Cache miss: create nav tx and full fetch
  const navEpoch = state.navEpoch + 1;
  const { tx, nextTxCounter } = createTransaction(
    { txCounter: state.txCounter, navEpoch, actionEpoch: state.actionEpoch, current: state.current },
    "nav",
    "exclusive",
    url
  );
  const fetchingTx: Transaction = { ...tx, phase: "fetching" };
  txs = setTx(txs, fetchingTx);
  commands.push(fetchCmd(fetchingTx, [], state.current.url, "nav"));

  return {
    state: {
      ...state,
      navEpoch,
      txCounter: nextTxCounter,
      transactions: txs,
      interceptSourceUrl: interceptState?.interceptSourceUrl ?? null,
    },
    commands,
  };
}

// ---------------------------------------------------------------------------
// ACTION_START
// ---------------------------------------------------------------------------

function handleActionStart(
  state: ClientRuntimeState,
  actionId: string,
  args: unknown[]
): ReduceResult {
  const commands: RuntimeCommand[] = [];

  // 1. Increment actionEpoch
  const actionEpoch = state.actionEpoch + 1;

  // 2. Create action transaction
  const { tx, nextTxCounter } = createTransaction(
    { txCounter: state.txCounter, navEpoch: state.navEpoch, actionEpoch, current: state.current },
    "action",
    "concurrent",
    state.current.url,
    { actionId, actionArgs: args }
  );

  const fetchingTx: Transaction = { ...tx, phase: "fetching" };
  const txs = setTx(state.transactions, fetchingTx);

  // 3. Emit FETCH
  commands.push(fetchCmd(fetchingTx, Array.from(state.current.segmentIndex.keys()), state.current.url, "action"));

  // 4. Mark current cache entry as stale
  const key = cacheKey(state.current.url, state.interceptSourceUrl);
  const cache = cacheMarkStale(state.cache, key);

  return {
    state: {
      ...state,
      actionEpoch,
      txCounter: nextTxCounter,
      transactions: txs,
      cache,
    },
    commands,
  };
}

// ---------------------------------------------------------------------------
// ACTION_RESPONSE
// ---------------------------------------------------------------------------

function handleActionResponse(
  state: ClientRuntimeState,
  txId: string,
  patch: ServerPatch,
  returnValue: unknown
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  // Store result on tx, transition to received
  const receivedTx: Transaction = {
    ...tx,
    phase: "received",
    resultPatch: patch,
    resultReturnValue: returnValue,
  };
  txs = setTx(txs, receivedTx);

  // Check commit gate
  const stateWithUpdatedTx = { ...state, transactions: txs };
  const decision = canCommit(stateWithUpdatedTx, receivedTx);

  if (!decision.allowed) {
    if (decision.reason === "ACTION_NAVIGATED_AWAY") {
      // Create background revalidate for current key, commit action tx
      const committedTx: Transaction = { ...receivedTx, phase: "committed" };
      txs = setTx(txs, committedTx);

      const currentKey = cacheKey(state.current.url, state.interceptSourceUrl);
      const { tx: revalTx, nextTxCounter } = createTransaction(
        { txCounter: state.txCounter, navEpoch: state.navEpoch, actionEpoch: state.actionEpoch, current: state.current },
        "revalidate",
        "background",
        state.current.url,
        { targetCacheKey: currentKey }
      );
      const fetchingReval: Transaction = { ...revalTx, phase: "fetching" };
      txs = setTx(txs, fetchingReval);
      commands.push(
        fetchCmd(fetchingReval, Array.from(state.current.segmentIndex.keys()), state.current.url, "revalidate")
      );

      return {
        state: { ...state, transactions: txs, txCounter: nextTxCounter },
        commands,
      };
    }

    if (decision.reason === "CONCURRENT_PENDING") {
      // Defer: store patch on tx but don't commit or render
      return { state: { ...state, transactions: txs }, commands };
    }

    // TX_ABORTED or TX_FAILED: ignore
    return { state: { ...state, transactions: txs }, commands };
  }

  // Allowed: reconcile all received action tx results (batch commit)
  const receivedSiblings = getReceivedActionTxs(txs);
  let current = state.current;

  for (const sibling of receivedSiblings) {
    if (!sibling.resultPatch) continue;
    const result = reconcileSnapshot(sibling.blueprintSnapshot, sibling.resultPatch, "action");
    if (result.ok) {
      current = {
        ...result.snapshot,
        url: current.url,
        key: current.key,
        interceptSourceUrl: current.interceptSourceUrl,
        handleData: sibling.resultPatch.cachedHandleData ?? current.handleData,
      };
    }
    // Transition each to committed
    txs = setTx(txs, { ...sibling, phase: "committed", hasActiveStream: false });
  }

  // Write to cache (stale - actions always produce stale cache)
  const key = cacheKey(current.url, state.interceptSourceUrl);
  const cache = cacheWrite(state.cache, key, current, true, state.cacheMaxSize, key);

  // Emit render + broadcast
  commands.push({
    kind: "RENDER",
    payload: { snapshot: current, forceAwait: false },
  });

  // Broadcast invalidation for revalidated segment IDs
  const segmentIds = patch.diff.length > 0 ? patch.diff : Array.from(current.segmentIndex.keys());
  commands.push({
    kind: "BROADCAST_INVALIDATION",
    payload: { path: current.url, segmentIds },
  });

  return {
    state: { ...state, current, transactions: txs, cache },
    commands,
  };
}

// ---------------------------------------------------------------------------
// ACTION_ERROR_RESPONSE
// ---------------------------------------------------------------------------

function handleActionErrorResponse(
  state: ClientRuntimeState,
  txId: string,
  patch: ServerPatch,
  error: unknown
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  const decision = canCommit(state, tx);
  if (!decision.allowed) {
    if (decision.action === "abort") {
      txs = setTx(txs, abortTransaction(tx));
    }
    return { state: { ...state, transactions: txs }, commands };
  }

  // Build error snapshot: use base segments, replace errored segment from patch
  const result = reconcileSnapshot(tx.blueprintSnapshot, patch, "action");
  let snapshot: RouteSnapshot;

  if (result.ok) {
    snapshot = {
      ...result.snapshot,
      url: state.current.url,
      key: state.current.key,
    };
  } else {
    // Fallback: use current snapshot (error rendering will handle via error boundary)
    snapshot = state.current;
  }

  // Transition tx to committed with error
  const committedTx: Transaction = {
    ...tx,
    phase: "committed",
    hasActiveStream: false,
    resultError: error,
    resultPatch: patch,
  };
  txs = setTx(txs, committedTx);

  commands.push({
    kind: "RENDER",
    payload: { snapshot, forceAwait: false },
  });

  return {
    state: { ...state, current: snapshot, transactions: txs },
    commands,
  };
}

// ---------------------------------------------------------------------------
// REVALIDATE_DONE
// ---------------------------------------------------------------------------

function handleRevalidateDone(
  state: ClientRuntimeState,
  txId: string,
  patch: ServerPatch
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  let txs = state.transactions;
  const decision = canCommit(state, tx);

  if (!decision.allowed) {
    if (decision.action === "abort") {
      txs = setTx(txs, abortTransaction(tx));
    }
    return { state: { ...state, transactions: txs }, commands: [] };
  }

  // Reconcile against cached snapshot for target key
  const targetEntry = tx.targetCacheKey ? cacheGet(state.cache, tx.targetCacheKey) : undefined;
  const base = targetEntry?.snapshot ?? tx.blueprintSnapshot;
  const result = reconcileSnapshot(base, patch, "revalidate");

  if (!result.ok) {
    // Revalidation failure: just abort the tx, no user-facing impact
    txs = setTx(txs, abortTransaction(tx));
    return { state: { ...state, transactions: txs }, commands: [] };
  }

  // Update cache entry (fresh)
  const key = tx.targetCacheKey ?? cacheKey(tx.url);
  const snapshot = { ...result.snapshot, url: tx.url, key };
  const cache = cacheWrite(state.cache, key, snapshot, false, state.cacheMaxSize, state.current.key);

  // Transition tx to committed
  txs = setTx(txs, { ...tx, phase: "committed", hasActiveStream: false });

  // Background revalidation: no RENDER command (silent cache update)
  return {
    state: { ...state, transactions: txs, cache },
    commands: [],
  };
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

function handleStreamStart(state: ClientRuntimeState, txId: string): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx || isTerminalPhase(tx.phase)) return { state, commands: [] };

  const updatedTx: Transaction = { ...tx, hasActiveStream: true, phase: "streaming" };
  return {
    state: { ...state, transactions: setTx(state.transactions, updatedTx) },
    commands: [],
  };
}

function handleStreamEnd(state: ClientRuntimeState, txId: string): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  const updatedTx: Transaction = { ...tx, hasActiveStream: false };
  return {
    state: { ...state, transactions: setTx(state.transactions, updatedTx) },
    commands: [],
  };
}

// ---------------------------------------------------------------------------
// HMR_UPDATE
// ---------------------------------------------------------------------------

function handleHmrUpdate(state: ClientRuntimeState): ReduceResult {
  const commands: RuntimeCommand[] = [];
  let txs = state.transactions;

  // Create HMR transaction (exclusive: aborts previous HMR)
  const { tx, nextTxCounter } = createTransaction(
    { txCounter: state.txCounter, navEpoch: state.navEpoch, actionEpoch: state.actionEpoch, current: state.current },
    "hmr",
    "exclusive",
    state.current.url
  );

  // Abort previous HMR transactions
  const toAbort = applyIsolation(txs, tx);
  for (const abortId of toAbort) {
    const existing = txs.get(abortId);
    if (existing) {
      txs = setTx(txs, abortTransaction(existing));
      commands.push({ kind: "ABORT_FETCH", payload: { txId: abortId } });
    }
  }

  const fetchingTx: Transaction = { ...tx, phase: "fetching" };
  txs = setTx(txs, fetchingTx);

  // Full fetch (segmentIds: [] = server sends everything)
  commands.push(fetchCmd(fetchingTx, [], state.current.url, "hmr"));

  return {
    state: { ...state, txCounter: nextTxCounter, transactions: txs },
    commands,
  };
}

// ---------------------------------------------------------------------------
// SEGMENTS_MISSING
// ---------------------------------------------------------------------------

function handleSegmentsMissing(
  state: ClientRuntimeState,
  txId: string,
  _missing: string[]
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  // Actions tolerate partial segments (will be fetched on consolidation)
  if (tx.kind === "action") return { state, commands: [] };

  // Nav/HMR: trigger full refetch
  const commands: RuntimeCommand[] = [];
  commands.push(fetchCmd(tx, [], state.current.url, tx.kind === "hmr" ? "hmr" : "nav"));

  return { state, commands };
}

// ---------------------------------------------------------------------------
// HANDLES_UPDATE
// ---------------------------------------------------------------------------

function handleHandlesUpdate(
  state: ClientRuntimeState,
  txId: string,
  handles: import("./types.js").HandleData,
  matched?: string[]
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  // Update handle state
  const handleState = {
    data: handles,
    segmentOrder: matched ?? state.handleState.segmentOrder,
  };

  return {
    state: { ...state, handleState },
    commands: [],
  };
}

// ---------------------------------------------------------------------------
// CROSS_TAB_INVALIDATION
// ---------------------------------------------------------------------------

function handleCrossTabInvalidation(
  state: ClientRuntimeState,
  path: string,
  segmentIds: string[]
): ReduceResult {
  const commands: RuntimeCommand[] = [];
  const invalidatedIds = new Set(segmentIds);
  let cache = state.cache;

  // Mark cache entries with shared segments as stale
  for (const [key, entry] of cache) {
    const hasShared = entry.snapshot.segments.some((s) => invalidatedIds.has(s.id));
    if (hasShared) {
      cache = cacheMarkStale(cache, key);
    }
  }

  // If current snapshot shares segments and idle: revalidate
  const currentHasShared = state.current.segments.some((s) => invalidatedIds.has(s.id));
  let txs = state.transactions;
  let txCounter = state.txCounter;

  if (currentHasShared && state.phase === "idle") {
    const currentKey = cacheKey(state.current.url, state.interceptSourceUrl);
    const { tx: revalTx, nextTxCounter } = createTransaction(
      { txCounter: state.txCounter, navEpoch: state.navEpoch, actionEpoch: state.actionEpoch, current: state.current },
      "revalidate",
      "background",
      state.current.url,
      { targetCacheKey: currentKey }
    );
    const fetchingReval: Transaction = { ...revalTx, phase: "fetching" };
    txs = setTx(txs, fetchingReval);
    txCounter = nextTxCounter;
    commands.push(
      fetchCmd(fetchingReval, Array.from(state.current.segmentIndex.keys()), state.current.url, "revalidate")
    );
  }

  return {
    state: { ...state, cache, transactions: txs, txCounter },
    commands,
  };
}

// ---------------------------------------------------------------------------
// TX_ABORT_REQUESTED
// ---------------------------------------------------------------------------

function handleTxAbort(state: ClientRuntimeState, txId: string): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx || isTerminalPhase(tx.phase)) return { state, commands: [] };

  const txs = setTx(state.transactions, abortTransaction(tx));
  return {
    state: { ...state, transactions: txs },
    commands: [{ kind: "ABORT_FETCH", payload: { txId } }],
  };
}

// ---------------------------------------------------------------------------
// NETWORK_ERROR
// ---------------------------------------------------------------------------

function handleNetworkError(
  state: ClientRuntimeState,
  txId: string,
  error: Error
): ReduceResult {
  const tx = state.transactions.get(txId);
  if (!tx) return { state, commands: [] };

  const txs = setTx(state.transactions, failTransaction(tx, error));

  return {
    state: { ...state, transactions: txs, networkError: error },
    commands: [
      {
        kind: "RENDER",
        payload: { snapshot: state.current, forceAwait: false },
      },
    ],
  };
}
