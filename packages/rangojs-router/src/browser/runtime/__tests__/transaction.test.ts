/**
 * Layer 0 tests: Transaction pure functions
 *
 * Covers canCommit() exhaustive matrix, phase derivation,
 * isolation rules, pruning, and transaction lifecycle helpers.
 */

import { describe, it, expect } from "vitest";
import type {
  Transaction,
  ClientRuntimeState,
  RouteSnapshot,
  TxPhase,
  TxKind,
  TxIsolation,
  CacheEntry,
  HandleState,
} from "../types.js";
import {
  isTerminalPhase,
  createTransaction,
  canCommit,
  derivePhase,
  derivePendingUrl,
  getActiveNavTx,
  getInflightActionTxIds,
  findActionTxSiblings,
  getReceivedActionTxs,
  applyIsolation,
  abortTransaction,
  failTransaction,
  pruneTerminalTransactions,
} from "../transaction.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides?: Partial<RouteSnapshot>): RouteSnapshot {
  return {
    key: "/",
    url: "http://localhost/",
    matched: ["root"],
    segments: [],
    segmentIndex: new Map(),
    signatures: new Map(),
    interceptSegments: [],
    slots: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeTx(overrides?: Partial<Transaction>): Transaction {
  return {
    txId: "tx-1",
    kind: "nav",
    isolation: "exclusive",
    phase: "created",
    epoch: 1,
    navEpochAtStart: 1,
    url: "http://localhost/page",
    blueprintSnapshot: makeSnapshot(),
    startedAt: Date.now(),
    hasActiveStream: false,
    ...overrides,
  };
}

function makeState(overrides?: Partial<ClientRuntimeState>): ClientRuntimeState {
  return {
    current: makeSnapshot(),
    transactions: new Map(),
    navEpoch: 1,
    actionEpoch: 1,
    txCounter: 0,
    cache: new Map<string, CacheEntry>(),
    cacheMaxSize: 20,
    phase: "idle",
    pendingUrl: null,
    handleState: { data: {}, segmentOrder: [] } as HandleState,
    interceptSourceUrl: null,
    networkError: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isTerminalPhase
// ---------------------------------------------------------------------------

describe("isTerminalPhase", () => {
  it.each<[TxPhase, boolean]>([
    ["created", false],
    ["fetching", false],
    ["streaming", false],
    ["received", false],
    ["committed", true],
    ["aborted", true],
    ["failed", true],
  ])("phase %s -> %s", (phase, expected) => {
    expect(isTerminalPhase(phase)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// createTransaction
// ---------------------------------------------------------------------------

describe("createTransaction", () => {
  it("creates a nav transaction with incremented counter", () => {
    const state = { txCounter: 5, navEpoch: 3, actionEpoch: 2, current: makeSnapshot() };
    const { tx, nextTxCounter } = createTransaction(state, "nav", "exclusive", "/page");
    expect(tx.txId).toBe("tx-6");
    expect(tx.kind).toBe("nav");
    expect(tx.isolation).toBe("exclusive");
    expect(tx.phase).toBe("created");
    expect(tx.epoch).toBe(3); // navEpoch for nav kind
    expect(tx.navEpochAtStart).toBe(3);
    expect(tx.url).toBe("/page");
    expect(nextTxCounter).toBe(6);
  });

  it("creates an action transaction using actionEpoch", () => {
    const state = { txCounter: 0, navEpoch: 5, actionEpoch: 10, current: makeSnapshot() };
    const { tx } = createTransaction(state, "action", "concurrent", "/api", {
      actionId: "myAction",
      actionArgs: [1, 2],
    });
    expect(tx.epoch).toBe(10); // actionEpoch for action kind
    expect(tx.navEpochAtStart).toBe(5);
    expect(tx.actionId).toBe("myAction");
    expect(tx.actionArgs).toEqual([1, 2]);
  });

  it("creates an hmr transaction using navEpoch", () => {
    const state = { txCounter: 0, navEpoch: 7, actionEpoch: 3, current: makeSnapshot() };
    const { tx } = createTransaction(state, "hmr", "exclusive", "/");
    expect(tx.epoch).toBe(7); // navEpoch for hmr kind
  });

  it("creates a revalidate transaction using actionEpoch", () => {
    const state = { txCounter: 0, navEpoch: 2, actionEpoch: 8, current: makeSnapshot() };
    const { tx } = createTransaction(state, "revalidate", "background", "/", {
      targetCacheKey: "/cached",
    });
    expect(tx.epoch).toBe(8); // actionEpoch for revalidate kind
    expect(tx.targetCacheKey).toBe("/cached");
  });

  it("stores blueprintSnapshot from state.current", () => {
    const snap = makeSnapshot({ key: "/special" });
    const state = { txCounter: 0, navEpoch: 1, actionEpoch: 1, current: snap };
    const { tx } = createTransaction(state, "nav", "exclusive", "/");
    expect(tx.blueprintSnapshot.key).toBe("/special");
  });
});

// ---------------------------------------------------------------------------
// canCommit - exhaustive matrix
// ---------------------------------------------------------------------------

describe("canCommit", () => {
  it("allows commit for a valid nav transaction", () => {
    const tx = makeTx({ kind: "nav", epoch: 1, phase: "received" });
    const state = makeState({ navEpoch: 1 });
    expect(canCommit(state, tx)).toEqual({ allowed: true });
  });

  it("rejects already-aborted tx", () => {
    const tx = makeTx({ phase: "aborted" });
    const state = makeState();
    const result = canCommit(state, tx);
    expect(result).toEqual({ allowed: false, reason: "TX_ABORTED", action: "ignore" });
  });

  it("rejects already-failed tx", () => {
    const tx = makeTx({ phase: "failed" });
    const state = makeState();
    const result = canCommit(state, tx);
    expect(result).toEqual({ allowed: false, reason: "TX_FAILED", action: "ignore" });
  });

  it("rejects stale nav epoch", () => {
    const tx = makeTx({ kind: "nav", epoch: 1, phase: "received" });
    const state = makeState({ navEpoch: 2 }); // epoch advanced
    const result = canCommit(state, tx);
    expect(result).toEqual({ allowed: false, reason: "NAV_EPOCH_STALE", action: "abort" });
  });

  it("allows nav tx when epoch matches current", () => {
    const tx = makeTx({ kind: "nav", epoch: 3, phase: "fetching" });
    const state = makeState({ navEpoch: 3 });
    expect(canCommit(state, tx)).toEqual({ allowed: true });
  });

  it("rejects revalidate when target key mismatches", () => {
    const tx = makeTx({
      kind: "revalidate",
      targetCacheKey: "/old",
      phase: "received",
    });
    const state = makeState({ current: makeSnapshot({ key: "/new" }) });
    const result = canCommit(state, tx);
    expect(result).toEqual({ allowed: false, reason: "REVALIDATE_KEY_MISMATCH", action: "abort" });
  });

  it("allows revalidate when target key matches", () => {
    const tx = makeTx({
      kind: "revalidate",
      targetCacheKey: "/same",
      phase: "received",
    });
    const state = makeState({ current: makeSnapshot({ key: "/same" }) });
    expect(canCommit(state, tx)).toEqual({ allowed: true });
  });

  it("rejects action when user navigated away", () => {
    const tx = makeTx({
      kind: "action",
      isolation: "concurrent",
      navEpochAtStart: 1,
      phase: "received",
    });
    const state = makeState({ navEpoch: 2 }); // user navigated
    state.transactions.set(tx.txId, tx);
    const result = canCommit(state, tx);
    expect(result).toEqual({ allowed: false, reason: "ACTION_NAVIGATED_AWAY", action: "abort" });
  });

  it("allows action when navEpoch unchanged", () => {
    const tx = makeTx({
      txId: "tx-1",
      kind: "action",
      isolation: "concurrent",
      navEpochAtStart: 1,
      phase: "received",
    });
    const state = makeState({ navEpoch: 1 });
    state.transactions.set(tx.txId, tx);
    expect(canCommit(state, tx)).toEqual({ allowed: true });
  });

  it("blocks action commit when sibling is still in-flight", () => {
    const tx1 = makeTx({
      txId: "tx-1",
      kind: "action",
      isolation: "concurrent",
      phase: "fetching",
      navEpochAtStart: 1,
    });
    const tx2 = makeTx({
      txId: "tx-2",
      kind: "action",
      isolation: "concurrent",
      phase: "received",
      navEpochAtStart: 1,
    });
    const transactions = new Map<string, Transaction>();
    transactions.set("tx-1", tx1);
    transactions.set("tx-2", tx2);
    const state = makeState({ navEpoch: 1, transactions });

    const result = canCommit(state, tx2);
    expect(result).toEqual({ allowed: false, reason: "CONCURRENT_PENDING", action: "ignore" });
  });

  it("allows action commit when all siblings are terminal", () => {
    const tx1 = makeTx({
      txId: "tx-1",
      kind: "action",
      isolation: "concurrent",
      phase: "committed",
      navEpochAtStart: 1,
    });
    const tx2 = makeTx({
      txId: "tx-2",
      kind: "action",
      isolation: "concurrent",
      phase: "received",
      navEpochAtStart: 1,
    });
    const transactions = new Map<string, Transaction>();
    transactions.set("tx-1", tx1);
    transactions.set("tx-2", tx2);
    const state = makeState({ navEpoch: 1, transactions });

    expect(canCommit(state, tx2)).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// derivePhase
// ---------------------------------------------------------------------------

describe("derivePhase", () => {
  it("returns idle when no transactions", () => {
    expect(derivePhase(new Map())).toBe("idle");
  });

  it("returns idle when all transactions are terminal", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ phase: "committed" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "aborted" }));
    expect(derivePhase(txs)).toBe("idle");
  });

  it("returns loading when a tx is in fetching phase", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ phase: "fetching" }));
    expect(derivePhase(txs)).toBe("loading");
  });

  it("returns loading when a tx is in created phase", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ phase: "created" }));
    expect(derivePhase(txs)).toBe("loading");
  });

  it("returns streaming when tx has active stream", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ phase: "streaming", hasActiveStream: true }));
    expect(derivePhase(txs)).toBe("streaming");
  });

  it("streaming takes priority over loading", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", phase: "fetching" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "streaming", hasActiveStream: true }));
    expect(derivePhase(txs)).toBe("streaming");
  });

  it("background transactions do not affect phase", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ isolation: "background", phase: "fetching" }));
    expect(derivePhase(txs)).toBe("idle");
  });

  it("returns loading for received phase", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ phase: "received" }));
    expect(derivePhase(txs)).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// derivePendingUrl
