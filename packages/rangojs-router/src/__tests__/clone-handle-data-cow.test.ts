import { describe, it, expect } from "vitest";
import {
  cloneHandleData,
  createNavigationStore,
} from "../browser/navigation-store";
import type { HandleData } from "../browser/types";

// crossTabSync:false avoids BroadcastChannel; initialLocation avoids window.
function createTestStore(
  overrides?: Parameters<typeof createNavigationStore>[0],
) {
  return createNavigationStore({
    initialLocation: { href: "http://localhost/" },
    crossTabSync: false,
    ...overrides,
  });
}

describe("cloneHandleData (container-only clone, shared arrays)", () => {
  it("creates fresh containers but shares the bucket arrays by reference", () => {
    const bucket = [{ title: "A" }];
    const src: HandleData = { meta: { s1: bucket } };

    const cloned = cloneHandleData(src);

    // Top-level and segment-map containers are fresh (decoupled).
    expect(cloned).not.toBe(src);
    expect(cloned.meta).not.toBe(src.meta);
    // The bucket array itself is SHARED — skips the O(elements) copy. Safe
    // because buckets are replaced wholesale, never mutated in place.
    expect(cloned.meta.s1).toBe(bucket);
    // Deep structural equality still holds.
    expect(cloned).toEqual(src);
  });

  it("decouples container mutations: adding/deleting source keys never leaks into the clone", () => {
    const bucket = [{ title: "A" }];
    const src: HandleData = { meta: { s1: bucket } };
    const cloned = cloneHandleData(src);

    // Add a new segment key to the source container.
    src.meta.s2 = [{ title: "B" }];
    expect(cloned.meta.s2).toBeUndefined();

    // Delete a segment key from the source container.
    delete src.meta.s1;
    expect(cloned.meta.s1).toBe(bucket);

    // Add a whole new handle to the source.
    src.crumbs = { s1: [{ label: "Home" }] };
    expect(cloned.crumbs).toBeUndefined();
  });
});

describe("updateCacheHandleDataIfOwned", () => {
  it("writes when the entry is still owned by ownerInstance", () => {
    const store = createTestStore();
    store.cacheSegmentsForHistory("/p", [], { a: { s1: [1] } });
    const owner = store.getNavInstance();

    store.updateCacheHandleDataIfOwned("/p", { b: { s2: [2] } }, owner);

    expect(store.getCachedSegments("/p")!.handleData).toEqual({
      b: { s2: [2] },
    });
  });

  it("is a no-op when ownerInstance does not match (a newer same-URL visit)", () => {
    const store = createTestStore();
    store.cacheSegmentsForHistory("/p", [], { a: { s1: [1] } });
    const owner = store.getNavInstance();

    store.updateCacheHandleDataIfOwned("/p", { b: { s2: [2] } }, owner + 999);

    // Unchanged — a stale nav must not clobber the current entry.
    expect(store.getCachedSegments("/p")!.handleData).toEqual({
      a: { s1: [1] },
    });
  });

  it("is a no-op (no throw) for a missing entry", () => {
    const store = createTestStore();
    expect(() =>
      store.updateCacheHandleDataIfOwned("/missing", { a: { s1: [1] } }, 1),
    ).not.toThrow();
    expect(store.getCachedSegments("/missing")).toBeUndefined();
  });

  it("sets stale + handlesPending, then preserves them when the flags are omitted", () => {
    const store = createTestStore();
    store.cacheSegmentsForHistory("/q", [], { a: { s1: [1] } });
    const owner = store.getNavInstance();

    store.updateCacheHandleDataIfOwned(
      "/q",
      { a: { s1: [2] } },
      owner,
      true,
      true,
    );
    let cached = store.getCachedSegments("/q")!;
    expect(cached.handleData).toEqual({ a: { s1: [2] } });
    expect(cached.stale).toBe(true);
    expect(cached.handlesPending).toBe(true);

    // Omitting the flags preserves the current stale / handlesPending bits.
    store.updateCacheHandleDataIfOwned("/q", { a: { s1: [3] } }, owner);
    cached = store.getCachedSegments("/q")!;
    expect(cached.handleData).toEqual({ a: { s1: [3] } });
    expect(cached.stale).toBe(true);
    expect(cached.handlesPending).toBe(true);
  });

  it("preserves the entry's nav-instance token (ownership survives repeated writes)", () => {
    const store = createTestStore();
    store.cacheSegmentsForHistory("/p", [], { a: { s1: [1] } });
    const owner = store.getNavInstance();

    store.updateCacheHandleDataIfOwned("/p", { a: { s1: [2] } }, owner);
    expect(store.getNavInstance()).toBe(owner);
    store.updateCacheHandleDataIfOwned("/p", { a: { s1: [3] } }, owner);
    expect(store.getCachedSegments("/p")!.handleData).toEqual({
      a: { s1: [3] },
    });
  });
});
