import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeJar, type CookieJarMock } from "./cookie-jar-mock.js";

const { clearPrefetchCacheMock, markPrefetchesStaleMock } = vi.hoisted(() => ({
  clearPrefetchCacheMock: vi.fn(),
  markPrefetchesStaleMock: vi.fn(),
}));

vi.mock("../browser/prefetch/cache.js", () => ({
  clearPrefetchCache: clearPrefetchCacheMock,
  markPrefetchesStale: markPrefetchesStaleMock,
}));

import { createNavigationStore } from "../browser/navigation-store.js";
import { registerNavigationStore } from "../browser/navigation-store-handle.js";
import { initRangoState } from "../browser/rango-state.js";
import {
  __resetActionFence,
  enterActionFence,
  exitActionFence,
} from "../browser/action-fence.js";

/**
 * The landing of a server action (navigation-store.ts
 * markStaleSoftAndBroadcast) reads the jar its response's Set-Cookie wrote.
 * Real rango state, jar-divergence observer and action fence: a response
 * that bumped only the write part lands soft (prefetches marked stale, a
 * soft broadcast carrying the new value); one that rotated the timestamp
 * (invalidateClientCache() on the server seat) flushes.
 */

const NAME = "rango-state_router_0";

describe("an action's landing reads its response's state", () => {
  let jar: CookieJarMock;
  let channel: { postMessage: (message: unknown) => void };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetActionFence();
    channel = { postMessage: vi.fn() };
    vi.stubGlobal("location", { protocol: "http:" });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/products", pathname: "/products" },
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: unknown = null;
        postMessage(message: unknown): void {
          channel.postMessage(message);
        }
      },
    );
    jar = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", jar.jar);
    initRangoState("v1", NAME);
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

    enterActionFence();
    jar.set(NAME, "v1:100:5000");
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(markPrefetchesStaleMock).toHaveBeenCalledOnce();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ rangoState: "v1:100:5000", soft: true }),
    );
  });

  it("a rotated timestamp lands hard: the prefetch map is flushed", () => {
    const store = makeStore();

    enterActionFence();
    jar.set(NAME, "v1:200");
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith();
    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ soft: true }),
    );
  });
});
