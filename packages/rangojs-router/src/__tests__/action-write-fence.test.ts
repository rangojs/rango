import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar, type CookieJarMock } from "./cookie-jar-mock.js";
import { createNavigationStore } from "../browser/navigation-store.js";
import { registerNavigationStore } from "../browser/navigation-store-handle.js";
import { getRangoState, initRangoState } from "../browser/rango-state.js";
import {
  clearPrefetchCache,
  currentGeneration,
  currentPrefetchEpoch,
} from "../browser/prefetch/cache.js";
import {
  __resetActionFence,
  enterActionFence,
  exitActionFence,
} from "../browser/action-fence.js";

/**
 * The landing of a server action (navigation-store.ts
 * markStaleSoftAndBroadcast) reads the jar its response's Set-Cookie wrote.
 * Real rango state, jar-divergence observer, action fence and prefetch
 * cache: a response that bumped only the write part lands soft (prefetches
 * marked stale: the stale epoch moves, nothing is dropped, the state is
 * kept, and the broadcast is soft and carries the new value); one that
 * rotated the timestamp (invalidateClientCache() on the server seat)
 * flushes the prefetch map and rotates once more.
 */

const NAME = "rango-state_router_0";

describe("an action's landing reads its response's state", () => {
  let jar: CookieJarMock;
  let posted: unknown[];

  beforeEach(() => {
    __resetActionFence();
    posted = [];
    vi.stubGlobal("location", { protocol: "http:" });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/products", pathname: "/products" },
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: unknown = null;
        postMessage(message: unknown): void {
          posted.push(message);
        }
      },
    );
    jar = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", jar.jar);
    initRangoState("v1", NAME);
  });

  afterEach(() => {
    clearPrefetchCache(false);
    vi.unstubAllGlobals();
  });

  const makeStore = () => {
    const store = createNavigationStore({
      crossTabSync: true,
      initialLocation: { href: "http://localhost/products" },
      initialSegmentIds: ["products"],
      initialHistoryKey: "/products",
    });
    registerNavigationStore(store);
    return store;
  };

  it("a write-only bump lands soft: marked stale, nothing flushed, the new value broadcast", () => {
    const store = makeStore();
    const generation = currentGeneration();
    const epoch = currentPrefetchEpoch();

    enterActionFence();
    jar.set(NAME, "v1:100:5000");
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(currentPrefetchEpoch(), "prefetches marked stale").toBe(epoch + 1);
    expect(currentGeneration(), "nothing dropped").toBe(generation);
    expect(getRangoState(), "no rotation").toBe("v1:100:5000");
    expect(posted).toEqual([
      expect.objectContaining({ rangoState: "v1:100:5000", soft: true }),
    ]);
  });

  it("the landing takes a write seen in flight: the fence's drop marks nothing more", () => {
    const store = makeStore();
    const epoch = currentPrefetchEpoch();

    enterActionFence();
    jar.set(NAME, "v1:100:5000");
    getRangoState();
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(currentPrefetchEpoch()).toBe(epoch + 1);
  });

  it("another tab's write seen during an action that does not land marks the caches when the fence drops", () => {
    const store = makeStore();
    store.cacheSegmentsForHistory("/products", []);
    const epoch = currentPrefetchEpoch();

    // A keepClientCache() action in flight; another tab's action bumps the
    // write part, and a prefetch or navigation here reads it.
    enterActionFence();
    jar.set(NAME, "v1:100:5000");
    getRangoState();
    expect(currentPrefetchEpoch(), "nothing marked in flight").toBe(epoch);
    exitActionFence();

    expect(currentPrefetchEpoch()).toBe(epoch + 1);
    expect(store.getCachedSegments("/products")!.stale).toBe(true);
    expect(posted, "no broadcast").toEqual([]);
  });

  it("a rotated timestamp lands hard: the prefetch map is flushed", () => {
    const store = makeStore();
    const generation = currentGeneration();

    enterActionFence();
    jar.set(NAME, "v1:200");
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(currentGeneration(), "the prefetch map flushed").toBe(
      generation + 1,
    );
    // Rotated once more, past the server's value, so other tabs adopt it.
    const rotated = getRangoState();
    expect(Number(rotated.split(":")[1])).toBeGreaterThan(200);
    expect(posted).toEqual([expect.not.objectContaining({ soft: true })]);
  });
});
