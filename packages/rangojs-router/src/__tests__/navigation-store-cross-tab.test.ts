import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  adoptRangoStateMock,
  clearPrefetchCacheMock,
  getRangoStateCookieNameMock,
  getRangoStateMock,
} = vi.hoisted(() => ({
  adoptRangoStateMock: vi.fn(() => true),
  clearPrefetchCacheMock: vi.fn(),
  getRangoStateCookieNameMock: vi.fn(() => "rango-state_router"),
  getRangoStateMock: vi.fn(() => "build:sender"),
}));

vi.mock("../browser/prefetch/cache.js", () => ({
  clearPrefetchCache: clearPrefetchCacheMock,
}));

vi.mock("../browser/rango-state.js", () => ({
  adoptRangoState: adoptRangoStateMock,
  getRangoStateCookieName: getRangoStateCookieNameMock,
  getRangoState: getRangoStateMock,
}));

import { createNavigationStore } from "../browser/navigation-store.js";

describe("navigation-store cross-tab invalidation", () => {
  let channel: {
    onmessage: ((event: MessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
  };

  beforeEach(() => {
    vi.clearAllMocks();
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

  it("broadcasts one state and adopts it without re-rotating on receipt", () => {
    const store = createNavigationStore({
      crossTabSync: true,
      initialLocation: { href: "http://localhost/products" },
      initialSegmentIds: ["products"],
    });

    store.markCacheAsStaleAndBroadcast();

    expect(clearPrefetchCacheMock).toHaveBeenCalledOnce();
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: "invalidate",
      path: "/products",
      segmentIds: ["products"],
      rangoState: "build:sender",
      stateCookieName: "rango-state_router",
    });

    clearPrefetchCacheMock.mockClear();
    channel.onmessage?.({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
        rangoState: "build:sender",
        stateCookieName: "rango-state_router",
      },
    } as MessageEvent);

    expect(adoptRangoStateMock).toHaveBeenCalledWith("build:sender");
    expect(clearPrefetchCacheMock).toHaveBeenCalledWith(false);

    adoptRangoStateMock.mockReturnValueOnce(false);
    clearPrefetchCacheMock.mockClear();
    channel.onmessage?.({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
        rangoState: "build:older",
        stateCookieName: "rango-state_router",
      },
    } as MessageEvent);

    expect(clearPrefetchCacheMock).toHaveBeenCalledWith(true);

    adoptRangoStateMock.mockClear();
    clearPrefetchCacheMock.mockClear();
    channel.onmessage?.({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
        rangoState: "other:state",
        stateCookieName: "rango-state_other-router",
      },
    } as MessageEvent);

    expect(adoptRangoStateMock).not.toHaveBeenCalled();
    expect(clearPrefetchCacheMock).not.toHaveBeenCalled();

    adoptRangoStateMock.mockClear();
    clearPrefetchCacheMock.mockClear();
    channel.onmessage?.({
      data: {
        type: "invalidate",
        path: "/products",
        segmentIds: ["products"],
      },
    } as MessageEvent);

    expect(adoptRangoStateMock).not.toHaveBeenCalled();
    expect(clearPrefetchCacheMock).toHaveBeenCalledOnce();
    expect(clearPrefetchCacheMock).toHaveBeenCalledWith();
  });
});
