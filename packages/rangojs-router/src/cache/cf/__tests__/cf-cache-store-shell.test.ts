import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";
import type { ShellCacheEntry } from "../../types";

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

  it("no-ops getShell/putShell when no KV namespace is configured, warning once per isolate", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const inertWarnings = () =>
      warnSpy.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0].includes("shell family (getShell/putShell) is a no-op"),
      );

    const store = new CFCacheStore({ ctx: mockCtx }); // no kv
    await store.putShell("k", shellEntry(), 300, 30);
    await drain(mockCtx);
    expect(await store.getShell("k")).toBeNull();

    // The silent fail-open is loud exactly once (issue #651): getShell/
    // putShell only run for ppr routes, so this names the permanent-MISS
    // shape and the fix without spamming every request.
    expect(inertWarnings()).toHaveLength(1);
    expect(inertWarnings()[0][0]).toContain("kv: env.CACHE_KV");

    // Once per ISOLATE, not per instance: CFCacheStore is constructed per
    // request, so a second no-KV store must not re-warn.
    const store2 = new CFCacheStore({ ctx: createMockCtx() });
    expect(await store2.getShell("k")).toBeNull();
    expect(inertWarnings()).toHaveLength(1);
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
        headers: { "cf-ray": "1234abcd-SJC" },
      });
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
          ray: "1234abcd-SJC",
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
