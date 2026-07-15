import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CFCacheStore } from "../cf-cache-store";
import type { ShellCacheEntry } from "../../types";

// ============================================================================
// Mock KV (the shell family is KV-only — no Cache API tier in v1)
// ============================================================================

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

// Install a mock caches global so the store's getCache() (used elsewhere in the
// class, though not on the shell path) never touches a real Cache API.
(globalThis as any).caches ??= {
  default: {
    async match() {
      return undefined;
    },
    async put() {},
    async delete() {
      return false;
    },
  },
};

describe("CFCacheStore shell family (KV-only)", () => {
  let mockKV: MockKV;
  let mockCtx: ReturnType<typeof createMockCtx>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    mockKV = new MockKV();
    mockCtx = createMockCtx();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a shell entry through KV", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const entry = shellEntry();
    await store.putShell("k", entry, 300, 30);
    await drain(mockCtx);

    const hit = await store.getShell("k");
    expect(hit).not.toBeNull();
    expect(hit?.entry).toEqual(entry);
    expect(hit?.shouldRevalidate).toBe(false);
  });

  it("returns after scheduling the waitUntil KV write", async () => {
    const originalPut = mockKV.put.bind(mockKV);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.spyOn(mockKV, "put").mockImplementation(async (...args) => {
      await originalPut(...args);
      await writeGate;
    });
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });

    await expect(store.putShell("k", shellEntry(), 300, 30)).resolves.toBe(
      undefined,
    );
    expect(mockCtx.waitUntil).toHaveBeenCalledOnce();

    releaseWrite();
    await drain(mockCtx);
  });

  it("serves a pending shell without another KV read", async () => {
    const originalPut = mockKV.put.bind(mockKV);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    vi.spyOn(mockKV, "put").mockImplementation(async (...args) => {
      await writeGate;
      await originalPut(...args);
    });
    const writer = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const reader = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    const get = vi.spyOn(mockKV, "get");

    await writer.putShell("k", shellEntry(), 300, 30);
    await expect(reader.getShell("k")).resolves.toMatchObject({
      entry: { prelude: shellEntry().prelude },
    });
    expect(get).not.toHaveBeenCalled();

    releaseWrite();
    await drain(mockCtx);
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

  it("skips the KV write when ttl+swr is below the 60s KV floor", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    await store.putShell("k", shellEntry(), 10, 0); // total 10 < 60
    await drain(mockCtx);
    expect(await store.getShell("k")).toBeNull();
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

    expect(await store.getShell("k")).toBeNull();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
