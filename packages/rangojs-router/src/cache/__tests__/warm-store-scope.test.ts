/**
 * resolveWarmStoreScope (cache/store-scope.ts): the scope router.prerender()
 * gates a warm on. A store's own declaration decides, with one exception: a
 * MemorySegmentCacheStore under the Vite dev server, whose one process serves
 * every request. store-scope.test.ts pins what each shipped store declares.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MemorySegmentCacheStore } from "../memory-segment-store.js";
import { isViteDevServer, resolveWarmStoreScope } from "../store-scope.js";
import type { SegmentCacheStore } from "../types.js";

const inner = new MemorySegmentCacheStore();

/** A custom store: the contract's required methods and whatever scope it declares. */
function customStore(scope?: unknown): SegmentCacheStore {
  return {
    get: (key) => inner.get(key),
    set: (key, data, ttl, swr) => inner.set(key, data, ttl, swr),
    delete: (key) => inner.delete(key),
    ...(scope !== undefined ? { scope } : {}),
  } as SegmentCacheStore;
}

afterEach(() => {
  delete (globalThis as { __PRERENDER_DEV_URL?: string }).__PRERENDER_DEV_URL;
});

describe("resolveWarmStoreScope", () => {
  it("returns a declared global or regional scope", () => {
    expect(resolveWarmStoreScope(customStore("global"), false)).toBe("global");
    expect(resolveWarmStoreScope(customStore("regional"), false)).toBe(
      "regional",
    );
  });

  it("treats a store that declares nothing as local", () => {
    expect(resolveWarmStoreScope(customStore(), false)).toBe("local");
    // The dev exception is the memory store's alone.
    expect(resolveWarmStoreScope(customStore(), true)).toBe("local");
  });

  it("treats a value the router does not know as local", () => {
    // A custom store whose unrelated `scope` member predates the contract.
    expect(resolveWarmStoreScope(customStore("tenant-a"), true)).toBe("local");
    expect(resolveWarmStoreScope(customStore(true), true)).toBe("local");
  });

  it("MemorySegmentCacheStore is local in production", () => {
    expect(resolveWarmStoreScope(new MemorySegmentCacheStore(), false)).toBe(
      "local",
    );
  });

  it("MemorySegmentCacheStore({ scope: global }) is global in production", () => {
    const store = new MemorySegmentCacheStore({ scope: "global" });

    expect(resolveWarmStoreScope(store, false)).toBe("global");
    expect(resolveWarmStoreScope(store, true)).toBe("global");
  });

  it("MemorySegmentCacheStore counts as shared under the Vite dev server", () => {
    const store = new MemorySegmentCacheStore();

    expect(resolveWarmStoreScope(store, true)).toBe("global");
    // The declaration itself does not move: only the warm gate reads the rule.
    expect(store.scope).toBe("local");
  });

  it("a memory store subclass that declares a scope keeps it in both modes", () => {
    class SharedMemoryStore extends MemorySegmentCacheStore {
      readonly scope = "global" as const;
    }
    class RegionalMemoryStore extends MemorySegmentCacheStore {
      readonly scope = "regional" as const;
    }

    expect(resolveWarmStoreScope(new SharedMemoryStore(), false)).toBe(
      "global",
    );
    expect(resolveWarmStoreScope(new RegionalMemoryStore(), true)).toBe(
      "regional",
    );
  });

  it("reads the dev server from the origin the routes-manifest module sets", () => {
    const store = new MemorySegmentCacheStore();

    expect(isViteDevServer()).toBe(false);
    expect(resolveWarmStoreScope(store)).toBe("local");

    globalThis.__PRERENDER_DEV_URL = "http://localhost:5173";
    expect(isViteDevServer()).toBe(true);
    expect(resolveWarmStoreScope(store)).toBe("global");
  });
});