// ---------------------------------------------------------------------------

describe("derivePendingUrl", () => {
  it("returns null when no transactions", () => {
    expect(derivePendingUrl(new Map())).toBeNull();
  });

  it("returns url for fetching nav transaction", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ kind: "nav", phase: "fetching", url: "/target" }));
    expect(derivePendingUrl(txs)).toBe("/target");
  });

  it("returns url for created nav transaction", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ kind: "nav", phase: "created", url: "/target" }));
    expect(derivePendingUrl(txs)).toBe("/target");
  });

  it("returns null for streaming nav transaction", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ kind: "nav", phase: "streaming", url: "/target" }));
    expect(derivePendingUrl(txs)).toBeNull();
  });

  it("returns null when nav tx has skipLoadingState", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "nav",
        phase: "fetching",
        url: "/target",
        navOptions: { skipLoadingState: true },
      })
    );
    expect(derivePendingUrl(txs)).toBeNull();
  });

  it("returns null for action transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ kind: "action", phase: "fetching", url: "/action" }));
    expect(derivePendingUrl(txs)).toBeNull();
  });

  it("returns null for terminal nav transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ kind: "nav", phase: "committed", url: "/done" }));
    expect(derivePendingUrl(txs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transaction queries
// ---------------------------------------------------------------------------

describe("getActiveNavTx", () => {
  it("returns undefined when no transactions", () => {
    expect(getActiveNavTx(new Map())).toBeUndefined();
  });

  it("returns active nav transaction", () => {
    const txs = new Map<string, Transaction>();
    const tx = makeTx({ kind: "nav", phase: "fetching" });
    txs.set(tx.txId, tx);
    expect(getActiveNavTx(txs)).toBe(tx);
  });

  it("skips terminal nav transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "nav", phase: "committed" }));
    expect(getActiveNavTx(txs)).toBeUndefined();
  });

  it("skips non-nav transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "action", phase: "fetching" }));
    expect(getActiveNavTx(txs)).toBeUndefined();
  });
});

describe("getInflightActionTxIds", () => {
  it("returns empty for no transactions", () => {
    expect(getInflightActionTxIds(new Map())).toEqual([]);
  });

  it("returns inflight action tx ids", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "action", phase: "fetching" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", kind: "action", phase: "committed" }));
    txs.set("tx-3", makeTx({ txId: "tx-3", kind: "nav", phase: "fetching" }));
    txs.set("tx-4", makeTx({ txId: "tx-4", kind: "action", phase: "streaming" }));
    expect(getInflightActionTxIds(txs)).toEqual(["tx-1", "tx-4"]);
  });
});

