import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore, resetCFShellMemoForTests } from "../cf-cache-store";
import {
  ShellFrameReader,
  encodeShellFrame,
  shellFrameToText,
  type ShellFrameHead,
} from "../cf-shell-frame";
import type { ShellCacheEntry } from "../../types";
import {
  SHELL_ENTRY_HEAD_ALLOWANCE_BYTES,
  estimateShellEntryBytes,
} from "../../shell-snapshot";
import { TAG_HINTS_MAX_ENTRIES } from "../../isolate-tag-memo";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context";
import { createMetricsStore } from "../../../router/metrics";
import { revalidateTag, updateTag } from "../../tag-invalidation.js";

function makeReqCtx() {
  return createRequestContext({
    env: {},
    request: new Request("https://test.internal/"),
    url: new URL("https://test.internal/"),
    variables: {},
  });
}

// ============================================================================
// Mock Cache API (L1) + KV (L2)
// ============================================================================

function cacheKey(request: RequestInfo | URL): string {
  return request instanceof Request ? request.url : String(request);
}

class MockCache {
  store = new Map<string, Response>();

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.store.get(cacheKey(request))?.clone();
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.store.set(cacheKey(request), response.clone());
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.store.delete(cacheKey(request));
  }
}

class MockKV {
  store = new Map<string, { value: string; expirationTtl?: number }>();

  async get(key: string, options?: { type?: string }): Promise<any> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (options?.type === "json") return JSON.parse(entry.value);
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    this.store.set(key, { value, expirationTtl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** Split a stored shell frame (KV string or Cache API bytes) into its parts. */
async function readFrame(
  stored: string | Uint8Array,
): Promise<{ head: ShellFrameHead; prelude: Uint8Array; rest: Uint8Array }> {
  const reader = new ShellFrameReader(new Response(stored as BodyInit).body!);
  const head = (await reader.readHead())!;
  const prelude = (await reader.take(head.pl))!;
  return { head, prelude, rest: await reader.readRest() };
}

const frameText = (frame: Uint8Array): string => shellFrameToText(frame);

const createMockCtx = () => ({
  waitUntil: vi.fn((p: Promise<any>) => p),
  passThroughOnException: vi.fn(),
});

/** Await every waitUntil-scheduled write so a subsequent read observes it. */
async function drain(mockCtx: ReturnType<typeof createMockCtx>) {
  await Promise.all(mockCtx.waitUntil.mock.results.map((r) => r.value));
}

const REACT_VERSION = "19.2.6";

function shellEntry(overrides: Partial<ShellCacheEntry> = {}): ShellCacheEntry {
  return {
    prelude: btoa("<html><body>SHELL</body></html>"),
    postponed: JSON.stringify({ hole: 1 }),
    reactVersion: REACT_VERSION,
    buildVersion: "build-abc",
    createdAt: Date.now(),
    snapshot: [],
    ...overrides,
  };
}

describe("CFCacheStore shell family (Cache API L1 + KV L2)", () => {
  let mockCache: MockCache;
  let mockKV: MockKV;
  let mockCtx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetCFShellMemoForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    mockCache = new MockCache();
    mockKV = new MockKV();
    mockCtx = createMockCtx();
    vi.stubGlobal("caches", {
      default: mockCache,
      open: async () => mockCache,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("serves a shell entry from L1 without reading KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    await drain(mockCtx);
    expect(mockCache.store.size).toBe(1);
    mockKV.store.clear();

    const hit = await store.getShell("k");
    expect(hit).not.toBeNull();
    expect(hit?.entry).toEqual(entry);
    expect(hit?.shouldRevalidate).toBe(false);
  });

  it("promotes a KV fallback into L1 for the next read", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    await drain(mockCtx);

    mockCache.store.clear();
    expect((await store.getShell("k"))?.entry).toEqual(entry);
    await drain(mockCtx);

    mockKV.store.clear();
    expect((await store.getShell("k"))?.entry).toEqual(entry);
  });

  it("returns null on a miss", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    expect(await store.getShell("absent")).toBeNull();
  });

  // The KV envelope cherry-picks fields, so initialTheme (theme fidelity) and the
  // capture data snapshot (HIT parity) must be explicitly carried — otherwise the
  // feature silently no-ops on the real CFCacheStore that cloudflare-basic uses.
  it("round-trips initialTheme and the capture data snapshot through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const entry = shellEntry({
      initialTheme: "dark",
      snapshot: [
        {
          family: "loader",
          key: "M0L0D0.x",
          value: { value: "CAPVAL", holes: 0, runs: 0 },
        },
      ],
    });
    await store.putShell("k", entry, 300, 30);
    await drain(mockCtx);
    mockCache.store.clear();

    const hit = await store.getShell("k");
    expect(hit?.entry.initialTheme).toBe("dark");
    expect(hit?.entry.snapshot).toEqual(entry.snapshot);
    // buildVersion rides the envelope (bv) — dropping it in either direction
    // would make every persisted HIT fail the validity gate (infinite MISS).
    expect(hit?.entry.buildVersion).toBe("build-abc");
  });

  it("round-trips the replay fields (docKey, navigationOnly) through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell(
      "k",
      shellEntry({ docKey: "doc:host/p", navigationOnly: true }),
      300,
      30,
    );
    await drain(mockCtx);
    mockCache.store.clear();

