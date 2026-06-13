import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readThroughItem } from "../read-through-swr.js";
import type { CacheItemResult, CacheItemOptions } from "../types.js";
import type { CacheErrorCategory } from "../cache-error.js";

function createMockStore(cached: CacheItemResult | null = null) {
  return {
    getItem: vi.fn().mockResolvedValue(cached),
    setItem: vi.fn().mockResolvedValue(undefined),
  };
}

const serialize = vi.fn(async (data: string) => `ser:${data}`);
const deserialize = vi.fn(async (value: string) => value.replace("ser:", ""));
const execute = vi.fn(async () => "fresh-data");
const storeOptions: CacheItemOptions = { ttl: 60, swr: 300 };

describe("readThroughItem", () => {
  // The engine is LOUD-but-non-fatal: degradation paths report via console and
  // the host reporter. Suppress console noise here; the reporter is asserted
  // explicitly in the "error observability" block.
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  describe("fresh hit", () => {
    it("returns deserialized cached data", async () => {
      const store = createMockStore({
        value: "ser:cached-data",
        shouldRevalidate: false,
      });

      const result = await readThroughItem({
        ...store,
        key: "test-key",
        execute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("cached-data");
      expect(store.getItem).toHaveBeenCalledWith("test-key");
      expect(execute).not.toHaveBeenCalled();
      expect(store.setItem).not.toHaveBeenCalled();
    });

    it("calls onHit callback with cached result", async () => {
      const cached: CacheItemResult = {
        value: "ser:data",
        shouldRevalidate: false,
      };
      const store = createMockStore(cached);
      const onHit = vi.fn();

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        onHit,
      });

      expect(onHit).toHaveBeenCalledWith(cached);
    });

    it("does not call onStale or onMiss on fresh hit", async () => {
      const store = createMockStore({
        value: "ser:data",
        shouldRevalidate: false,
      });
      const onStale = vi.fn();
      const onMiss = vi.fn();

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        onStale,
        onMiss,
      });

      expect(onStale).not.toHaveBeenCalled();
      expect(onMiss).not.toHaveBeenCalled();
    });
  });

  describe("stale hit", () => {
    it("returns stale data immediately", async () => {
      const store = createMockStore({
        value: "ser:stale-data",
        shouldRevalidate: true,
      });

      const result = await readThroughItem({
        ...store,
        key: "test-key",
        execute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("stale-data");
    });

    it("revalidates in background when waitUntil is available", async () => {
      const store = createMockStore({
        value: "ser:stale-data",
        shouldRevalidate: true,
      });
      const bgTasks: Array<() => Promise<void>> = [];
      const host = { waitUntil: (fn: () => Promise<void>) => bgTasks.push(fn) };
      const localExecute = vi.fn(async () => "fresh-data");

      await readThroughItem({
        ...store,
        key: "test-key",
        execute: localExecute,
        serialize,
        deserialize,
        storeOptions,
        host,
      });

      // Background task scheduled but not yet run
      expect(localExecute).not.toHaveBeenCalled();
      expect(bgTasks).toHaveLength(1);

      // Run background task
      await bgTasks[0]();
      expect(localExecute).toHaveBeenCalled();
      expect(store.setItem).toHaveBeenCalledWith(
        "test-key",
        "ser:fresh-data",
        storeOptions,
      );
    });

    it("revalidates inline (fire-and-forget) when no waitUntil", async () => {
      const store = createMockStore({
        value: "ser:stale-data",
        shouldRevalidate: true,
      });
      const localExecute = vi.fn(async () => "fresh-data");

      const result = await readThroughItem({
        ...store,
        key: "test-key",
        execute: localExecute,
        serialize,
        deserialize,
        storeOptions,
        host: null,
      });

      // Returns stale data; background task fires inline (not awaited by readThroughItem)
      expect(result).toBe("stale-data");
    });

    it("calls onStale callback", async () => {
      const cached: CacheItemResult = {
        value: "ser:stale",
        shouldRevalidate: true,
      };
      const store = createMockStore(cached);
      const onStale = vi.fn();

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        onStale,
      });

      expect(onStale).toHaveBeenCalledWith(cached);
    });

    it("does not throw when background revalidation fails", async () => {
      const store = createMockStore({
        value: "ser:stale-data",
        shouldRevalidate: true,
      });
      const failingExecute = vi.fn().mockRejectedValue(new Error("boom"));

      // Should not throw
      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: failingExecute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("stale-data");
    });

    it("skips setItem when serialize returns null", async () => {
      const store = createMockStore({
        value: "ser:stale",
        shouldRevalidate: true,
      });
      const nullSerialize = vi.fn(async () => null);

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize: nullSerialize,
        deserialize,
        storeOptions,
      });

      expect(store.setItem).not.toHaveBeenCalled();
    });
  });

  describe("cache miss", () => {
    it("executes and returns fresh data", async () => {
      const store = createMockStore(null);
      const localExecute = vi.fn(async () => "fresh-data");

      const result = await readThroughItem({
        ...store,
        key: "test-key",
        execute: localExecute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("fresh-data");
      expect(localExecute).toHaveBeenCalled();
    });

    it("writes to cache after execution", async () => {
      const store = createMockStore(null);

      await readThroughItem({
        ...store,
        key: "test-key",
        execute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(store.setItem).toHaveBeenCalledWith(
        "test-key",
        "ser:fresh-data",
        storeOptions,
      );
    });

    it("uses waitUntil for cache write when available", async () => {
      const store = createMockStore(null);
      const bgTasks: Array<() => Promise<void>> = [];
      const host = { waitUntil: (fn: () => Promise<void>) => bgTasks.push(fn) };

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        host,
      });

      // Cache write is delegated to waitUntil
      expect(store.setItem).not.toHaveBeenCalled();
      expect(bgTasks).toHaveLength(1);

      await bgTasks[0]();
      expect(store.setItem).toHaveBeenCalled();
    });

    it("blocks on cache write when no waitUntil (blockWhenNoWaitUntil)", async () => {
      const store = createMockStore(null);

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        host: null,
      });

      // Write completes before readThroughItem returns
      expect(store.setItem).toHaveBeenCalled();
    });

    it("calls onMiss and onCached callbacks", async () => {
      const store = createMockStore(null);
      const onMiss = vi.fn();
      const onCached = vi.fn();

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
        onMiss,
        onCached,
      });

      expect(onMiss).toHaveBeenCalled();
      expect(onCached).toHaveBeenCalled();
    });

    it("does not call onCached when serialize returns null", async () => {
      const store = createMockStore(null);
      const nullSerialize = vi.fn(async () => null);
      const onCached = vi.fn();

      await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize: nullSerialize,
        deserialize,
        storeOptions,
        onCached,
      });

      expect(store.setItem).not.toHaveBeenCalled();
      expect(onCached).not.toHaveBeenCalled();
    });

    it("does not throw when the cache write fails", async () => {
      const store = createMockStore(null);
      store.setItem.mockRejectedValue(new Error("write failed"));

      // Should not throw
      const result = await readThroughItem({
        ...store,
        key: "k",
        execute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("fresh-data");
    });
  });

  describe("error recovery", () => {
    it("falls through to execute when getItem throws", async () => {
      const store = createMockStore(null);
      store.getItem.mockRejectedValue(new Error("lookup failed"));
      const localExecute = vi.fn(async () => "fallback-data");

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: localExecute,
        serialize,
        deserialize,
        storeOptions,
      });

      expect(result).toBe("fallback-data");
    });

    it("falls through to execute when deserialize throws on fresh hit", async () => {
      const store = createMockStore({
        value: "corrupt",
        shouldRevalidate: false,
      });
      const failDeserialize = vi.fn().mockRejectedValue(new Error("bad data"));
      const localExecute = vi.fn(async () => "fallback-data");

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: localExecute,
        serialize,
        deserialize: failDeserialize,
        storeOptions,
      });

      expect(result).toBe("fallback-data");
    });

    it("falls through to execute when deserialize throws on stale hit", async () => {
      const store = createMockStore({
        value: "corrupt",
        shouldRevalidate: true,
      });
      const failDeserialize = vi.fn().mockRejectedValue(new Error("bad data"));
      const localExecute = vi.fn(async () => "fallback-data");

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: localExecute,
        serialize,
        deserialize: failDeserialize,
        storeOptions,
      });

      expect(result).toBe("fallback-data");
    });
  });

  describe("error observability (LOUD)", () => {
    // Degradation paths must report through the host's CacheErrorReporter so
    // consumers observe loader-cache degradation via onError (the package-wide
    // "cache errors are LOUD" contract). Each path still degrades gracefully.
    function reporterHost(extra?: {
      waitUntil?: (fn: () => Promise<void>) => void;
    }) {
      const reported: CacheErrorCategory[] = [];
      return {
        reported,
        host: {
          ...extra,
          _reportBackgroundError: (_e: unknown, category: CacheErrorCategory) =>
            reported.push(category),
        },
      };
    }

    it("reports cache-corrupt when a stored entry fails to deserialize", async () => {
      const store = createMockStore({
        value: "corrupt",
        shouldRevalidate: false,
      });
      const failDeserialize = vi.fn().mockRejectedValue(new Error("bad data"));
      const { host, reported } = reporterHost();

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: vi.fn(async () => "fresh-data"),
        serialize,
        deserialize: failDeserialize,
        storeOptions,
        host,
      });

      expect(result).toBe("fresh-data"); // still degrades to fresh
      expect(reported).toEqual(["cache-corrupt"]);
    });

    it("reports stale-revalidation when the background refresh fails", async () => {
      const store = createMockStore({
        value: "ser:stale-data",
        shouldRevalidate: true,
      });
      const bgTasks: Array<() => Promise<void>> = [];
      const { host, reported } = reporterHost({
        waitUntil: (fn) => bgTasks.push(fn),
      });

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: vi.fn().mockRejectedValue(new Error("boom")),
        serialize,
        deserialize,
        storeOptions,
        host,
      });

      expect(result).toBe("stale-data");
      expect(reported).toEqual([]); // not yet — refresh runs in background
      await bgTasks[0]();
      expect(reported).toEqual(["stale-revalidation"]);
    });

    it("reports cache-write when the miss-path write fails", async () => {
      const store = createMockStore(null);
      store.setItem.mockRejectedValue(new Error("write failed"));
      const { host, reported } = reporterHost();

      const result = await readThroughItem({
        ...store,
        key: "k",
        execute: vi.fn(async () => "fresh-data"),
        serialize,
        deserialize,
        storeOptions,
        host,
      });

      expect(result).toBe("fresh-data");
      expect(reported).toEqual(["cache-write"]);
    });
  });
});