describe("findActionTxSiblings", () => {
  it("returns other action transactions excluding self", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "action" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", kind: "action" }));
    txs.set("tx-3", makeTx({ txId: "tx-3", kind: "nav" }));
    const siblings = findActionTxSiblings(txs, "tx-1");
    expect(siblings).toHaveLength(1);
    expect(siblings[0].txId).toBe("tx-2");
  });
});

describe("getReceivedActionTxs", () => {
  it("returns action transactions in received phase", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "action", phase: "received" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", kind: "action", phase: "fetching" }));
    txs.set("tx-3", makeTx({ txId: "tx-3", kind: "action", phase: "received" }));
    const result = getReceivedActionTxs(txs);
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.txId)).toEqual(["tx-1", "tx-3"]);
  });
});

// ---------------------------------------------------------------------------
// applyIsolation
// ---------------------------------------------------------------------------

describe("applyIsolation", () => {
  it("returns empty array for non-exclusive tx", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "action", phase: "fetching" }));
    const newTx = makeTx({ txId: "tx-2", kind: "action", isolation: "concurrent" });
    expect(applyIsolation(txs, newTx)).toEqual([]);
  });

  it("aborts same-kind inflight tx for exclusive isolation", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "nav", phase: "fetching" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", kind: "action", phase: "fetching" }));
    const newTx = makeTx({ txId: "tx-3", kind: "nav", isolation: "exclusive" });
    txs.set("tx-3", newTx);
    const toAbort = applyIsolation(txs, newTx);
    expect(toAbort).toEqual(["tx-1"]); // only same kind (nav)
  });

  it("does not abort terminal transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "nav", phase: "committed" }));
    const newTx = makeTx({ txId: "tx-2", kind: "nav", isolation: "exclusive" });
    txs.set("tx-2", newTx);
    expect(applyIsolation(txs, newTx)).toEqual([]);
  });

  it("does not abort itself", () => {
    const txs = new Map<string, Transaction>();
    const newTx = makeTx({ txId: "tx-1", kind: "nav", isolation: "exclusive", phase: "created" });
    txs.set("tx-1", newTx);
    expect(applyIsolation(txs, newTx)).toEqual([]);
  });

  it("returns empty for background isolation", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", kind: "revalidate", phase: "fetching" }));
    const newTx = makeTx({ txId: "tx-2", kind: "revalidate", isolation: "background" });
    expect(applyIsolation(txs, newTx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// abortTransaction / failTransaction
// ---------------------------------------------------------------------------

describe("abortTransaction", () => {
  it("transitions to aborted and clears stream", () => {
    const tx = makeTx({ phase: "fetching", hasActiveStream: true });
    const result = abortTransaction(tx);
    expect(result.phase).toBe("aborted");
    expect(result.hasActiveStream).toBe(false);
    // Does not mutate original
    expect(tx.phase).toBe("fetching");
    expect(tx.hasActiveStream).toBe(true);
  });

  it("returns same tx if already terminal", () => {
    const tx = makeTx({ phase: "committed" });
    const result = abortTransaction(tx);
    expect(result).toBe(tx); // Same reference
  });
});

describe("failTransaction", () => {
  it("transitions to failed with error", () => {
    const error = new Error("network fail");
    const tx = makeTx({ phase: "streaming", hasActiveStream: true });
    const result = failTransaction(tx, error);
    expect(result.phase).toBe("failed");
    expect(result.hasActiveStream).toBe(false);
    expect(result.resultError).toBe(error);
  });

  it("returns same tx if already terminal", () => {
    const tx = makeTx({ phase: "aborted" });
    const result = failTransaction(tx, new Error("ignored"));
    expect(result).toBe(tx);
  });
});

// ---------------------------------------------------------------------------
// pruneTerminalTransactions
// ---------------------------------------------------------------------------

describe("pruneTerminalTransactions", () => {
  it("keeps non-terminal transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", phase: "fetching" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "created" }));
    const { pruned, nowTerminal } = pruneTerminalTransactions(txs, new Set());
    expect(pruned.size).toBe(2);
    expect(nowTerminal.size).toBe(0);
  });

  it("newly terminal transactions are kept for one cycle", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", phase: "committed" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "fetching" }));
    const { pruned, nowTerminal } = pruneTerminalTransactions(txs, new Set());
    expect(pruned.size).toBe(2); // tx-1 kept for one more cycle
    expect(nowTerminal.has("tx-1")).toBe(true);
    expect(nowTerminal.has("tx-2")).toBe(false);
  });

  it("previously terminal transactions are pruned", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", phase: "committed" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "fetching" }));
    const prevTerminal = new Set(["tx-1"]);
    const { pruned, nowTerminal } = pruneTerminalTransactions(txs, prevTerminal);
    expect(pruned.size).toBe(1);
    expect(pruned.has("tx-1")).toBe(false);
    expect(pruned.has("tx-2")).toBe(true);
    expect(nowTerminal.size).toBe(0);
  });

  it("handles mixed terminal states across cycles", () => {
    const txs = new Map<string, Transaction>();
    txs.set("tx-1", makeTx({ txId: "tx-1", phase: "committed" }));
    txs.set("tx-2", makeTx({ txId: "tx-2", phase: "aborted" }));
    txs.set("tx-3", makeTx({ txId: "tx-3", phase: "fetching" }));
    // tx-1 was terminal last cycle, tx-2 just became terminal
    const prevTerminal = new Set(["tx-1"]);
    const { pruned, nowTerminal } = pruneTerminalTransactions(txs, prevTerminal);
    expect(pruned.size).toBe(2); // tx-2 + tx-3
    expect(pruned.has("tx-1")).toBe(false); // pruned
    expect(pruned.has("tx-2")).toBe(true); // kept one more cycle
    expect(pruned.has("tx-3")).toBe(true); // active
    expect(nowTerminal).toEqual(new Set(["tx-2"]));
  });
});
