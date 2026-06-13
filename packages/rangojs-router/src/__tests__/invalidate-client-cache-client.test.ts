/**
 * Client seat of invalidateClientCache() (the default export condition):
 * SSR no-op, store mark-stale (SWR), and the pre-boot clearPrefetchCache
 * fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateClientCache,
  keepClientCache,
} from "../browser/invalidate-client-cache.js";
import { getRegisteredStore } from "../browser/navigation-store-handle.js";
import { clearPrefetchCache } from "../browser/prefetch/cache.js";

vi.mock("../browser/navigation-store-handle.js", () => ({
  getRegisteredStore: vi.fn(),
}));
vi.mock("../browser/prefetch/cache.js", () => ({
  clearPrefetchCache: vi.fn(),
}));

const mockedGetStore = vi.mocked(getRegisteredStore);
const mockedClear = vi.mocked(clearPrefetchCache);

describe("invalidateClientCache() (client seat)", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("no-ops during SSR (no document) and touches no caches", () => {
    invalidateClientCache(); // document is undefined in this env
    expect(mockedGetStore).not.toHaveBeenCalled();
    expect(mockedClear).not.toHaveBeenCalled();
  });

  it("marks the registered store stale and broadcasts (SWR path)", () => {
    vi.stubGlobal("document", {});
    const store = { markCacheAsStaleAndBroadcast: vi.fn() };
    mockedGetStore.mockReturnValue(store as never);

    invalidateClientCache();

    expect(store.markCacheAsStaleAndBroadcast).toHaveBeenCalledTimes(1);
    expect(mockedClear).not.toHaveBeenCalled();
  });

  it("falls back to clearPrefetchCache before boot (no store registered)", () => {
    vi.stubGlobal("document", {});
    mockedGetStore.mockReturnValue(null);

    invalidateClientCache();

    expect(mockedClear).toHaveBeenCalledTimes(1);
  });

  it("keepClientCache() is a client no-op (warns, touches no caches)", () => {
    vi.stubGlobal("document", {});
    mockedGetStore.mockReturnValue(null);

    expect(() => keepClientCache()).not.toThrow();
    expect(mockedGetStore).not.toHaveBeenCalled();
    expect(mockedClear).not.toHaveBeenCalled();
  });
});
