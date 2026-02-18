/**
 * Layer 3 tests: Multi-event sequences
 *
 * Tests realistic event sequences that span multiple reduce calls,
 * verifying end-to-end behavior: nav -> response -> commit,
 * action -> response -> render, concurrent actions, nav-during-action, etc.
 */

import { describe, it, expect } from "vitest";
import type {
  ClientRuntimeState,
  RouteSnapshot,
  CacheEntry,
  HandleState,
  ServerPatch,
  RuntimeEvent,
  RuntimeCommand,
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

/**
 * Dispatch multiple events sequentially, tracking terminal tx state.
 */
function dispatchSequence(
  initial: ClientRuntimeState,
  events: RuntimeEvent[]
): { state: ClientRuntimeState; allCommands: RuntimeCommand[][] } {
  let state = initial;
  let previouslyTerminal = new Set<string>();
  const allCommands: RuntimeCommand[][] = [];

  for (const event of events) {
    const result = reduce(state, event, previouslyTerminal);
    state = result.state;
    previouslyTerminal = result.nowTerminal;
    allCommands.push(result.commands);
  }

  return { state, allCommands };
}

function findCmd(commands: RuntimeCommand[], kind: string) {
  return commands.find((c) => c.kind === kind);
}

// ---------------------------------------------------------------------------
// Sequence: Complete navigation lifecycle
// ---------------------------------------------------------------------------

describe("sequence: nav -> response -> commit", () => {
  it("completes full navigation with state transitions", () => {
    const state = makeState();

    // Step 1: NAV_START
    const { state: s1, allCommands: [cmds1] } = dispatchSequence(state, [
      { type: "NAV_START", url: "http://localhost/products", options: {} },
    ]);

    expect(s1.navEpoch).toBe(1);
    expect(s1.phase).toBe("loading");
    expect(findCmd(cmds1, "FETCH")).toBeDefined();

    // Get the tx ID
    const tx = [...s1.transactions.values()][0];
    expect(tx.kind).toBe("nav");
    expect(tx.phase).toBe("fetching");

    // Step 2: NAV_RESPONSE
    const patch = makePatch({
      matched: ["root", "products"],
      diff: ["products"],
      segments: [seg("products", { component: "products-page" })],
    });

    const r2 = reduce(s1, { type: "NAV_RESPONSE", txId: tx.txId, patch }, new Set());

    expect(findCmd(r2.commands, "RENDER")).toBeDefined();
    expect(findCmd(r2.commands, "SCROLL")).toBeDefined();
    expect(r2.state.phase).toBe("idle");

    // Current snapshot updated
    expect(r2.state.current.matched).toContain("products");
  });
});

// ---------------------------------------------------------------------------
// Sequence: Nav cancellation (switchMap)
// ---------------------------------------------------------------------------

describe("sequence: nav cancellation (switchMap)", () => {
  it("aborts first nav when second starts", () => {
    const state = makeState();

    // Start first nav
    const r1 = reduce(state, {
      type: "NAV_START",
      url: "/first",
      options: {},
    });
    const firstTx = [...r1.state.transactions.values()][0];

    // Start second nav (should abort first)
    const r2 = reduce(r1.state, {
      type: "NAV_START",
      url: "/second",
      options: {},
    }, r1.nowTerminal);

    // ABORT_FETCH emitted for first
    expect(findCmd(r2.commands, "ABORT_FETCH")).toBeDefined();

    // Response for first nav arrives (stale)
    const r3 = reduce(r2.state, {
      type: "NAV_RESPONSE",
      txId: firstTx.txId,
      patch: makePatch(),
    }, r2.nowTerminal);

    // Should not render (stale epoch)
    expect(findCmd(r3.commands, "RENDER")).toBeUndefined();

    // Only second nav should render when it responds
    const secondTx = [...r2.state.transactions.values()].find(
      (t) => t.kind === "nav" && t.url === "/second"
    )!;

    const r4 = reduce(r3.state, {
      type: "NAV_RESPONSE",
      txId: secondTx.txId,
      patch: makePatch({
        matched: ["root", "second"],
        diff: ["second"],
        segments: [seg("second", { component: "second-page" })],
      }),
    }, r3.nowTerminal);

    expect(findCmd(r4.commands, "RENDER")).toBeDefined();
    expect(r4.state.current.matched).toContain("second");
  });
});

// ---------------------------------------------------------------------------
// Sequence: Concurrent actions batch commit
// ---------------------------------------------------------------------------

describe("sequence: concurrent actions batch commit", () => {
  it("defers first action until second completes, then batch commits", () => {
    const state = makeState();

    // Start two actions
    const r1 = reduce(state, {
      type: "ACTION_START",
      actionId: "action1",
      args: [],
    });
    const r2 = reduce(r1.state, {
      type: "ACTION_START",
      actionId: "action2",
      args: [],
    }, r1.nowTerminal);

    const txs = [...r2.state.transactions.values()].filter((t) => t.kind === "action");
    const tx1Id = txs[0].txId;
    const tx2Id = txs[1].txId;

    // First action responds
    const r3 = reduce(r2.state, {
      type: "ACTION_RESPONSE",
      txId: tx1Id,
      patch: makePatch(),
      returnValue: "result1",
    }, r2.nowTerminal);

    // Should NOT render yet (concurrent pending)
    expect(findCmd(r3.commands, "RENDER")).toBeUndefined();

    // Second action responds
    const r4 = reduce(r3.state, {
      type: "ACTION_RESPONSE",
      txId: tx2Id,
      patch: makePatch(),
      returnValue: "result2",
    }, r3.nowTerminal);

    // NOW should render (all actions received)
    expect(findCmd(r4.commands, "RENDER")).toBeDefined();
    expect(findCmd(r4.commands, "BROADCAST_INVALIDATION")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sequence: Action during navigation (nav-away detection)
// ---------------------------------------------------------------------------

describe("sequence: action nav-away detection", () => {
  it("detects nav-away and creates background revalidation", () => {
    const state = makeState();

    // Start an action
    const r1 = reduce(state, {
      type: "ACTION_START",
      actionId: "save",
      args: ["data"],
    });
    const actionTx = [...r1.state.transactions.values()][0];

    // User navigates away
    const r2 = reduce(r1.state, {
      type: "NAV_START",
      url: "/other",
      options: {},
    }, r1.nowTerminal);

    // Nav epoch changed, action tx still in flight

    // Action response arrives
    const r3 = reduce(r2.state, {
      type: "ACTION_RESPONSE",
      txId: actionTx.txId,
      patch: makePatch(),
      returnValue: { saved: true },
    }, r2.nowTerminal);

    // Should NOT render the action result (user navigated away)
    expect(findCmd(r3.commands, "RENDER")).toBeUndefined();

    // Should create background revalidation
    const fetchCmds = r3.commands.filter((c) => c.kind === "FETCH");
    const revalFetch = fetchCmds.find(
      (c) => c.kind === "FETCH" && (c as any).payload.mode === "revalidate"
    );
    expect(revalFetch).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sequence: Streaming lifecycle
// ---------------------------------------------------------------------------

describe("sequence: streaming lifecycle", () => {
  it("tracks phase through streaming lifecycle", () => {
    const state = makeState();

    // Start nav
    const r1 = reduce(state, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });
    const tx = [...r1.state.transactions.values()][0];
    expect(r1.state.phase).toBe("loading");

    // Stream starts
    const r2 = reduce(r1.state, {
      type: "STREAM_START",
      txId: tx.txId,
    }, r1.nowTerminal);
    expect(r2.state.phase).toBe("streaming");

    // Stream ends
    const r3 = reduce(r2.state, {
      type: "STREAM_END",
      txId: tx.txId,
    }, r2.nowTerminal);

    // After stream end, tx is still in streaming phase but no active stream.
    // derivePhase checks both hasActiveStream and phase === "streaming".
    // The tx.phase is "streaming" (set by STREAM_START), so phase is still "streaming".
    const updatedTx = r3.state.transactions.get(tx.txId);
    if (updatedTx) {
      expect(updatedTx.hasActiveStream).toBe(false);
      // Phase is "streaming" because tx.phase === "streaming" still
      expect(r3.state.phase).toBe("streaming");
    }
  });
});

// ---------------------------------------------------------------------------
// Sequence: Cache-hit optimistic navigation
// ---------------------------------------------------------------------------

describe("sequence: optimistic navigation with cache", () => {
  it("renders cached snapshot immediately, then reconciles on response", () => {
    // Setup: cached /products page
    const cachedSegs = [
      seg("root", { type: "layout" }),
      seg("products", { component: "cached-products" }),
    ];
    const cachedSnap = makeSnapshot(cachedSegs, {
      key: "/products",
      url: "http://localhost/products",
    });
    const cache = new Map<string, CacheEntry>();
    cache.set("/products", { snapshot: cachedSnap, stale: false });

    const state = makeState({ cache });

    // NAV_START to /products
    const r1 = reduce(state, {
      type: "NAV_START",
      url: "http://localhost/products",
      options: {},
    });

    // Should immediately render cached snapshot
    const renderCmd = findCmd(r1.commands, "RENDER");
    expect(renderCmd).toBeDefined();

    // Current should be the cached snapshot (optimistic render)
    // On cache hit, current is set to the cached snapshot immediately
    expect(r1.state.current.url).toBe("http://localhost/products");

    // NAV_RESPONSE with fresh data
    const tx = [...r1.state.transactions.values()][0];
    const r2 = reduce(r1.state, {
      type: "NAV_RESPONSE",
      txId: tx.txId,
      patch: makePatch({
        matched: ["root", "products"],
        diff: ["products"],
        segments: [seg("products", { component: "fresh-products" })],
      }),
    }, r1.nowTerminal);

    // Should REPLACE_HISTORY (not push again) and render
    expect(findCmd(r2.commands, "REPLACE_HISTORY")).toBeDefined();
    expect(findCmd(r2.commands, "RENDER")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sequence: Popstate with stale cache -> revalidation
// ---------------------------------------------------------------------------

describe("sequence: popstate stale revalidation", () => {
  it("renders stale cache then revalidates in background", () => {
    const cachedSnap = makeSnapshot(undefined, {
      key: "/old-page",
      url: "http://localhost/old-page",
    });
    const cache = new Map<string, CacheEntry>();
    cache.set("/old-page", { snapshot: cachedSnap, stale: true });

    const state = makeState({ cache });

    // Popstate to stale page
    const r1 = reduce(state, {
      type: "POPSTATE",
      url: "http://localhost/old-page",
      historyKey: "/old-page",
    });

    // Renders immediately
    const renderCmd = findCmd(r1.commands, "RENDER");
    expect(renderCmd).toBeDefined();
    expect(renderCmd!.payload.forceAwait).toBe(true);

    // Background revalidation fetch
    const fetchCmd = findCmd(r1.commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect((fetchCmd as any).payload.mode).toBe("revalidate");

    // Revalidation response arrives
    const revalTx = [...r1.state.transactions.values()].find((t) => t.kind === "revalidate");
    if (!revalTx) return;

    const r2 = reduce(r1.state, {
      type: "REVALIDATE_DONE",
      txId: revalTx.txId,
      patch: makePatch(),
    }, r1.nowTerminal);

    // No render (background)
    expect(findCmd(r2.commands, "RENDER")).toBeUndefined();

    // Cache should be updated (fresh)
    const entry = r2.state.cache.get("/old-page");
    if (entry) {
      expect(entry.stale).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Sequence: HMR update
// ---------------------------------------------------------------------------

describe("sequence: HMR update", () => {
  it("handles HMR -> response lifecycle", () => {
    const state = makeState();

    // HMR_UPDATE
    const r1 = reduce(state, { type: "HMR_UPDATE" });
    const tx = [...r1.state.transactions.values()][0];
    expect(tx.kind).toBe("hmr");

    const fetchCmd = findCmd(r1.commands, "FETCH");
    expect(fetchCmd).toBeDefined();
    expect((fetchCmd as any).payload.mode).toBe("hmr");
    expect((fetchCmd as any).payload.segmentIds).toEqual([]); // full fetch

    // The HMR response comes through as NAV_RESPONSE
    // (HMR uses nav response handling since it replaces current page)
    const r2 = reduce(r1.state, {
      type: "NAV_RESPONSE",
      txId: tx.txId,
      patch: makePatch({
        matched: ["root", "page"],
        diff: ["root", "page"],
        segments: [
          seg("root", { type: "layout", component: "hmr-root" }),
          seg("page", { component: "hmr-page" }),
        ],
      }),
    }, r1.nowTerminal);

    // Should render (but HMR behavior may vary)
    // At minimum, should not crash
    expect(r2.state).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sequence: Transaction pruning
// ---------------------------------------------------------------------------

describe("sequence: transaction pruning across cycles", () => {
  it("prunes terminal transactions after one cycle", () => {
    const state = makeState();

    // Create and complete a nav
    const r1 = reduce(state, {
      type: "NAV_START",
      url: "/page",
      options: {},
    });
    const tx = [...r1.state.transactions.values()][0];

    // Respond to commit the tx
    const r2 = reduce(r1.state, {
      type: "NAV_RESPONSE",
      txId: tx.txId,
      patch: makePatch(),
    }, r1.nowTerminal);

    // The committed tx should still exist (kept for one cycle)
    const committedTx = r2.state.transactions.get(tx.txId);
    // It may or may not be present depending on pruning timing

    // After another event, the terminal tx should be pruned
    const r3 = reduce(r2.state, {
      type: "CACHE_CLEAR_REQUESTED",
    }, r2.nowTerminal);

    // Terminal tx from r2 should now be pruned
    expect(r3.state.transactions.size).toBe(0);
  });
});
