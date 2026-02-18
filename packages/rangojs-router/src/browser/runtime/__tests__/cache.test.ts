/**
 * Cache and derive tests
 *
 * Tests cache operations (cacheKey, write/read/stale, LRU eviction,
 * shared-segment freshness) and derive functions (deriveActionState,
 * deriveNavigationState).
 */

import { describe, it, expect } from "vitest";
import type {
  RouteSnapshot,
  CacheEntry,
  Transaction,
  ClientRuntimeState,
  HandleState,
} from "../types.js";
import {
  cacheKey,
  cacheGet,
  cacheWrite,
  cacheMarkStale,
  mergeSharedSegmentFreshness,
  cacheClear,
} from "../cache.js";
import {
  deriveActionState,
  deriveNavigationState,
} from "../derive.js";

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
    url: "http://localhost/",
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
// cacheKey
// ---------------------------------------------------------------------------

describe("cacheKey", () => {
  it("derives key from pathname + search", () => {
    expect(cacheKey("http://localhost/products?page=2")).toBe("/products?page=2");
  });

  it("excludes hash", () => {
    expect(cacheKey("http://localhost/page#section")).toBe("/page");
  });

  it("appends :intercept suffix for intercept routes", () => {
    expect(cacheKey("http://localhost/modal", "/source")).toBe("/modal:intercept");
  });

  it("handles relative URLs gracefully", () => {
    const result = cacheKey("/about");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles null interceptSourceUrl", () => {
    expect(cacheKey("http://localhost/page", null)).toBe("/page");
  });
});

// ---------------------------------------------------------------------------
// Cache read/write
// ---------------------------------------------------------------------------

