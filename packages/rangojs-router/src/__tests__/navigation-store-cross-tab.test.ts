import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  adoptRangoStateMock,
  clearPrefetchCacheMock,
  markPrefetchesStaleMock,
  getRangoStateCookieNameMock,
  getRangoStateMock,
} = vi.hoisted(() => ({
  adoptRangoStateMock: vi.fn(() => true),
  clearPrefetchCacheMock: vi.fn(),
  markPrefetchesStaleMock: vi.fn(),
  getRangoStateCookieNameMock: vi.fn(() => "rango-state_router"),
  getRangoStateMock: vi.fn(() => "build:sender"),
}));

vi.mock("../browser/prefetch/cache.js", () => ({
  clearPrefetchCache: clearPrefetchCacheMock,
  markPrefetchesStale: markPrefetchesStaleMock,
}));

vi.mock("../browser/rango-state.js", () => ({
  adoptRangoState: adoptRangoStateMock,
  getRangoStateCookieName: getRangoStateCookieNameMock,
  getRangoState: getRangoStateMock,
}));

import { createNavigationStore } from "../browser/navigation-store.js";
import {
  __resetActionFence,
  enterActionFence,
  exitActionFence,
  noteStateRotation,
} from "../browser/action-fence.js";

describe("navigation-store cross-tab invalidation", () => {
  let channel: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetActionFence();
    channel = { onmessage: null, postMessage: vi.fn() };
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products",
        pathname: "/products",
      },
    });
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        get onmessage(): ((event: MessageEvent) => void) | null {
          return channel.onmessage;
        }

        set onmessage(listener: ((event: MessageEvent) => void) | null) {
          channel.onmessage = listener;
        }

        postMessage(message: unknown): void {
          channel.postMessage(message);
        }
      },
    );
  });

  const makeStore = (
    initialSegments?: NonNullable<
      Parameters<typeof createNavigationStore>[0]
    >["initialSegments"],
  ) =>
    createNavigationStore({
      crossTabSync: true,
      initialLocation: { href: "http://localhost/products" },
      initialSegmentIds: ["products"],
      initialHistoryKey: "/products",
      initialSegments,
    });

  const receive = (data: Record<string, unknown>): void => {
    channel.onmessage?.({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
        ...data,
      },
    } as MessageEvent);
  };

  it("a server action marks prefetches stale and sends a soft broadcast, rotating nothing", () => {
    const store = makeStore();

    store.markCacheAsStaleAndBroadcast();

    expect(markPrefetchesStaleMock).toHaveBeenCalledOnce();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: "invalidate",
      path: "/products",
      segmentIds: ["products"],
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
      soft: true,
    });
  });

  it("a server action whose response rotated the state flushes, rotates once more and sends the full broadcast", () => {
    const store = makeStore();

    // The response's Set-Cookie reaches the jar during the flight; the
    // jar-divergence observer reports it (navigation-store-handle.ts).
    enterActionFence();
    noteStateRotation();
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();
    // A newer value than the server's, which a tab that already read the
    // jar still adopts.
    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith();
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: "invalidate",
      path: "/products",
      segmentIds: ["products"],
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
    });
  });

  it("one rotation makes one landing of an overlapping batch flush", () => {
    const store = makeStore();

    enterActionFence();
    enterActionFence();
    noteStateRotation();
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(clearPrefetchCacheMock).toHaveBeenCalledOnce();
    expect(markPrefetchesStaleMock).toHaveBeenCalledOnce();
  });

  it("a rotation seen before the action's fence went up does not count", () => {
    const store = makeStore();

    noteStateRotation();
    enterActionFence();
    store.markCacheAsStaleAndBroadcast();
    exitActionFence();

    expect(markPrefetchesStaleMock).toHaveBeenCalledOnce();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();
  });

  it("invalidateClientCache()'s client seat flushes, rotates and sends the full broadcast", () => {
    const store = makeStore();

    store.invalidateCacheAndBroadcast();

    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith();
    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: "invalidate",
      path: "/products",
      segmentIds: ["products"],
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
    });
  });

  it("a newer carried state is adopted before soft is read: full flush without re-rotating", () => {
    makeStore();

    receive({
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
      soft: true,
    });

    expect(adoptRangoStateMock).toHaveBeenCalledWith("build:sender");
    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith(false);
    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();
  });

  it("a soft message whose state is not newer marks prefetches stale, never flushes", () => {
    makeStore();
    adoptRangoStateMock.mockReturnValueOnce(false);

    receive({
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
      soft: true,
    });

    expect(markPrefetchesStaleMock).toHaveBeenCalledOnce();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();
  });

  it("an unmarked message whose state is not newer flushes and rotates locally", () => {
    makeStore();
    adoptRangoStateMock.mockReturnValueOnce(false);

    receive({
      rangoState: "build:older",
      stateCookieName: "rango-state_router",
    });

    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith(true);
    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();
  });

  it("every branch marks history stale and refreshes the page", () => {
    const store = makeStore([
      {
        id: "products",
        namespace: "",
        type: "route",
        index: 0,
        component: null,
        params: {},
      },
    ]);
    const refresh = vi.fn();
    store.setCrossTabRefreshCallback(refresh);

    for (const [adopted, soft] of [
      [true, true],
      [false, true],
      [false, false],
    ] as const) {
      store.cacheSegmentsForHistory("/products", [], {});
      adoptRangoStateMock.mockReturnValueOnce(adopted);
      receive({
        rangoState: "build:sender",
        stateCookieName: "rango-state_router",
        ...(soft && { soft: true }),
      });
      expect(store.getCachedSegments("/products")?.stale).toBe(true);
    }
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("ignores another router's message and keeps the old sender's flush", () => {
    makeStore();

    receive({
      rangoState: "other:state",
      stateCookieName: "rango-state_other-router",
      soft: true,
    });
    expect(adoptRangoStateMock).not.toHaveBeenCalled();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();
    expect(markPrefetchesStaleMock).not.toHaveBeenCalled();

    // An already-open tab running an older sender carries no state.
    receive({});
    expect(adoptRangoStateMock).not.toHaveBeenCalled();
    expect(clearPrefetchCacheMock).toHaveBeenCalledExactlyOnceWith();
  });
});