    const entry = (await store.getShell("k"))?.entry;
    expect(entry?.docKey).toBe("doc:host/p");
    expect(entry?.navigationOnly).toBe(true);
  });

  it("round-trips a slim navigationOnly entry (no document half) through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const slim = shellEntry({
      navigationOnly: true,
      docKey: "doc:localhost/p",
    });
    delete slim.prelude;
    delete slim.postponed;
    await store.putShell("k", slim, 300, 30);
    await drain(mockCtx);
    mockCache.store.clear();

    const hit = await store.getShell("k");
    expect(hit?.entry.navigationOnly).toBe(true);
    expect(hit?.entry.docKey).toBe("doc:localhost/p");
    // The envelope validator accepts the absent document half only under `no`;
    // nothing re-materializes it on the way out.
    expect(hit?.entry.prelude).toBeUndefined();
    expect(hit?.entry.postponed).toBeUndefined();
  });

  it("still rejects a DOCUMENT frame missing its postponed state (loosening is navigationOnly-scoped)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 300, 30);
    await drain(mockCtx);
    mockCache.store.clear();
    // Strip the postponed field from the stored document frame's head.
    const [kvKey, stored] = [...mockKV.store].find(([key]) =>
      key.includes("shell2:k"),
    )!;
    const { head, prelude, rest } = await readFrame(stored.value);
    delete (head as { po?: unknown }).po;
    mockKV.store.set(kvKey, {
      ...stored,
      value: frameText(encodeShellFrame(head, prelude, rest)),
    });
    expect(await store.getShell("k")).toBeNull();
    consoleError.mockRestore();
  });

  // docKey names the canonical doc segment record navigation replay consumes;
  // dropping it in either direction reads back as "no consumable record" and
  // every partial navigation reports no-segment-snapshot after a KV round trip
  // (the memory store passes entries by reference, so only this envelope can
  // lose it — exactly how the storefront-shape replay silently died on KV).
  it("round-trips docKey through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell(
      "k",
      shellEntry({ docKey: "doc:localhost/p" }),
      300,
      30,
    );
    await drain(mockCtx);
    mockCache.store.clear();

    expect((await store.getShell("k"))?.entry.docKey).toBe("doc:localhost/p");
  });

  // The build-shell read-through's eviction gate (#699): a baked manifest
  // entry is immutable, so updateTag reaches it by comparing the SAME KV tag
  // markers invalidateTags writes against the entry's build-time createdAt.
  it("isTagsInvalidatedSince: marker at or after `since` wins; absent tags are false", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const t0 = Date.now();
    await store.invalidateTags(["home"]);
    await drain(mockCtx);
    expect(await store.isTagsInvalidatedSince(["home"], t0)).toBe(true);
    expect(await store.isTagsInvalidatedSince(["home"], t0 + 1)).toBe(false);
    expect(await store.isTagsInvalidatedSince(["absent"], t0)).toBe(false);
  });

  // ==========================================================================
  // Edge-only (KV-less) shells: L1 Cache API is a first-class shell tier.
  // Formerly the family no-oped without KV (permanent MISS + inert flag);
  // now a KV-less store captures and serves per-colo shells, with tag
  // eviction following the data families' purge-mode stance.
  // ==========================================================================

  it("edge-only: round-trips a shell through L1 alone, no KV, no warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: mockCtx }); // no kv
    // The scheduler skip-flag is gone: a KV-less CFCacheStore can always
    // store shells (Cache API is unconditionally available in workers), so
    // declaring the family inert would silently disable edge-only ppr.
    expect(
      (store as { shellFamilyInert?: boolean }).shellFamilyInert,
    ).toBeUndefined();

    const entry = shellEntry();
    expect(await store.putShell("k", entry, 300, 30)).toBe("stored");
    await drain(mockCtx);
    expect(mockCache.store.size).toBe(1);
    expect(mockKV.store.size).toBe(0);

    const hit = await store.getShell("k");
    expect(hit?.entry).toEqual(entry);
    expect(hit?.shouldRevalidate).toBe(false);
    // Untagged edge-only ppr is a fully supported config: nothing to warn.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("edge-only marker mode: a TAGGED shell caches but warns once that invalidation cannot reach it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const noEvictionWarnings = () =>
      warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("tag invalidation cannot evict it"),
      );
    // Unique namespace: the warn-once sets are module-level per namespace.
    const store = new CFCacheStore({
      ctx: mockCtx,
      namespace: "edge-warn",
    });

    await store.putShell("k", shellEntry(), 300, 30, ["products"]);
    await drain(mockCtx);
    // Still cached — ttl/swr freshness is the documented KV-less semantics.
    expect((await store.getShell("k"))?.entry).toBeDefined();
    expect(noEvictionWarnings()).toHaveLength(1);
    expect(noEvictionWarnings()[0][0]).toContain("tagPurge");

    // Once per isolate: a second per-request store instance must not re-warn.
    await new CFCacheStore({
      ctx: createMockCtx(),
      namespace: "edge-warn",
    }).putShell("k2", shellEntry(), 300, 30, ["products"]);
    expect(noEvictionWarnings()).toHaveLength(1);
  });

  it("edge-only purge mode: shell L1 entries carry the namespaced Cache-Tag tokens a purge evicts", async () => {
    const purged: string[][] = [];
    const store = new CFCacheStore({
      ctx: mockCtx,
      tagPurge: async (tags) => {
        purged.push(tags);
      },
    });
    await store.putShell("k", shellEntry(), 300, 30, ["products"]);
    await drain(mockCtx);

    const stored = [...mockCache.store.values()][0]!;
    const cacheTag = stored.headers.get("Cache-Tag");
    expect(cacheTag).toContain("rg:");
    expect(cacheTag).toContain("products");

    // invalidateTags fires the same purge call that evicts those tokens.
    await store.invalidateTags(["products"]);
    expect(purged).toHaveLength(1);
    expect(purged[0]!.some((t) => t.includes("products"))).toBe(true);
  });

  it("edge-only purge mode: read-your-own-writes — this request's updateTag masks the surviving L1 hit", async () => {
    // baseUrl pinned: putShell runs outside a request context and getShell
    // inside one; without the explicit override they would derive different
    // key hosts and the reads would be key-space misses, not memo rejections.
    const store = new CFCacheStore({
      ctx: mockCtx,
      baseUrl: "https://test.internal/",
      tagPurge: async () => {},
    });
    await store.putShell("k", shellEntry(), 300, 30, ["products"]);
    await drain(mockCtx);

    await runWithRequestContext(makeReqCtx(), async () => {
      await store.invalidateTags(["products"]);
      // The mock purge does not evict, so the entry SURVIVES in L1 — the
      // per-request memo is what must reject it within this request.
      expect(await store.getShell("k")).toBeNull();
    });

    // A fresh request has no memo; a hit that survived the purge is trusted
    // (the purge itself is the eviction mechanism — data-family semantics).
    await runWithRequestContext(makeReqCtx(), async () => {
      expect((await store.getShell("k"))?.entry).toBeDefined();
    });
  });

  it("edge-only purge mode: a capture write racing this request's updateTag is rejected", async () => {
    const store = new CFCacheStore({
      ctx: mockCtx,
      baseUrl: "https://test.internal/",
      tagPurge: async () => {},
    });
    await runWithRequestContext(makeReqCtx(), async () => {
      const captureStartedAt = Date.now();
      await store.invalidateTags(["products"]);
      expect(
        await store.putShell(
          "k",
          shellEntry({ createdAt: captureStartedAt }),
          300,
          30,
          ["products"],
        ),
      ).toBe("invalidated");
      // The scheduler's gate consults the same memo (KV-less purge mode).
      expect(
        await store.isTagsInvalidatedSince(["products"], captureStartedAt),
      ).toBe(true);
    });
    // Outside the invalidating request there is no signal (fail open,
    // cross-request races are bounded by ttl+swr like the data families).
    expect(await store.isTagsInvalidatedSince(["products"], Date.now())).toBe(
      false,
    );
  });

  it("edge-only purge mode: an over-limit tag set makes the shell uncacheable, not un-invalidatable", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manyTags = Array.from(
      { length: 100 },
      (_, i) => `t${i}-${"x".repeat(200)}`,
    );
    const store = new CFCacheStore({
      ctx: mockCtx,
      namespace: "edge-overflow",
      tagPurge: async () => {},
    });
    // ACKNOWLEDGED as uncacheable (not silent void): every retry would refuse
    // identically, so the capture scheduler must back the key off instead of
    // re-rendering a discarded capture on every MISS.
    expect(await store.putShell("k", shellEntry(), 300, 30, manyTags)).toBe(
      "uncacheable",
    );
    await drain(mockCtx);
    expect(mockCache.store.size).toBe(0);
    expect(await store.getShell("k")).toBeNull();
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(
      /NOT cached/,
    );
  });

  it("edge-only: declares tagHistoryInert so tagged BUILD shells decline (runtime shells unaffected)", async () => {
    // Without KV, isTagsInvalidatedSince answers carry no durable history —
    // the build-shell manifest gate reads this flag and declines tagged
    // immutable entries (nothing could ever evict them). KV-backed stores
    // stay durably answerable.
    expect(new CFCacheStore({ ctx: mockCtx }).tagHistoryInert).toBe(true);
    expect(
      new CFCacheStore({ ctx: mockCtx, kv: mockKV as any }).tagHistoryInert,
    ).toBeUndefined();
  });

  it("edge-only: tagInvalidationTtl does NOT cap L1 retention (no markers to outlive)", async () => {
    // With KV the cap keeps a tagged entry from outliving its markers; with
    // no KV there are no markers, and capping would hard-expire the shell
    // below its declared ttl+swr.
    const store = new CFCacheStore({
      ctx: mockCtx,
      namespace: "edge-retention",
      tagPurge: async () => {},
      tagInvalidationTtl: 60,
    });
    await store.putShell("k", shellEntry(), 300, 300, ["products"]);
    await drain(mockCtx);

    // Past the 60s tagInvalidationTtl, inside the 600s ttl+swr window: the
    // entry must still serve (stale after 300s, so revalidation flags at most).
    vi.setSystemTime(Date.now() + 70_000);
    expect((await store.getShell("k"))?.entry).toBeDefined();
    vi.setSystemTime(Date.now() + 540_000); // 610s total — past ttl+swr
    expect(await store.getShell("k")).toBeNull();
  });

  it("edge-only: tagInvalidationTtl is dead config without KV — no KV-floor validation warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Below KV's 60s expirationTtl floor: with KV this warns and floors (it
    // sizes MARKER expiry); without KV there are no markers and no retention
    // cap, so validating it would misdirect the consumer to a KV concern.
    const store = new CFCacheStore({
      ctx: mockCtx,
      namespace: "edge-dead-ttl",
      tagInvalidationTtl: 30,
    });
    expect(warnSpy).not.toHaveBeenCalled();

    // Contrast: the same value WITH KV keeps the floor warning.
    new CFCacheStore({
      ctx: mockCtx,
      namespace: "edge-dead-ttl-kv",
      kv: mockKV as any,
      tagInvalidationTtl: 30,
    });
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "expirationTtl floor",
    );
    void store;
  });

  it("writes a shell shorter than KV's 60s floor to KV at the floor; a KV read keeps the shell's own deadlines", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const T0 = Date.now();
    // A shell capped to a route cache() record with 59.7 s left.
    await store.putShell("k", shellEntry(), 29.7, 30);
    await drain(mockCtx);
    expect(mockCache.store.size).toBe(1);
    expect([...mockKV.store.values()].map((e) => e.expirationTtl)).toEqual([
      60,
    ]);

    // Each read below comes from KV: no L1 copy (a KV read promotes one)
    // and no isolate memo.
    const readFromKv = async () => {
      await drain(mockCtx);
      mockCache.store.clear();
      resetCFShellMemoForTests();
      return store.getShell("k");
    };
    vi.setSystemTime(new Date(T0 + 29_000));
    expect((await readFromKv())?.shouldRevalidate).toBe(false);
    vi.setSystemTime(new Date(T0 + 30_000));
    expect((await readFromKv())?.shouldRevalidate).toBe(true);
    vi.setSystemTime(new Date(T0 + 59_800));
    expect(await readFromKv()).toBeNull();
    // Still in KV: its floor outlives the deadline the read refused.
    expect(mockKV.store.size).toBe(1);
  });

  it("a fractional ttl keeps exact deadlines and writes whole KV seconds", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const T0 = Date.now();
    await store.putShell("k", shellEntry(), 60.5, 0);
    await drain(mockCtx);
    expect([...mockKV.store.values()][0]?.expirationTtl).toBe(61);

    vi.setSystemTime(new Date(T0 + 60_400));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(false);
    vi.setSystemTime(new Date(T0 + 60_600));
    expect(await store.getShell("k")).toBeNull();
  });

  it("SWR: fresh before staleAt, shouldRevalidate within the window, gone after expiry", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const T0 = Date.now();
    await store.putShell("k", shellEntry(), 60, 300); // stale +60s, expire +360s
    await drain(mockCtx);

    vi.setSystemTime(new Date(T0 + 30_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(false);

    vi.setSystemTime(new Date(T0 + 120_000));
    expect((await store.getShell("k"))?.shouldRevalidate).toBe(true);

    vi.setSystemTime(new Date(T0 + 400_000));
    expect(await store.getShell("k")).toBeNull();
  });

  it("is invalidated by tag via the shared KV tag markers", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 300, 30, ["home"]);
    await drain(mockCtx);
    expect(await store.getShell("k")).not.toBeNull();

    await store.invalidateTags(["home"]);
    expect(await store.getShell("k")).toBeNull();
  });

  it("purges a tagged L1 shell but still checks its generation marker", async () => {
    const tagPurge = vi.fn(async () => {});
    const store = new CFCacheStore({
      ctx: mockCtx,
      kv: mockKV as any,
      tagPurge,
    });
    await store.putShell("k", shellEntry(), 300, 30, ["home"]);
    await drain(mockCtx);

    const cached = [...mockCache.store.values()][0];
    expect(cached.headers.get("Cache-Tag")).toContain("rg:default:e:home");

    await store.invalidateTags(["home"]);
    expect(tagPurge).toHaveBeenCalledWith(["rg:default:e:home"]);
    // The mock purge does not evict. Shell L1 reads must still reject the old
    // capture through the marker, unlike ordinary purge-mode L1 data reads.
    expect(mockCache.store.size).toBe(1);
    expect(await store.getShell("k")).toBeNull();
  });

  it("does not resurrect a shell captured before tag invalidation", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const capturedAt = Date.now();
    await store.invalidateTags(["home"]);
    await drain(mockCtx);
    expect(
      await store.putShell(
        "k",
        shellEntry({ createdAt: capturedAt }),
        300,
        30,
        ["home"],
      ),
    ).toBe("invalidated");
    await drain(mockCtx);

    expect(await store.getShell("k")).toBeNull();
    expect(
      [...mockKV.store.keys()].some((key) => key.includes("shell2:k")),
    ).toBe(false);
  });

  it("does not delete a newer shell when an older capture is rejected", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.invalidateTags(["home"]);
    await drain(mockCtx);
    const invalidatedAt = Date.now();
    vi.setSystemTime(new Date(invalidatedAt + 1));
    await store.putShell(
      "k",
      shellEntry({ prelude: btoa("new"), createdAt: invalidatedAt + 1 }),
      300,
      30,
      ["home"],
    );
    await drain(mockCtx);
    await store.putShell(
      "k",
      shellEntry({ prelude: btoa("old"), createdAt: invalidatedAt - 1 }),
      300,
      30,
      ["home"],
    );
    await drain(mockCtx);

    expect((await store.getShell("k"))?.entry.prelude).toBe(btoa("new"));
  });

  it("evicts and misses on a corrupt (non-JSON) KV entry", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 300, 30);
    await drain(mockCtx);

    // Corrupt the stored envelope in place under the shell KV key.
    const shellKvKey = [...mockKV.store.keys()].find((k) =>
      k.includes("shell2:k"),
    )!;
    mockKV.store.set(shellKvKey, { value: "{not-json" });
    mockCache.store.clear();

    expect(await store.getShell("k")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("falls through to KV when the L1 shell body is corrupt", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    await drain(mockCtx);

    const l1Key = [...mockCache.store.keys()][0];
    mockCache.store.set(
      l1Key,
      new Response("{not-json", {
        headers: { "Cache-Control": "public, max-age=330" },
      }),
    );

    expect((await store.getShell("k"))?.entry).toEqual(entry);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Issue #941: the prelude-first read (readShellDocument) resolves with the
  // head and the raw prelude while the snapshot bytes behind them are still
  // arriving; only the snapshot promise waits for them.
  describe("prelude-first read (readShellDocument)", () => {
    const SNAPSHOT: ShellCacheEntry["snapshot"] = [
      {
        family: "loader",
        key: "M0L0D0.big",
        value: { value: "X".repeat(4096), holes: 0, runs: 0 },
      },
    ];

    /** Replace the stored L1 body with one that holds everything from `at` until released. */
    function gateL1Body(at: (bytes: Uint8Array) => number) {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const [l1Key, stored] = [...mockCache.store][0]!;
      mockCache.store.set(l1Key, stored);
      const original = mockCache.match.bind(mockCache);
      vi.spyOn(mockCache, "match").mockImplementation(async (request) => {
        const response = await original(request);
        if (!response) return response;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const split = at(bytes);
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(bytes.subarray(0, split));
              await released;
              controller.enqueue(bytes.subarray(split));
              controller.close();
            },
          }),
          { status: response.status, headers: response.headers },
        );
      });
      return release;
    }

    it("resolves the head and prelude before the snapshot bytes arrive", async () => {
      vi.useRealTimers();
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      const entry = shellEntry({ snapshot: SNAPSHOT });
      await store.putShell("k", entry, 300, 30);
      await drain(mockCtx);
      const snapshotLength = JSON.stringify(SNAPSHOT).length;
      const release = gateL1Body((bytes) => bytes.length - snapshotLength);

      const read = await store.readShellDocument("k");
      expect(read).not.toBeNull();
      expect(new TextDecoder().decode(read!.prelude)).toBe(
        "<html><body>SHELL</body></html>",
      );
      expect(read!.entry.postponed).toBe(entry.postponed);
      let snapshotSettled = false;
      void read!.snapshot.then(() => {
        snapshotSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(snapshotSettled).toBe(false);

      release();
      expect(await read!.snapshot).toEqual(SNAPSHOT);
    });

    it("starts the tag-marker read before the prelude bytes are read", async () => {
      vi.useRealTimers();
      // No isolate marker memo: the head's own marker read, not a memo hit.
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { markerFreshMs: 0 },
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      // Only L1 can answer: drop the shell's KV copy (tag markers stay).
      for (const key of [...mockKV.store.keys()]) {
        if (key.includes("shell")) mockKV.store.delete(key);
      }
      // Withhold the body's last byte (inside the prelude) until a marker read
      // begins: a read that parses the whole body before the marker stalls.
      const release = gateL1Body((bytes) => bytes.length - 1);
      const kvGet = mockKV.get.bind(mockKV);
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        if (key.includes("__tag__/home")) release();
        return kvGet(key, options);
      });

      const read = await Promise.race([
        store.getShell("k"),
        new Promise<"stalled">((resolve) =>
          setTimeout(() => resolve("stalled"), 500),
        ),
      ]);
      expect(read).not.toBe("stalled");
      expect(read).not.toBeNull();
    });

    it("an invalidated tag still rejects the read before it resolves", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      await store.invalidateTags(["home"]);
      expect(await store.readShellDocument("k")).toBeNull();
    });

    it("a corrupt snapshot resolves undefined after the commit and evicts both tiers", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry({ snapshot: SNAPSHOT }), 300, 30);
      await drain(mockCtx);
      // Truncate the snapshot JSON in the stored L1 body.
      const [l1Key, stored] = [...mockCache.store][0]!;
      const bytes = new Uint8Array(await stored.clone().arrayBuffer());
      mockCache.store.set(
        l1Key,
        new Response(bytes.subarray(0, bytes.length - 10), {
          headers: stored.headers,
        }),
      );

      const read = await store.readShellDocument("k");
      expect(read).not.toBeNull();
      expect(await read!.snapshot).toBeUndefined();
      await drain(mockCtx);
      expect(mockCache.store.size).toBe(0);
      expect(
        [...mockKV.store.keys()].some((key) => key.includes("shell2:k")),
      ).toBe(false);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("streams a KV hit prelude-first and promotes it into L1 after the snapshot", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      const entry = shellEntry({ snapshot: SNAPSHOT });
      await store.putShell("k", entry, 300, 30);
      await drain(mockCtx);
      mockCache.store.clear();
      const kvGet = mockKV.get.bind(mockKV);
      const types: (string | undefined)[] = [];
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        types.push(options?.type);
        const value = await kvGet(key, options);
        return options?.type === "stream" && typeof value === "string"
          ? new Response(value).body
          : value;
      });

      const read = await store.readShellDocument("k");
      expect(types).toContain("stream");
      expect(new TextDecoder().decode(read!.prelude)).toBe(
        "<html><body>SHELL</body></html>",
      );
      expect(await read!.snapshot).toEqual(SNAPSHOT);
      await drain(mockCtx);
      expect(mockCache.store.size).toBe(1);
      mockKV.store.clear();
      expect((await store.getShell("k"))?.entry).toEqual(entry);
    });

    // The tag names a shell key carried last time start their marker reads
    // alongside the Cache API match; the check itself still uses the head.
    it("a hinted HIT starts the marker read before the Cache API match resolves", async () => {
      vi.useRealTimers();
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { markerFreshMs: 0 },
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      let matchResolved = false;
      let markerReadBeforeMatch = false;
      const kvGet = mockKV.get.bind(mockKV);
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        if (key.includes("__tag__/home") && !matchResolved) {
          markerReadBeforeMatch = true;
        }
        return kvGet(key, options);
      });
      const match = mockCache.match.bind(mockCache);
      vi.spyOn(mockCache, "match").mockImplementation(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await match(request);
        matchResolved = true;
        return response;
      });
      expect(await store.readShellDocument("k")).not.toBeNull();
      expect(markerReadBeforeMatch).toBe(true);
    });

    it("the route's static tags are hinted before this isolate has seen the key", async () => {
      vi.useRealTimers();
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { markerFreshMs: 0 },
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      resetCFShellMemoForTests(); // no remembered hint
      const markerGets: string[] = [];
      const kvGet = mockKV.get.bind(mockKV);
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        if (key.includes("__tag__/")) markerGets.push(key);
        return kvGet(key, options);
      });
      let matchResolved = false;
      let markerReadBeforeMatch = false;
      const match = mockCache.match.bind(mockCache);
      vi.spyOn(mockCache, "match").mockImplementation(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        markerReadBeforeMatch = markerGets.length > 0;
        const response = await match(request);
        matchResolved = true;
        return response;
      });
      expect(
        await store.readShellDocument("k", { tagHints: ["home"] }),
      ).not.toBeNull();
      expect(matchResolved).toBe(true);
      expect(markerReadBeforeMatch).toBe(true);
    });

    it("a wrong hint still rejects a shell invalidated under an unhinted tag", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { markerFreshMs: 0 },
      });
      await store.putShell("k", shellEntry(), 300, 30, ["b"]);
      await drain(mockCtx);
      resetCFShellMemoForTests(); // forget the remembered ["b"]
      vi.setSystemTime(new Date(Date.now() + 100));
      await store.invalidateTags(["b"]);
      expect(
        await store.readShellDocument("k", { tagHints: ["a"] }),
      ).toBeNull();
    });

    it("never reads the pre-frame `shell:` namespace", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry(), 300, 30);
      await drain(mockCtx);
      expect(
        [...mockKV.store.keys()].some((key) => key.includes("shell:k")),
      ).toBe(false);
      expect(
        [...mockCache.store.keys()].every((key) => key.includes("shell2%3Ak")),
      ).toBe(true);

      // Move the entry to the old keys with an old JSON envelope body: a
      // frame reader that looked there would report it as corrupt.
      const envelope = JSON.stringify({
        p: btoa("<html><body>OLD</body></html>"),
        po: null,
        rv: REACT_VERSION,
        bv: "build-abc",
        c: Date.now(),
        s: Date.now() + 300_000,
        e: Date.now() + 330_000,
      });
      for (const [key, value] of [...mockKV.store]) {
        mockKV.store.delete(key);
        mockKV.store.set(key.replace("shell2:k", "shell:k"), {
          ...value,
          value: envelope,
        });
      }
      for (const [key, response] of [...mockCache.store]) {
        mockCache.store.delete(key);
        mockCache.store.set(
          key.replace("shell2%3Ak", "shell%3Ak"),
          new Response(envelope, { headers: response.headers }),
        );
      }

      expect(await store.readShellDocument("k")).toBeNull();
      expect(await store.getShell("k")).toBeNull();
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    });

    // The KV budget covers opening the value AND reading its head and
    // prelude: two windows back to back would let a KV hit take twice
    // kvReadTimeoutMs before the commit.
    it("bounds a KV shell read by one kvReadTimeoutMs across open and body", async () => {
      vi.useRealTimers();
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        kvReadTimeoutMs: 60,
      });
      await store.putShell("k", shellEntry(), 300, 30);
      await drain(mockCtx);
      mockCache.store.clear();
      const kvGet = mockKV.get.bind(mockKV);
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        const value = await kvGet(key, options);
        if (options?.type !== "stream" || typeof value !== "string") {
          return value;
        }
        // Each half fits the budget on its own; together they do not.
        await sleep(40);
        const bytes = new TextEncoder().encode(value);
        return new ReadableStream<Uint8Array>({
          async start(controller) {
            await sleep(40);
            controller.enqueue(bytes);
            controller.close();
          },
        });
      });

      expect(await store.readShellDocument("k")).toBeNull();
      expect(
        consoleWarn.mock.calls.some(([message]) =>
          String(message).includes("KV read exceeded"),
        ),
      ).toBe(true);
      consoleWarn.mockRestore();
    });

    // A read nobody serves (a version mismatch, a render that skips the tail)
    // never awaits the snapshot; the KV tier's promotion must still happen.
    it("registers the snapshot read with waitUntil, so promotion runs unawaited", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry({ snapshot: SNAPSHOT }), 300, 30);
      await drain(mockCtx);
      mockCache.store.clear();
      mockCtx.waitUntil.mockClear();

      const read = await store.readShellDocument("k");
      expect(read).not.toBeNull();
      expect(mockCtx.waitUntil).toHaveBeenCalled();
      // Drain what the read registered, repeatedly (promotion is registered
      // from inside the snapshot read), without touching read.snapshot.
      for (let i = 0; i < 3; i++) await drain(mockCtx);
      expect(mockCache.store.size).toBe(1);
    });

    // The capture's whole-entry guard (shell-capture.ts) measures an entry
    // with estimateShellEntryBytes before any store sees it; it must not
    // undercount the frame this store writes, or an entry just under the
    // limit passes the guard and fails the KV put.
    it("estimateShellEntryBytes bounds the stored frame from above, escaped postponed state included", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      // Quote-heavy postponed state: every quote is escaped in the head.
      const postponed = JSON.stringify({
        holes: Array.from({ length: 200 }, (_, i) => ({
          id: `h${i}`,
          k: '"q"',
        })),
      });
      const tags = ["products", "product-classic-tee", "menus"];
      const docKey = "doc:app.test/products/classic-tee";
      const entry = shellEntry({ snapshot: SNAPSHOT, postponed, docKey });
      await store.putShell("k", entry, 300, 30, tags);
      await drain(mockCtx);
      const [, stored] = [...mockCache.store][0]!;
      const frameBytes = (await stored.clone().arrayBuffer()).byteLength;
      const preludeBytes = atob(entry.prelude!).length;
      const snapshotBytes = new TextEncoder().encode(
        JSON.stringify(SNAPSHOT),
      ).length;

      const estimate = estimateShellEntryBytes({
        preludeBytes,
        postponed,
        snapshot: SNAPSHOT,
        tags,
        docKey,
        prunedRecords: undefined,
      });
      expect(estimate).toBeGreaterThanOrEqual(frameBytes);
      expect(estimate - frameBytes).toBeLessThanOrEqual(
        SHELL_ENTRY_HEAD_ALLOWANCE_BYTES,
      );
      // The raw measure the guard used before undercounted this frame.
      const raw = preludeBytes + postponed.length + snapshotBytes;
      expect(raw).toBeLessThan(frameBytes);
    });

    // A frame cut exactly at the end of the prelude parses as "no snapshot"
    // unless the head says how long the snapshot is.
    it("treats a frame truncated at the prelude end as corrupt: evicted, and a getShell miss", async () => {
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry({ snapshot: SNAPSHOT }), 300, 30);
      await drain(mockCtx);
      const snapshotLength = JSON.stringify(SNAPSHOT).length;
      const [l1Key, stored] = [...mockCache.store][0]!;
      const bytes = new Uint8Array(await stored.clone().arrayBuffer());
      const truncated = () =>
        new Response(bytes.subarray(0, bytes.length - snapshotLength), {
          headers: stored.headers,
        });
      mockCache.store.set(l1Key, truncated());

      const read = await store.readShellDocument("k");
      expect(read).not.toBeNull();
      expect(await read!.snapshot).toBeUndefined();
      // Broken, not slow: the document HIT replaces the entry.
      expect(await read!.snapshotFailure).toBe("corrupt");
      await drain(mockCtx);
      expect(mockCache.store.size).toBe(0);
      expect(
        [...mockKV.store.keys()].some((key) => key.includes("shell2:k")),
      ).toBe(false);
      expect(
        consoleError.mock.calls.some(([label]) =>
          String(label).includes("corrupt shell snapshot"),
        ),
      ).toBe(true);

      // getShell has no commit to protect: the same failure is a miss.
      mockCache.store.set(l1Key, truncated());
      expect(await store.getShell("k")).toBeNull();
      consoleError.mockRestore();
    });

    it("getShell misses at kvReadTimeoutMs when the snapshot read is slow, without evicting the entry", async () => {
      vi.useRealTimers();
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        kvReadTimeoutMs: 30,
      });
      await store.putShell("k", shellEntry({ snapshot: SNAPSHOT }), 300, 30);
      await drain(mockCtx);
      const snapshotLength = JSON.stringify(SNAPSHOT).length;
      const release = gateL1Body((bytes) => bytes.length - snapshotLength);

      const started = Date.now();
      expect(await store.getShell("k")).toBeNull();
      // Bounded by kvReadTimeoutMs, not the document read's 1 s floor: a
      // partial navigation's two getShell reads stay quick misses.
      expect(Date.now() - started).toBeLessThan(500);
      expect(
        consoleWarn.mock.calls.some(([message]) =>
          String(message).includes(
            "shell snapshot read exceeded 30ms; treating as miss",
          ),
        ),
      ).toBe(true);
      // Slow is not broken: the entry stays for the next read.
      expect(mockCache.store.size).toBe(1);
      release();
      consoleWarn.mockRestore();
    });

    it("the document read waits past kvReadTimeoutMs for the snapshot (at least 1 s), and names a timeout unavailable", async () => {
      vi.useRealTimers();
      const consoleWarn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        kvReadTimeoutMs: 30,
      });
      await store.putShell("k", shellEntry({ snapshot: SNAPSHOT }), 300, 30);
      await drain(mockCtx);
      const snapshotLength = JSON.stringify(SNAPSHOT).length;

      // Arrives after 100 ms: past kvReadTimeoutMs, inside the floor.
      const release = gateL1Body((bytes) => bytes.length - snapshotLength);
      const late = await store.readShellDocument("k");
      setTimeout(release, 100);
      expect(await late!.snapshot).toEqual(SNAPSHOT);
      expect(await late!.snapshotFailure).toBeUndefined();

      // Never arrives: resolves undefined at the floor, as unavailable.
      resetCFShellMemoForTests();
      vi.restoreAllMocks();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const hold = gateL1Body((bytes) => bytes.length - snapshotLength);
      const started = Date.now();
      const slow = await store.readShellDocument("k");
      expect(await slow!.snapshot).toBeUndefined();
      expect(await slow!.snapshotFailure).toBe("unavailable");
      expect(Date.now() - started).toBeGreaterThanOrEqual(990);
      expect(
        warn.mock.calls.some(([message]) =>
          String(message).includes(
            "shell snapshot read exceeded 1000ms; the HIT reloads the page into a cache-miss render",
          ),
        ),
      ).toBe(true);
      hold();
      warn.mockRestore();
      consoleWarn.mockRestore();
    });
  });

  // Issue #941, decision 1: a fresh shell read is memoized per isolate for
  // `memo.shellMs`; the tag-marker check still runs on every read.
  describe("per-isolate shell memo", () => {
    async function readTwice(store: CFCacheStore, key = "k") {
      const first = await store.readShellDocument(key);
      await first?.snapshot;
      const matchSpy = vi.spyOn(mockCache, "match");
      const kvSpy = vi.spyOn(mockKV, "get");
      const second = await store.readShellDocument(key);
      const shellReads =
        matchSpy.mock.calls.length +
        kvSpy.mock.calls.filter(([k]) => k.includes("shell2:")).length;
      return { first, second, shellReads };
    }

    it("a memo hit skips the Cache API and KV read", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      const entry = shellEntry({
        snapshot: [
          {
            family: "loader",
            key: "M0L0D0.it",
            value: { value: "v", holes: 0, runs: 0 },
          },
        ],
      });
      await store.putShell("k", entry, 300, 30);
      await drain(mockCtx);
      const { second, shellReads } = await readTwice(store);
      expect(shellReads).toBe(0);
      expect(new TextDecoder().decode(second!.prelude)).toBe(
        "<html><body>SHELL</body></html>",
      );
      expect(await second!.snapshot).toEqual(entry.snapshot);
      expect(second!.entry.buildVersion).toBe("build-abc");
    });

    it("reads the store again once the window has passed", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { shellMs: 1000 },
      });
      await store.putShell("k", shellEntry(), 300, 30);
      await drain(mockCtx);
      await (
        await store.readShellDocument("k")
      )?.snapshot;
      vi.advanceTimersByTime(1000);
      const matchSpy = vi.spyOn(mockCache, "match");
      expect(await store.readShellDocument("k")).not.toBeNull();
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });

    it("a window of 0 disables the memo", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { shellMs: 0 },
      });
      await store.putShell("k", shellEntry(), 300, 30);
      await drain(mockCtx);
      expect((await readTwice(store)).shellReads).toBe(1);
    });

    it("never memoizes a stale shell", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry(), 10, 300);
      await drain(mockCtx);
      vi.advanceTimersByTime(11_000);
      const { first, shellReads } = await readTwice(store);
      expect(first?.shouldRevalidate).toBe(true);
      expect(shellReads).toBe(1);
    });

    // A memoized shell that went stale is read from the store again. That
    // read keeps the caller's hints: the key's own hint can be evicted while
    // the shell memo still holds the entry.
    it("a stale memo entry's store read starts the caller-hinted marker read before the Cache API match resolves", async () => {
      // Only Date is faked: the Cache API match below waits on a real timer.
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { shellMs: 60_000, markerFreshMs: 0 },
      });
      await store.putShell("k", shellEntry(), 10, 300, ["home"]);
      await drain(mockCtx);
      // Once a clone of a stored Response has been read, a GC (the fill below
      // makes one likely) leaves the stored body used in Node, and the next
      // clone throws. Re-seat the L1 entry from its bytes before each read.
      const [l1Key, stored] = [...mockCache.store][0]!;
      const frame = new Uint8Array(await stored.arrayBuffer());
      const reseatL1 = () =>
        mockCache.store.set(
          l1Key,
          new Response(frame, { headers: stored.headers }),
        );
      reseatL1();
      await (
        await store.readShellDocument("k")
      )?.snapshot;
      const memoProbe = vi.spyOn(mockCache, "match");
      expect(await store.readShellDocument("k")).not.toBeNull();
      expect(memoProbe).not.toHaveBeenCalled();
      memoProbe.mockRestore();
      // Other keys' writes push "k" out of the tag-name hints; the shell
      // memo, bounded by bytes, keeps its entry.
      await Promise.all(
        Array.from({ length: TAG_HINTS_MAX_ENTRIES }, (_, i) =>
          store.putShell(`other-${i}`, shellEntry(), 300, 30, ["other"]),
        ),
      );
      await drain(mockCtx);
      reseatL1();
      vi.setSystemTime(Date.now() + 11_000);

      let matchResolved = false;
      let markerReadBeforeMatch = false;
      const kvGet = mockKV.get.bind(mockKV);
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        if (key.includes("__tag__/home") && !matchResolved) {
          markerReadBeforeMatch = true;
        }
        return kvGet(key, options);
      });
      const match = mockCache.match.bind(mockCache);
      vi.spyOn(mockCache, "match").mockImplementation(async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const response = await match(request);
        matchResolved = true;
        return response;
      });
      const read = await store.readShellDocument("k", { tagHints: ["home"] });
      expect(matchResolved).toBe(true);
      expect(read?.shouldRevalidate).toBe(true);
      expect(markerReadBeforeMatch).toBe(true);
    });

    // Decision 2, revised: isolate B's memos (shell and marker) can predate
    // isolate A's updateTag; the mutating user's next request carries the
    // fresh-reads cookie, reads past both memos, and misses. Other users are
    // served the memoized shell until the marker memo refreshes (the isolate
    // memo contract suite covers that path).
    it("updateTag in another isolate: a request with the fresh-reads cookie misses at once (KV)", async () => {
      vi.resetModules();
      const isolateA = (await import("../cf-cache-store")).CFCacheStore;
      vi.resetModules();
      const isolateB = (await import("../cf-cache-store")).CFCacheStore;
      const contextB = await import("../../../server/request-context");
      const storeB = new isolateB({
        ctx: mockCtx,
        kv: mockKV as any,
        baseUrl: "https://test.internal/",
      });
      await storeB.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      await (
        await storeB.readShellDocument("k")
      )?.snapshot;
      const matchSpy = vi.spyOn(mockCache, "match");
      // Isolate B's memo serves it (no Cache API read)...
      expect(await storeB.readShellDocument("k")).not.toBeNull();
      expect(matchSpy).not.toHaveBeenCalled();

      await new isolateA({
        ctx: mockCtx,
        kv: mockKV as any,
        baseUrl: "https://test.internal/",
      }).invalidateTags(["home"]);
      await drain(mockCtx);
      // ...and still does for a request without the cookie (fresh marker memo)...
      expect(await storeB.readShellDocument("k")).not.toBeNull();
      // ...while the mutating user's next request reads the store and misses.
      const request = new Request("https://test.internal/p", {
        headers: { cookie: "rango-state-fresh=1" },
      });
      const fresh = contextB.createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
        stateCookieName: "rango-state_router_0",
      });
      expect(
        await contextB.runWithRequestContext(fresh, () =>
          storeB.readShellDocument("k"),
        ),
      ).toBeNull();
      expect(matchSpy).toHaveBeenCalledTimes(1);
      vi.resetModules();
    });

    // The isolate marker memo serves PPR shell reads only. A shell read's
    // memoized marker values must not reach the data families in the same
    // request: a request whose shell read MISSED would otherwise render and
    // store its "use cache" data under a marker up to markerMaxStaleMs old.
    describe("shell-read marker values stay out of the request's data reads", () => {
      const T0 = Date.UTC(2024, 0, 1);
      /**
       * Two isolates over one KV. `before` writes B's entries, then B
       * memoizes marker "T" through a shell read, then A invalidates "T".
       */
      async function isolates(
        before: (storeB: CFCacheStore) => Promise<void> = async () => {},
      ) {
        vi.resetModules();
        const isolateA = (await import("../cf-cache-store")).CFCacheStore;
        vi.resetModules();
        const isolateB = (await import("../cf-cache-store")).CFCacheStore;
        const contextB = await import("../../../server/request-context");
        const options = {
          ctx: mockCtx,
          kv: mockKV as any,
          baseUrl: "https://test.internal/",
        };
        const storeB = new isolateB(options);
        await before(storeB as unknown as CFCacheStore);
        await drain(mockCtx);
        const inRequestB = <R>(fn: () => Promise<R>): Promise<R> =>
          contextB.runWithRequestContext(
            contextB.createRequestContext({
              env: {},
              request: new Request("https://test.internal/p"),
              url: new URL("https://test.internal/p"),
              variables: {},
            }),
            fn,
          );
        // Isolate B memoizes marker "T" (none yet) through a shell read.
        await inRequestB(() =>
          storeB.readShellDocument("warm", { tagHints: ["T"] }),
        );
        await drain(mockCtx);
        vi.setSystemTime(T0 + 100);
        // Isolate A invalidates "T".
        await new isolateA(options).invalidateTags(["T"]);
        await drain(mockCtx);
        vi.setSystemTime(T0 + 200);
        return { storeB, inRequestB };
      }

      afterEach(() => vi.resetModules());

      it("a MISS with hints, then a data read of the hinted tag, reads KV", async () => {
        const { storeB, inRequestB } = await isolates((storeB) =>
          storeB.setItem("item", "GEN1", { ttl: 300, tags: ["T"] }),
        );
        const markerReads = vi.spyOn(mockKV, "get");
        const { shell, item } = await inRequestB(async () => {
          const shell = await storeB.readShellDocument("absent", {
            tagHints: ["T"],
          });
          const item = await storeB.getItem("item");
          return { shell, item };
        });
        expect(shell).toBeNull();
        // Written before A's invalidation, so the data read misses.
        expect(item).toBeNull();
        expect(
          markerReads.mock.calls.filter(([key]) => key.includes("__tag__/T")),
        ).toHaveLength(1);
      });

      it("a HIT, then a data read of a hinted tag the shell does not carry, reads KV", async () => {
        // The shell carries "home" only; the route also hints "T".
        const { storeB, inRequestB } = await isolates(async (storeB) => {
          await storeB.putShell("k", shellEntry(), 300, 30, ["home"]);
          await storeB.setItem("item", "GEN1", { ttl: 300, tags: ["T"] });
        });
        const { shell, item } = await inRequestB(async () => {
          const shell = await storeB.readShellDocument("k", {
            tagHints: ["T"],
          });
          await shell?.snapshot;
          const item = await storeB.getItem("item");
          return { shell, item };
        });
        expect(shell).not.toBeNull();
        expect(item).toBeNull();
      });

      // The shell carries "T"; B's memoized marker predates A's invalidation,
      // so the shell is served (other users' staleness, up to
      // markerMaxStaleMs), but a data read of "T" in the same request still
      // reads KV and misses: nothing is carried over from the shell read.
      it("a HIT, then a data read of the shell's own tag, reads KV", async () => {
        const { storeB, inRequestB } = await isolates(async (storeB) => {
          await storeB.putShell("k", shellEntry(), 300, 30, ["T"]);
          await storeB.setItem("item", "GEN1", { ttl: 300, tags: ["T"] });
        });
        const markerReads = vi.spyOn(mockKV, "get");
        const read = await inRequestB(async () => {
          const shell = await storeB.readShellDocument("k", {
            tagHints: ["T"],
          });
          await shell?.snapshot;
          return { shell, item: await storeB.getItem("item") };
        });
        expect(read.shell).not.toBeNull();
        expect(read.item).toBeNull();
        expect(
          markerReads.mock.calls.filter(([key]) => key.includes("__tag__/T")),
        ).toHaveLength(1);
      });
    });

    it("the invalidating isolate drops its own memoized shells for those tags", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        tagPurge: vi.fn(async () => {}),
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      await (
        await store.readShellDocument("k")
      )?.snapshot;
      await store.invalidateTags(["home"]);
      const matchSpy = vi.spyOn(mockCache, "match");
      await store.readShellDocument("k");
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });

    // KV-less purge mode: a HIT on the invalidating isolate while the purge
    // call is in flight read the still-present L1 entry and memoized it after
    // invalidateTags had dropped the memo; the memo-hit check consults only
    // the request's own marker memo, so the mutating user's next request on
    // this isolate got the purged shell for a whole window.
    it("a read during the purge does not memoize the shell being purged (KV-less purge mode)", async () => {
      let releasePurge!: () => void;
      const tagPurge = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releasePurge = () => {
              mockCache.store.clear(); // the purge evicts L1
              resolve();
            };
          }),
      );
      const store = new CFCacheStore({
        ctx: mockCtx,
        baseUrl: "https://test.internal/",
        tagPurge,
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      vi.advanceTimersByTime(10);

      const mutating = runWithRequestContext(makeReqCtx(), () =>
        store.invalidateTags(["home"]),
      );
      await Promise.resolve();
      expect(tagPurge).toHaveBeenCalledTimes(1);
      // Another user's HIT while the purge is in flight: the entry is still
      // in L1, so it is served, but not memoized.
      const during = await runWithRequestContext(makeReqCtx(), async () => {
        const read = await store.readShellDocument("k");
        await read?.snapshot;
        return read;
      });
      expect(during).not.toBeNull();
      const matchSpy = vi.spyOn(mockCache, "match");
      await runWithRequestContext(makeReqCtx(), async () => {
        await (
          await store.readShellDocument("k")
        )?.snapshot;
      });
      expect(matchSpy).toHaveBeenCalledTimes(1);

      releasePurge();
      await mutating;
      vi.advanceTimersByTime(10);
      // updateTag() has resolved: the mutating user's next request here.
      const next = await runWithRequestContext(makeReqCtx(), () =>
        store.readShellDocument("k"),
      );
      expect(next).toBeNull();
    });

    it("a shell captured after the invalidation is memoized while the record lives", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        baseUrl: "https://test.internal/",
        tagPurge: vi.fn(async () => {
          mockCache.store.clear();
        }),
      });
      await store.putShell("k", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      vi.advanceTimersByTime(10);
      await runWithRequestContext(makeReqCtx(), () =>
        store.invalidateTags(["home"]),
      );
      vi.advanceTimersByTime(10);
      await store.putShell(
        "k",
        shellEntry({ prelude: btoa("two"), createdAt: Date.now() }),
        300,
        30,
        ["home"],
      );
      await drain(mockCtx);
      await runWithRequestContext(makeReqCtx(), async () => {
        await (
          await store.readShellDocument("k")
        )?.snapshot;
      });
      const matchSpy = vi.spyOn(mockCache, "match");
      const read = await runWithRequestContext(makeReqCtx(), () =>
        store.readShellDocument("k"),
      );
      expect(new TextDecoder().decode(read!.prelude)).toBe("two");
      expect(matchSpy).not.toHaveBeenCalled();
    });

    it("this isolate's putShell replaces its memoized generation", async () => {
      const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
      await store.putShell("k", shellEntry({ prelude: btoa("one") }), 300, 30);
      await drain(mockCtx);
      await (
        await store.readShellDocument("k")
      )?.snapshot;
      await store.putShell("k", shellEntry({ prelude: btoa("two") }), 300, 30);
      await drain(mockCtx);
      const read = await store.readShellDocument("k");
      expect(new TextDecoder().decode(read!.prelude)).toBe("two");
    });

    it("evicts under the byte cap", async () => {
      const prelude = btoa("x".repeat(600));
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        memo: { shellMaxBytes: 1000 },
      });
      for (const key of ["a", "b"]) {
        await store.putShell(key, shellEntry({ prelude }), 300, 30);
        await drain(mockCtx);
        await (
          await store.readShellDocument(key)
        )?.snapshot;
      }
      const matchSpy = vi.spyOn(mockCache, "match");
      await store.readShellDocument("b");
      expect(matchSpy).not.toHaveBeenCalled();
      await store.readShellDocument("a");
      expect(matchSpy).toHaveBeenCalledTimes(1);
    });

    // A pruned capture (#958) stores only the records a HIT reads: the memo
    // keeps that stored snapshot and its prunedRecords, and counts the stored
    // (pruned) bytes.
    it("a memo hit keeps the stored pruned snapshot and prunedRecords, and counts the stored bytes", async () => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        baseUrl: "https://test.internal/",
      });
      const snapshot: ShellCacheEntry["snapshot"] = [
        {
          family: "loader",
          key: "M0L0D0.kept",
          value: { value: "KEPT", holes: 0, runs: 0 },
        },
      ];
      await store.putShell(
        "k",
        shellEntry({ snapshot, prunedRecords: "loader:4" }),
        300,
        30,
      );
      await drain(mockCtx);
      const withMetrics = () => {
        const ctx = makeReqCtx();
        ctx._metricsStore = createMetricsStore(true);
        return runWithRequestContext(ctx, async () => {
          const read = await store.readShellDocument("k");
          await read?.snapshot;
          return read;
        });
      };
      await withMetrics();
      const hit = await withMetrics();
      expect(hit!.stats!.tier).toBe("memo");
      expect(hit!.entry.prunedRecords).toBe("loader:4");
      expect(await hit!.snapshot).toEqual(snapshot);
      expect(hit!.stats!.memo).toEqual({
        hit: true,
        bytes:
          "<html><body>SHELL</body></html>".length +
          new TextEncoder().encode(JSON.stringify(snapshot)).length,
      });
    });

    it("is partitioned by build version", async () => {
      const v1 = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        version: "v1",
      });
      await v1.putShell("k", shellEntry(), 300, 30);
      await drain(mockCtx);
      await (
        await v1.readShellDocument("k")
      )?.snapshot;
      const v2 = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        version: "v2",
      });
      expect(await v2.readShellDocument("k")).toBeNull();
    });
  });

  it("does not emit shell tier decisions when internal debug is disabled", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("quiet-key", shellEntry(), 300, 30);
    await drain(mockCtx);
    expect(await store.getShell("quiet-key")).not.toBeNull();

    expect(
      consoleLog.mock.calls.some(
        ([message]) =>
          typeof message === "string" &&
          message.startsWith("[CFCacheStore][shell] "),
      ),
    ).toBe(false);
    consoleLog.mockRestore();
  });

  it("emits shell tier decisions when INTERNAL_RANGO_DEBUG is enabled", async () => {
    vi.stubEnv("INTERNAL_RANGO_DEBUG", "1");
    vi.resetModules();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const [
        { CFCacheStore: DebugCFCacheStore },
        { createRequestContext, runWithRequestContext },
      ] = await Promise.all([
        import("../cf-cache-store"),
        import("../../../server/request-context"),
      ]);
      const store = new DebugCFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        baseUrl: "https://test.internal/",
        // This test pins per-tier decisions; a memo hit would skip them.
        memo: { shellMs: 0 },
      });
      await store.putShell("debug-key", shellEntry(), 300, 30);
      await drain(mockCtx);

      const request = new Request("https://test.internal/?probe=debug", {
        headers: { "cf-ray": "1234abcd" },
      });
      Object.defineProperty(request, "cf", { value: { colo: "SJC" } });
      const reqCtx = createRequestContext({
        env: {},
        request,
        url: new URL(request.url),
        variables: {},
      });
      expect(
        await runWithRequestContext(reqCtx, () => store.getShell("debug-key")),
      ).not.toBeNull();
      mockCache.store.clear();
      expect(await store.getShell("debug-key")).not.toBeNull();
      await drain(mockCtx);

      await store.putShell("tagged-debug-key", shellEntry(), 300, 30, ["home"]);
      await drain(mockCtx);
      await store.invalidateTags(["home"]);
      expect(await store.getShell("tagged-debug-key")).toBeNull();

      const prefix = "[CFCacheStore][shell] ";
      const events = consoleLog.mock.calls.flatMap(([message]) => {
        if (typeof message !== "string" || !message.startsWith(prefix)) {
          return [];
        }
        return [
          JSON.parse(message.slice(prefix.length)) as {
            outcome: string;
            tier?: string;
            ray?: string;
            colo?: string;
          },
        ];
      });
      expect(events.map((event) => event.outcome)).toEqual(
        expect.arrayContaining([
          "l1-stored",
          "kv-stored",
          "l1-hit",
          "l1-miss",
          "kv-hit",
          "kv-promoted",
          "marker-invalidated",
        ]),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          outcome: "l1-hit",
          ray: "1234abcd",
          colo: "SJC",
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          outcome: "marker-invalidated",
          tier: "l1",
        }),
      );
    } finally {
      consoleLog.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  // Only this request's own unconfirmed mask is kept from the isolate memo:
  // a value another read of the tag memoized mid-read came from KV.
  it("a marker a concurrent data read memoized mid-read, with no invalidation, reaches the isolate memo", async () => {
    const store = new CFCacheStore({
      ctx: mockCtx,
      kv: mockKV as any,
      baseUrl: "https://test.internal/",
      memo: { markerFreshMs: 60_000 },
    });
    await store.putShell("k", shellEntry(), 300, 30, ["T"]);
    await store.setItem("item", "v", { ttl: 300, tags: ["T"] });
    await drain(mockCtx);

    const get = mockKV.get.bind(mockKV);
    let releaseReads!: () => void;
    const held = new Promise<void>((resolve) => (releaseReads = resolve));
    let markerReads = 0;
    vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
      if (key.includes("__tag__/")) {
        markerReads++;
        await held;
      }
      return get(key, options);
    });

    const readsStarted = async (count: number) => {
      for (let i = 0; i < 100 && markerReads < count; i++) {
        await Promise.resolve();
      }
      expect(markerReads).toBe(count);
    };
    await runWithRequestContext(makeReqCtx(), async () => {
      // The data read's KV read resolves first and memoizes the marker for
      // the request; the shell read's then finds it memoized mid-read.
      const data = store.getItem("item");
      await readsStarted(1);
      const shell = store.readShellDocument("k");
      await readsStarted(2);
      releaseReads();
      expect(await data).not.toBeNull();
      expect(await shell).not.toBeNull();
    });
    await drain(mockCtx);

    markerReads = 0;
    const later = await runWithRequestContext(makeReqCtx(), () =>
      store.readShellDocument("k"),
    );
    expect(later).not.toBeNull();
    expect(markerReads).toBe(0);
  });

  // #973: the invalidating request's mask is unconfirmed until the KV put
  // lands. A shell marker read in flight when it is set resolves to it for
  // this request, but must not store it in the isolate marker memo: if the
  // put then fails, later requests would miss for markerFreshMs with no
  // marker in KV.
  it.each(["updateTag", "revalidateTag"] as const)(
    "%s: an in-flight shell marker read keeps the unconfirmed mask out of the isolate memo; after a failed put a later request hits",
    async (verb) => {
      const store = new CFCacheStore({
        ctx: mockCtx,
        kv: mockKV as any,
        baseUrl: "https://test.internal/",
        memo: { markerFreshMs: 60_000 },
      });
      await store.putShell("k", shellEntry(), 300, 30, ["T"]);
      await drain(mockCtx);
      vi.setSystemTime(Date.now() + 100);

      const put = mockKV.put.bind(mockKV);
      vi.spyOn(mockKV, "put").mockImplementation(async (key, ...rest) => {
        if (key.includes("__tag__/")) throw new Error("KV down");
        return put(key, ...rest);
      });
      const get = mockKV.get.bind(mockKV);
      let releaseRead!: () => void;
      let readStarted!: () => void;
      const held = new Promise<void>((resolve) => (releaseRead = resolve));
      const started = new Promise<void>((resolve) => (readStarted = resolve));
      vi.spyOn(mockKV, "get").mockImplementation(async (key, options) => {
        if (key.includes("__tag__/")) {
          readStarted();
          await held;
        }
        return get(key, options);
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const req = createRequestContext({
        env: {},
        request: new Request("https://test.internal/p"),
        url: new URL("https://test.internal/p"),
        variables: {},
        cacheStore: store,
      });

      await runWithRequestContext(req, async () => {
        const inFlight = store.readShellDocument("k");
        await started;
        const invalidation = verb === "updateTag" ? updateTag("T") : undefined;
        if (verb === "revalidateTag") revalidateTag("T");
        releaseRead();
        expect(await inFlight).toBeNull();
        if (invalidation) await expect(invalidation).rejects.toThrow();
      });
      await Promise.all(req._pendingBackgroundTasks ?? []);
      await drain(mockCtx);

      const later = await runWithRequestContext(makeReqCtx(), () =>
        store.readShellDocument("k"),
      );
      expect(later).not.toBeNull();
    },
  );
});
