import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";
import type { ShellCacheEntry } from "../../types";
import {
  createRequestContext,
  runWithRequestContext,
} from "../../../server/request-context";

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
    ...overrides,
  };
}

describe("CFCacheStore shell family (Cache API L1 + KV L2)", () => {
  let mockCache: MockCache;
  let mockKV: MockKV;
  let mockCtx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.restoreAllMocks();
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
          family: "item",
          key: "use-cache:x",
          value: { value: "CAPVAL", tags: ["t1"] },
        },
        {
          family: "response",
          key: "res:y",
          value: { status: 200, headers: [["x-a", "1"]], body: btoa("BODY") },
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

  it("round-trips replay eligibility flags through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell(
      "k",
      shellEntry({
        handlerLiveHoles: true,
        transitionWhen: true,
        navigationOnly: true,
      }),
      300,
      30,
    );
    await drain(mockCtx);
    mockCache.store.clear();

    const entry = (await store.getShell("k"))?.entry;
    expect(entry?.handlerLiveHoles).toBe(true);
    expect(entry?.transitionWhen).toBe(true);
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

  it("still rejects a DOCUMENT envelope missing its prelude (loosening is navigationOnly-scoped)", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 300, 30);
    await drain(mockCtx);
    mockCache.store.clear();
    // Strip the prelude from the stored document envelope in place.
    for (const [key, stored] of mockKV.store) {
      const parsed = JSON.parse(stored.value);
      if (parsed && typeof parsed === "object" && "p" in parsed) {
        delete parsed.p;
        mockKV.store.set(key, { ...stored, value: JSON.stringify(parsed) });
      }
    }
    expect(await store.getShell("k")).toBeNull();
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

  it("stores short-lived shells in L1 while skipping KV below its 60s floor", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 10, 0); // total 10 < 60
    await drain(mockCtx);
    expect(await store.getShell("k")).not.toBeNull();
    expect(mockCache.store.size).toBe(1);
    expect(mockKV.store.size).toBe(0);
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
      [...mockKV.store.keys()].some((key) => key.includes("shell:k")),
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
      shellEntry({ prelude: "new", createdAt: invalidatedAt + 1 }),
      300,
      30,
      ["home"],
    );
    await drain(mockCtx);
    await store.putShell(
      "k",
      shellEntry({ prelude: "old", createdAt: invalidatedAt - 1 }),
      300,
      30,
      ["home"],
    );
    await drain(mockCtx);

    expect((await store.getShell("k"))?.entry.prelude).toBe("new");
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
      k.includes("shell:k"),
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
});
