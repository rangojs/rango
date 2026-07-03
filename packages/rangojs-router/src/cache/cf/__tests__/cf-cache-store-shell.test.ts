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

  it("returns null on a miss", async () => {
    const store = new CFCacheStore({ ctx: mockCtx, kv: mockKV as any });
    expect(await store.getShell("absent")).toBeNull();
  });

  it("no-ops getShell/putShell when no KV namespace is configured", async () => {
    const store = new CFCacheStore({ ctx: mockCtx }); // no kv
    await store.putShell("k", shellEntry(), 300, 30);
    await drain(mockCtx);
    expect(await store.getShell("k")).toBeNull();
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
