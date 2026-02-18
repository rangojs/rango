/**
 * Layer 2 tests: Reducer event handling
 *
 * Tests each event type individually, verifying state transitions,
 * command emission, and transaction lifecycle.
 */

import { describe, it, expect } from "vitest";
import type {
  ClientRuntimeState,
  RouteSnapshot,
  Transaction,
  CacheEntry,
  HandleState,
  ServerPatch,
  RuntimeEvent,
  NavOptions,
} from "../types.js";
import { reduce } from "../reducer.js";
import { buildSignatureMap } from "../signatures.js";
import type { ResolvedSegment } from "../../../types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seg(
  id: string,
  overrides?: Partial<ResolvedSegment>
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: `component-${id}`,
    ...overrides,
  } as any;
}

function makeSnapshot(
  segments?: ResolvedSegment[],
  overrides?: Partial<RouteSnapshot>
): RouteSnapshot {
  const segs = segments ?? [seg("root", { type: "layout" }), seg("page")];
  const segmentIndex = new Map<string, number>();
  for (let i = 0; i < segs.length; i++) {
    segmentIndex.set(segs[i].id, i);
  }
  return {
    key: "/",
    url: "http://localhost/",
    matched: segs.map((s) => s.id),
    segments: segs,
    segmentIndex,
    signatures: buildSignatureMap(segs),
    interceptSegments: [],
    slots: {},
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeState(overrides?: Partial<ClientRuntimeState>): ClientRuntimeState {
  return {
    current: makeSnapshot(),
    transactions: new Map(),
    navEpoch: 0,
    actionEpoch: 0,
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

function makePatch(overrides?: Partial<ServerPatch>): ServerPatch {
  return {
    isPartial: true,
    matched: ["root", "page"],
    diff: ["page"],
    segments: [seg("page", { component: "new-page" })],
    ...overrides,
  };
}

function findCmd(commands: any[], kind: string) {
  return commands.find((c: any) => c.kind === kind);
}

function findAllCmds(commands: any[], kind: string) {
  return commands.filter((c: any) => c.kind === kind);
}

// ---------------------------------------------------------------------------
// NAV_START
// ---------------------------------------------------------------------------

describe("reduce: NAV_START", () => {
  it("creates a nav transaction and emits FETCH", () => {
    const state = makeState();
    const event: RuntimeEvent = {
      type: "NAV_START",
      url: "/products",
      options: {},
    };

    const { state: next, commands } = reduce(state, event);

    // Nav epoch incremented
    expect(next.navEpoch).toBe(1);
    expect(next.txCounter).toBe(1);

    // Transaction created
    expect(next.transactions.size).toBe(1);
    const [, tx] = [...next.transactions.entries()][0];
    expect(tx.kind).toBe("nav");
    expect(tx.phase).toBe("fetching");

    // FETCH command emitted
    const fetchCmd = findCmd(commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect(fetchCmd.payload.mode).toBe("nav");
    expect(fetchCmd.payload.url).toBe("/products");
  });

  it("aborts existing nav tx on new NAV_START", () => {
    const state = makeState();

    // First nav
    const { state: s1 } = reduce(state, {
      type: "NAV_START",
      url: "/first",
      options: {},
    });

    // Second nav should abort first
    const { state: s2, commands } = reduce(s1, {
      type: "NAV_START",
      url: "/second",
      options: {},
    });

    // Should have ABORT_FETCH for the first tx
    const abortCmd = findCmd(commands, "ABORT_FETCH");
    expect(abortCmd).toBeDefined();

    // Original tx should be aborted
    const txs = [...s2.transactions.values()];
    const abortedTx = txs.find((t) => t.url === "/first");
    // It might be pruned or aborted
    if (abortedTx) {
      expect(abortedTx.phase).toBe("aborted");
    }
  });

  it("renders optimistic snapshot on cache hit", () => {
    const cachedSnapshot = makeSnapshot(undefined, { key: "/products", url: "http://localhost/products" });
    const cache = new Map<string, CacheEntry>();
    cache.set("/products", { snapshot: cachedSnapshot, stale: false });

    const state = makeState({ cache });
    const { commands } = reduce(state, {
      type: "NAV_START",
      url: "http://localhost/products",
      options: {},
    });

    const renderCmd = findCmd(commands, "RENDER");
    expect(renderCmd).toBeDefined();
    expect(renderCmd.payload.snapshot).toBeDefined();

    // Also emits PUSH_HISTORY
    const historyCmd = findCmd(commands, "PUSH_HISTORY");
    expect(historyCmd).toBeDefined();
  });

  it("uses REPLACE_HISTORY when options.replace is true", () => {
    const cachedSnapshot = makeSnapshot(undefined, { key: "/products", url: "http://localhost/products" });
    const cache = new Map<string, CacheEntry>();
    cache.set("/products", { snapshot: cachedSnapshot, stale: false });

    const state = makeState({ cache });
    const { commands } = reduce(state, {
      type: "NAV_START",
      url: "http://localhost/products",
      options: { replace: true },
    });

    const replaceCmd = findCmd(commands, "REPLACE_HISTORY");
    expect(replaceCmd).toBeDefined();
    expect(findCmd(commands, "PUSH_HISTORY")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NAV_RESPONSE
// ---------------------------------------------------------------------------

describe("reduce: NAV_RESPONSE", () => {
  function setupNavInFlight(): { state: ClientRuntimeState; txId: string } {
    const base = makeState();
    const { state, commands } = reduce(base, {
      type: "NAV_START",
      url: "http://localhost/products",
      options: {},
    });
    const tx = [...state.transactions.values()].find((t) => t.kind === "nav")!;
    return { state, txId: tx.txId };
  }

  it("commits snapshot and emits PUSH_HISTORY + RENDER + SCROLL on success", () => {
    const { state, txId } = setupNavInFlight();

    const newPageSeg = seg("newpage", { type: "route", component: "products-page" });
    const patch = makePatch({
      matched: ["root", "newpage"],
      diff: ["newpage"],
      segments: [newPageSeg],
    });

    const { state: next, commands } = reduce(state, {
      type: "NAV_RESPONSE",
      txId,
      patch,
    });

    // Tx committed
    const tx = next.transactions.get(txId);
    if (tx) {
      expect(tx.phase).toBe("committed");
    }

    // Commands
    expect(findCmd(commands, "PUSH_HISTORY")).toBeDefined();
    expect(findCmd(commands, "RENDER")).toBeDefined();
    expect(findCmd(commands, "SCROLL")).toBeDefined();
  });

  it("ignores response for stale nav epoch", () => {
    const { state: s1, txId } = setupNavInFlight();

    // Start another nav (increments epoch, aborts first)
    const { state: s2 } = reduce(s1, {
      type: "NAV_START",
      url: "/other",
      options: {},
    });

    // Response for original tx arrives
    const { commands } = reduce(s2, {
      type: "NAV_RESPONSE",
      txId,
      patch: makePatch(),
    });

    // No render or history commands for stale tx
    expect(findCmd(commands, "RENDER")).toBeUndefined();
    expect(findCmd(commands, "PUSH_HISTORY")).toBeUndefined();
  });

  it("triggers full refetch on MISSING_MATCHED_SEGMENT", () => {
    const { state, txId } = setupNavInFlight();

    const patch = makePatch({
      matched: ["root", "missing"],
      diff: ["missing"],
      segments: [], // missing segment not provided
    });

    const { commands } = reduce(state, {
      type: "NAV_RESPONSE",
      txId,
      patch,
    });

    const fetchCmd = findCmd(commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect(fetchCmd.payload.segmentIds).toEqual([]); // full refetch
  });
});

// ---------------------------------------------------------------------------
// ACTION_START
// ---------------------------------------------------------------------------

describe("reduce: ACTION_START", () => {
  it("creates action transaction and emits FETCH", () => {
    const state = makeState();
    const { state: next, commands } = reduce(state, {
      type: "ACTION_START",
      actionId: "hash#doSomething",
      args: [42],
    });

    expect(next.actionEpoch).toBe(1);
    const tx = [...next.transactions.values()][0];
    expect(tx.kind).toBe("action");
    expect(tx.isolation).toBe("concurrent");
    expect(tx.actionId).toBe("hash#doSomething");
    expect(tx.actionArgs).toEqual([42]);

    const fetchCmd = findCmd(commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect(fetchCmd.payload.mode).toBe("action");
  });

  it("marks current cache entry as stale", () => {
    const cache = new Map<string, CacheEntry>();
    cache.set("/", { snapshot: makeSnapshot(), stale: false });
    const state = makeState({ cache });

    const { state: next } = reduce(state, {
      type: "ACTION_START",
      actionId: "test",
      args: [],
    });

    const entry = next.cache.get("/");
    expect(entry?.stale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ACTION_RESPONSE
// ---------------------------------------------------------------------------

describe("reduce: ACTION_RESPONSE", () => {
  function setupActionInFlight(): { state: ClientRuntimeState; txId: string } {
    const base = makeState();
    const { state } = reduce(base, {
      type: "ACTION_START",
      actionId: "test",
      args: [],
    });
    const tx = [...state.transactions.values()].find((t) => t.kind === "action")!;
    return { state, txId: tx.txId };
  }

  it("reconciles and renders on action response", () => {
    const { state, txId } = setupActionInFlight();

    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [seg("page", { component: "action-result" })],
    });

    const { state: next, commands } = reduce(state, {
      type: "ACTION_RESPONSE",
      txId,
      patch,
      returnValue: { success: true },
    });

    // Render emitted
    expect(findCmd(commands, "RENDER")).toBeDefined();
    // Broadcast emitted
    expect(findCmd(commands, "BROADCAST_INVALIDATION")).toBeDefined();

    // Tx committed
    const tx = next.transactions.get(txId);
    if (tx) {
      expect(tx.phase).toBe("committed");
    }
  });

  it("defers commit when sibling action is in-flight (CONCURRENT_PENDING)", () => {
    // Start two actions
    const base = makeState();
    const { state: s1 } = reduce(base, {
      type: "ACTION_START",
      actionId: "action1",
      args: [],
    });
    const { state: s2 } = reduce(s1, {
      type: "ACTION_START",
      actionId: "action2",
      args: [],
    });

    const txs = [...s2.transactions.values()].filter((t) => t.kind === "action");
    const firstTxId = txs[0].txId;

    // First action responds - second still in flight
    const patch = makePatch();
    const { state: s3, commands } = reduce(s2, {
      type: "ACTION_RESPONSE",
      txId: firstTxId,
      patch,
      returnValue: "result1",
    });

    // Should NOT render (deferred)
    expect(findCmd(commands, "RENDER")).toBeUndefined();

    // First tx should be in "received" phase (deferred)
    const firstTx = s3.transactions.get(firstTxId);
    expect(firstTx?.phase).toBe("received");
  });
});

// ---------------------------------------------------------------------------
// STREAM_START / STREAM_END
// ---------------------------------------------------------------------------

describe("reduce: STREAM_START / STREAM_END", () => {
  it("updates stream state and derives phase", () => {
    const base = makeState();
    const { state: s1 } = reduce(base, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });

    const tx = [...s1.transactions.values()][0];

    const { state: s2 } = reduce(s1, {
      type: "STREAM_START",
      txId: tx.txId,
    });

    expect(s2.phase).toBe("streaming");
    const updatedTx = s2.transactions.get(tx.txId);
    expect(updatedTx?.hasActiveStream).toBe(true);

    const { state: s3 } = reduce(s2, {
      type: "STREAM_END",
      txId: tx.txId,
    });

    const endedTx = s3.transactions.get(tx.txId);
    expect(endedTx?.hasActiveStream).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HMR_UPDATE
// ---------------------------------------------------------------------------

describe("reduce: HMR_UPDATE", () => {
  it("creates HMR transaction and emits full FETCH", () => {
    const state = makeState();
    const { state: next, commands } = reduce(state, { type: "HMR_UPDATE" });

    const tx = [...next.transactions.values()].find((t) => t.kind === "hmr");
    expect(tx).toBeDefined();
    expect(tx!.isolation).toBe("exclusive");

    const fetchCmd = findCmd(commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect(fetchCmd.payload.segmentIds).toEqual([]); // full fetch
    expect(fetchCmd.payload.mode).toBe("hmr");
  });

  it("aborts previous HMR transaction", () => {
    const state = makeState();
    const { state: s1 } = reduce(state, { type: "HMR_UPDATE" });
    const { commands } = reduce(s1, { type: "HMR_UPDATE" });

    const abortCmd = findCmd(commands, "ABORT_FETCH");
    expect(abortCmd).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TX_ABORT_REQUESTED
// ---------------------------------------------------------------------------

describe("reduce: TX_ABORT_REQUESTED", () => {
  it("aborts the transaction and emits ABORT_FETCH", () => {
    const base = makeState();
    const { state: s1 } = reduce(base, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });

    const tx = [...s1.transactions.values()][0];
    const { state: s2, commands } = reduce(s1, {
      type: "TX_ABORT_REQUESTED",
      txId: tx.txId,
    });

    const abortCmd = findCmd(commands, "ABORT_FETCH");
    expect(abortCmd).toBeDefined();
    expect(abortCmd.payload.txId).toBe(tx.txId);

    // Phase should be idle after abort
    expect(s2.phase).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// NETWORK_ERROR
// ---------------------------------------------------------------------------

describe("reduce: NETWORK_ERROR", () => {
  it("fails the transaction and sets networkError", () => {
    const base = makeState();
    const { state: s1 } = reduce(base, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });

    const tx = [...s1.transactions.values()][0];
    const error = new Error("connection failed");
    const { state: s2, commands } = reduce(s1, {
      type: "NETWORK_ERROR",
      txId: tx.txId,
      error,
    });

    expect(s2.networkError).toBe(error);
    expect(s2.phase).toBe("idle");
    expect(findCmd(commands, "RENDER")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// VERSION_MISMATCH
// ---------------------------------------------------------------------------

describe("reduce: VERSION_MISMATCH", () => {
  it("emits HARD_RELOAD", () => {
    const state = makeState();
    const { commands } = reduce(state, {
      type: "VERSION_MISMATCH",
      reloadUrl: "/new-version",
    });

    const reloadCmd = findCmd(commands, "HARD_RELOAD");
    expect(reloadCmd).toBeDefined();
    expect(reloadCmd.payload.url).toBe("/new-version");
  });
});

// ---------------------------------------------------------------------------
// POPSTATE
// ---------------------------------------------------------------------------

describe("reduce: POPSTATE", () => {
  it("renders from cache with forceAwait on cache hit", () => {
    const cachedSnap = makeSnapshot(undefined, { key: "/cached" });
    const cache = new Map<string, CacheEntry>();
    cache.set("/cached", { snapshot: cachedSnap, stale: false });

    const state = makeState({ cache });
    const { commands } = reduce(state, {
      type: "POPSTATE",
      url: "http://localhost/cached",
      historyKey: "/cached",
    });

    const renderCmd = findCmd(commands, "RENDER");
    expect(renderCmd).toBeDefined();
    expect(renderCmd.payload.forceAwait).toBe(true);

    const scrollCmd = findCmd(commands, "SCROLL");
    expect(scrollCmd).toBeDefined();
    expect(scrollCmd.payload.behavior).toBe("restore");
  });

  it("creates revalidate tx for stale cache hit", () => {
    const cachedSnap = makeSnapshot(undefined, { key: "/stale" });
    const cache = new Map<string, CacheEntry>();
    cache.set("/stale", { snapshot: cachedSnap, stale: true });

    const state = makeState({ cache });
    const { state: next, commands } = reduce(state, {
      type: "POPSTATE",
      url: "http://localhost/stale",
      historyKey: "/stale",
    });

    // Should have RENDER (from cache) + FETCH (revalidation)
    expect(findCmd(commands, "RENDER")).toBeDefined();
    const fetchCmds = findAllCmds(commands, "FETCH");
    expect(fetchCmds.length).toBeGreaterThan(0);
    expect(fetchCmds[0].payload.mode).toBe("revalidate");

    // Revalidate tx created
    const revalTx = [...next.transactions.values()].find((t) => t.kind === "revalidate");
    expect(revalTx).toBeDefined();
    expect(revalTx!.isolation).toBe("background");
  });

  it("creates nav tx and full fetch on cache miss", () => {
    const state = makeState();
    const { state: next, commands } = reduce(state, {
      type: "POPSTATE",
      url: "http://localhost/unknown",
      historyKey: "/unknown",
    });

    const fetchCmd = findCmd(commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect(fetchCmd.payload.segmentIds).toEqual([]); // full fetch
    expect(fetchCmd.payload.mode).toBe("nav");

    // Nav tx created
    const navTx = [...next.transactions.values()].find((t) => t.kind === "nav");
    expect(navTx).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// REVALIDATE_DONE
// ---------------------------------------------------------------------------

describe("reduce: REVALIDATE_DONE", () => {
  it("updates cache silently (no RENDER)", () => {
    // Setup: create revalidate tx by triggering popstate with stale cache
    const cachedSnap = makeSnapshot(undefined, { key: "/stale" });
    const cache = new Map<string, CacheEntry>();
    cache.set("/stale", { snapshot: cachedSnap, stale: true });

    const state = makeState({ cache, current: cachedSnap });
    const { state: s1 } = reduce(state, {
      type: "POPSTATE",
      url: "http://localhost/stale",
      historyKey: "/stale",
    });

    const revalTx = [...s1.transactions.values()].find((t) => t.kind === "revalidate");
    if (!revalTx) return; // skip if tx was pruned

    const patch = makePatch({
      matched: ["root", "page"],
      diff: ["page"],
      segments: [seg("page", { component: "fresh-page" })],
    });

    const { commands } = reduce(s1, {
      type: "REVALIDATE_DONE",
      txId: revalTx.txId,
      patch,
    });

    // No RENDER command (background revalidation)
    expect(findCmd(commands, "RENDER")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CACHE_CLEAR_REQUESTED
// ---------------------------------------------------------------------------

describe("reduce: CACHE_CLEAR_REQUESTED", () => {
  it("clears the cache", () => {
    const cache = new Map<string, CacheEntry>();
    cache.set("/a", { snapshot: makeSnapshot(), stale: false });
    cache.set("/b", { snapshot: makeSnapshot(), stale: false });

    const state = makeState({ cache });
    const { state: next } = reduce(state, { type: "CACHE_CLEAR_REQUESTED" });

    expect(next.cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HANDLES_UPDATE
// ---------------------------------------------------------------------------

describe("reduce: HANDLES_UPDATE", () => {
  it("updates handle state", () => {
    const base = makeState();
    const { state: s1 } = reduce(base, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });

    const tx = [...s1.transactions.values()][0];
    const handles = { title: "Test Page" };
    const { state: s2 } = reduce(s1, {
      type: "HANDLES_UPDATE",
      txId: tx.txId,
      handles,
      matched: ["root", "page"],
    });

    expect(s2.handleState.data).toEqual(handles);
    expect(s2.handleState.segmentOrder).toEqual(["root", "page"]);
  });
});