describe("cache read/write", () => {
  it("writes and reads a cache entry", () => {
    const cache = new Map<string, CacheEntry>();
    const snap = makeSnapshot({ key: "/page" });

    const next = cacheWrite(cache, "/page", snap, false, 20, "/");
    const entry = cacheGet(next, "/page");

    expect(entry).toBeDefined();
    expect(entry!.snapshot.key).toBe("/page");
    expect(entry!.stale).toBe(false);
  });

  it("does not mutate original cache", () => {
    const cache = new Map<string, CacheEntry>();
    cacheWrite(cache, "/page", makeSnapshot(), false, 20, "/");
    expect(cache.size).toBe(0);
  });

  it("returns undefined for missing key", () => {
    expect(cacheGet(new Map(), "/missing")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe("LRU eviction", () => {
  it("evicts oldest entry when over max size", () => {
    let cache = new Map<string, CacheEntry>();
    const current = "/current";

    cache = cacheWrite(cache, "/a", makeSnapshot(), false, 3, current);
    cache = cacheWrite(cache, "/b", makeSnapshot(), false, 3, current);
    cache = cacheWrite(cache, "/c", makeSnapshot(), false, 3, current);

    expect(cache.size).toBe(3);

    // Writing a 4th entry should evict /a (oldest)
    cache = cacheWrite(cache, "/d", makeSnapshot(), false, 3, current);
    expect(cache.size).toBe(3);
    expect(cache.has("/a")).toBe(false);
    expect(cache.has("/d")).toBe(true);
  });

  it("never evicts the current key", () => {
    let cache = new Map<string, CacheEntry>();
    const current = "/a"; // protect /a

    cache = cacheWrite(cache, "/a", makeSnapshot(), false, 2, current);
    cache = cacheWrite(cache, "/b", makeSnapshot(), false, 2, current);

    // Writing /c should evict /b, not /a (current)
    cache = cacheWrite(cache, "/c", makeSnapshot(), false, 2, current);
    expect(cache.has("/a")).toBe(true);
    expect(cache.has("/b")).toBe(false);
    expect(cache.has("/c")).toBe(true);
  });

  it("refreshes entry on re-write (LRU reset)", () => {
    let cache = new Map<string, CacheEntry>();
    const current = "/current";

    cache = cacheWrite(cache, "/a", makeSnapshot(), false, 3, current);
    cache = cacheWrite(cache, "/b", makeSnapshot(), false, 3, current);
    cache = cacheWrite(cache, "/c", makeSnapshot(), false, 3, current);

    // Re-write /a to make it most recent
    cache = cacheWrite(cache, "/a", makeSnapshot(), false, 3, current);

    // Now /b is oldest, should be evicted
    cache = cacheWrite(cache, "/d", makeSnapshot(), false, 3, current);
    expect(cache.has("/a")).toBe(true);
    expect(cache.has("/b")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cache stale marking
// ---------------------------------------------------------------------------

describe("cacheMarkStale", () => {
  it("marks an existing entry as stale", () => {
    let cache = new Map<string, CacheEntry>();
    cache = cacheWrite(cache, "/page", makeSnapshot(), false, 20, "/");

    const staled = cacheMarkStale(cache, "/page");
    expect(staled.get("/page")!.stale).toBe(true);
  });

  it("returns same cache if entry already stale", () => {
    let cache = new Map<string, CacheEntry>();
    cache = cacheWrite(cache, "/page", makeSnapshot(), true, 20, "/");

    const result = cacheMarkStale(cache, "/page");
    expect(result).toBe(cache); // Same reference
  });

  it("returns same cache if entry not found", () => {
    const cache = new Map<string, CacheEntry>();
    const result = cacheMarkStale(cache, "/missing");
    expect(result).toBe(cache);
  });
});

// ---------------------------------------------------------------------------
// Shared-segment freshness
// ---------------------------------------------------------------------------

describe("mergeSharedSegmentFreshness", () => {
  it("updates shared segments from current snapshot", () => {
    const sharedSeg = {
      id: "shared",
      namespace: "",
      index: 0,
      type: "layout" as const,
      component: "cached-component",
      loading: "spinner" as any,
    } as any;

    const cachedSnap = makeSnapshot({
      segments: [sharedSeg],
      segmentIndex: new Map([["shared", 0]]),
    });

    const freshSeg = {
      ...sharedSeg,
      component: "fresh-component",
      loading: "new-spinner" as any,
    };
    const currentSnap = makeSnapshot({
      segments: [freshSeg],
      segmentIndex: new Map([["shared", 0]]),
    });

    const merged = mergeSharedSegmentFreshness(cachedSnap, currentSnap);

    // Should use current segment data
    expect(merged.segments[0].component).toBe("fresh-component");
    // But preserve structural properties from cached
    expect(merged.segments[0].loading).toBe("spinner");
  });

  it("returns same snapshot when no shared segments", () => {
    const cached = makeSnapshot({
      segments: [{ id: "a" } as any],
      segmentIndex: new Map([["a", 0]]),
    });
    const current = makeSnapshot({
      segments: [{ id: "b" } as any],
      segmentIndex: new Map([["b", 0]]),
    });

    const result = mergeSharedSegmentFreshness(cached, current);
    expect(result).toBe(cached); // Same reference (no change)
  });
});

// ---------------------------------------------------------------------------
// Cache clear
// ---------------------------------------------------------------------------

describe("cacheClear", () => {
  it("returns an empty map", () => {
    const result = cacheClear();
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// deriveActionState
// ---------------------------------------------------------------------------

describe("deriveActionState", () => {
  it("returns idle when no matching transactions", () => {
    const txs = new Map<string, Transaction>();
    const result = deriveActionState(txs, "myAction");
    expect(result.state).toBe("idle");
    expect(result.actionId).toBeNull();
  });

  it("returns loading for fetching action", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "fetching",
        actionId: "hash#myAction",
        actionArgs: [42],
      })
    );

    const result = deriveActionState(txs, "hash#myAction");
    expect(result.state).toBe("loading");
    expect(result.actionId).toBe("hash#myAction");
    expect(result.payload).toEqual([42]);
  });

  it("matches suffix action IDs", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "fetching",
        actionId: "abc123#doSomething",
      })
    );

    // Query by name only
    const result = deriveActionState(txs, "doSomething");
    expect(result.state).toBe("loading");
  });

  it("returns streaming for streaming action", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "streaming",
        actionId: "action1",
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("streaming");
  });

  it("returns idle with result for committed action", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "committed",
        actionId: "action1",
        resultReturnValue: { success: true },
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("idle");
    expect(result.result).toEqual({ success: true });
  });

  it("returns idle with error for failed action", () => {
    const txs = new Map<string, Transaction>();
    const error = new Error("failed");
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "failed",
        actionId: "action1",
        resultError: error,
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("idle");
    expect(result.error).toBe(error);
  });

  it("returns idle for aborted action", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "aborted",
        actionId: "action1",
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("idle");
    expect(result.actionId).toBeNull();
  });

  it("uses most recent tx when multiple match", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        txId: "tx-1",
        kind: "action",
        phase: "committed",
        actionId: "action1",
        resultReturnValue: "old",
      })
    );
    txs.set(
      "tx-2",
      makeTx({
        txId: "tx-2",
        kind: "action",
        phase: "fetching",
        actionId: "action1",
      })
    );

    const result = deriveActionState(txs, "action1");
    // tx-2 is more recent (higher txId)
    expect(result.state).toBe("loading");
  });

  it("returns loading for received phase (batch commit pending)", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "action",
        phase: "received",
        actionId: "action1",
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("loading");
  });

  it("ignores non-action transactions", () => {
    const txs = new Map<string, Transaction>();
    txs.set(
      "tx-1",
      makeTx({
        kind: "nav",
        phase: "fetching",
        actionId: "action1", // even if it has actionId
      })
    );

    const result = deriveActionState(txs, "action1");
    expect(result.state).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// deriveNavigationState
// ---------------------------------------------------------------------------

describe("deriveNavigationState", () => {
  it("derives navigation state from runtime state", () => {
    const state = makeState({
      phase: "loading",
      pendingUrl: "/target",
      current: makeSnapshot({ url: "http://localhost/current" }),
      interceptSourceUrl: "/source",
      networkError: null,
    });

    const result = deriveNavigationState(state);
    expect(result.phase).toBe("loading");
    expect(result.pendingUrl).toBe("/target");
    expect(result.currentUrl).toBe("http://localhost/current");
    expect(result.interceptSourceUrl).toBe("/source");
    expect(result.networkError).toBeNull();
  });

  it("includes network error when present", () => {
    const error = new Error("connection failed");
    const state = makeState({ networkError: error });

    const result = deriveNavigationState(state);
    expect(result.networkError).toBe(error);
  });
});
