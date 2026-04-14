import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerRedirect } from "../errors";

const { fetchPartialUpdateMock, createNavigationTransactionMock } = vi.hoisted(
  () => ({
    fetchPartialUpdateMock: vi.fn(),
    createNavigationTransactionMock: vi.fn(),
  }),
);

vi.mock("../browser/partial-update.js", () => ({
  createPartialUpdater: vi.fn(() => fetchPartialUpdateMock),
}));

vi.mock("../browser/navigation-transaction.js", () => ({
  resolveNavigationState: vi.fn((state: unknown) => state),
  createNavigationTransaction: vi.fn((...args: unknown[]) =>
    createNavigationTransactionMock(...args),
  ),
}));

import { createNavigationBridge } from "../browser/navigation-bridge";

function createStore() {
  return {
    getHistoryKey: vi.fn(() => "http://localhost/current"),
    getCachedSegments: vi.fn((): any => undefined),
    hasHistoryCache: vi.fn(() => false),
    cacheSegmentsForHistory: vi.fn(),
    setInterceptSourceUrl: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
    setHistoryKey: vi.fn(),
    setCurrentUrl: vi.fn(),
    getInterceptSourceUrl: vi.fn((): string | null => null),
  };
}

function createEventController() {
  return {
    abortNavigation: vi.fn(),
    getHandleState: vi.fn(() => ({ data: {} })),
  };
}

describe("navigation-bridge revalidate: false", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  it("skips server fetch for same-pathname search param change", async () => {
    const pushState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products?color=red",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState,
        replaceState: vi.fn(),
      },
    });

    const store = createStore();
    store.getHistoryKey.mockReturnValue("http://localhost/products?color=red");
    store.getCachedSegments.mockReturnValue({
      segments: [{ id: "root", type: "layout" }] as any,
    });

    const setLocation = vi.fn();
    const eventController = {
      ...createEventController(),
      setLocation,
    };

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue", { revalidate: false });

    // No server fetch should have been made
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(createNavigationTransactionMock).not.toHaveBeenCalled();

    // URL should have been updated via pushState
    expect(pushState).toHaveBeenCalledWith(
      expect.any(Object),
      "",
      "/products?color=blue",
    );

    // Event controller should have been notified with new location
    expect(setLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/products",
        search: "?color=blue",
      }),
    );

    // Segments should have been cached for the new history key
    expect(store.cacheSegmentsForHistory).toHaveBeenCalled();
  });

  it("uses replaceState when replace: true with revalidate: false", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products?page=1",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState,
      },
    });

    const store = createStore();
    store.getCachedSegments.mockReturnValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        ...createEventController(),
        setLocation: vi.fn(),
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?page=2", {
      revalidate: false,
      replace: true,
    });

    expect(replaceState).toHaveBeenCalledWith(
      expect.any(Object),
      "",
      "/products?page=2",
    );
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("falls through to full navigation when pathname changes", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });

    const store = createStore();
    const tx = {
      handle: { signal: new AbortController().signal },
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    };
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/categories?color=blue", { revalidate: false });

    // Should have fallen through to full navigation
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(createNavigationTransactionMock).toHaveBeenCalled();
  });

  it("does full navigation when revalidate is not set", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products?color=red",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });

    const store = createStore();
    const tx = {
      handle: { signal: new AbortController().signal },
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    };
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue");

    // Default behavior: full navigation with server fetch
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("dispatches __rsc_locationstate when state is passed with revalidate: false", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products?color=red",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState: vi.fn(),
        scrollRestoration: "manual",
      },
      dispatchEvent,
      scrollTo: vi.fn(),
    });

    const store = createStore();
    store.getCachedSegments.mockReturnValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        ...createEventController(),
        setLocation: vi.fn(),
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue", {
      revalidate: false,
      state: { from: "filter" },
    });

    // __rsc_locationstate should have been dispatched for useLocationState()
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "__rsc_locationstate" }),
    );
  });

  it("preserves intercept context in history state and cache key", async () => {
    const pushState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/product/123?tab=reviews",
        origin: "http://localhost",
      },
      history: {
        // Current entry is an intercept
        state: { intercept: true, sourceUrl: "http://localhost/products" },
        pushState,
        replaceState: vi.fn(),
        scrollRestoration: "manual",
      },
      dispatchEvent: vi.fn(),
      scrollTo: vi.fn(),
    });

    const store = createStore();
    store.getHistoryKey.mockReturnValue(
      "http://localhost/product/123?tab=reviews:intercept",
    );
    store.getCachedSegments.mockReturnValue({
      segments: [{ id: "root", type: "layout" }] as any,
    });

    const setLocation = vi.fn();
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        ...createEventController(),
        setLocation,
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/product/123?tab=specs", { revalidate: false });

    // No server fetch
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();

    // History state should carry intercept info
    expect(pushState).toHaveBeenCalledWith(
      expect.objectContaining({
        intercept: true,
        sourceUrl: "http://localhost/products",
      }),
      "",
      "/product/123?tab=specs",
    );

    // Store history key should include :intercept suffix
    expect(store.setHistoryKey).toHaveBeenCalledWith(
      expect.stringContaining("intercept"),
    );
  });

  it("does not dispatch __rsc_locationstate when no state is involved", async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/products?color=red",
        origin: "http://localhost",
      },
      history: {
        state: null,
        pushState: vi.fn(),
        replaceState: vi.fn(),
        scrollRestoration: "manual",
      },
      dispatchEvent,
      scrollTo: vi.fn(),
    });

    const store = createStore();
    store.getCachedSegments.mockReturnValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        ...createEventController(),
        setLocation: vi.fn(),
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue", { revalidate: false });

    // No state involved — should not dispatch
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

describe("navigation-bridge redirect validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  it("blocks cross-origin ServerRedirect in navigate catch path", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/current",
        origin: "http://localhost",
      },
      history: {
        state: {},
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const tx = {
      handle: { signal: new AbortController().signal },
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    };
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockRejectedValue(
      new ServerRedirect("https://evil.example/phish", undefined),
    );

    const bridge = createNavigationBridge({
      store: createStore() as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await expect(bridge.navigate("/target")).resolves.toBeUndefined();
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to hard navigation for cross-origin navigate()", async () => {
    const location = {
      href: "http://localhost/current",
      origin: "http://localhost",
    };
    vi.stubGlobal("window", {
      location,
      history: {
        state: {},
      },
    });

    const tx = {
      handle: { signal: new AbortController().signal },
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    };
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    const bridge = createNavigationBridge({
      store: createStore() as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await expect(
      bridge.navigate("https://example.com/account"),
    ).resolves.toBeUndefined();

    expect(location.href).toBe("https://example.com/account");
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(createNavigationTransactionMock).not.toHaveBeenCalled();
  });

  it("blocks non-http schemes in cross-origin navigate()", async () => {
    const location = {
      href: "http://localhost/current",
      origin: "http://localhost",
    };
    vi.stubGlobal("window", {
      location,
      history: {
        state: {},
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const bridge = createNavigationBridge({
      store: createStore() as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await expect(
      bridge.navigate("javascript:alert(1)"),
    ).resolves.toBeUndefined();

    // location.href should NOT have been changed
    expect(location.href).toBe("http://localhost/current");
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("handles malformed URL without throwing", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/current",
        origin: "http://localhost",
      },
      history: {
        state: {},
      },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const bridge = createNavigationBridge({
      store: createStore() as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    // Malformed URL — new URL("http://[", base) throws without the guard
    await expect(bridge.navigate("http://[")).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("malformed URL"),
    );
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(createNavigationTransactionMock).not.toHaveBeenCalled();
  });
});

describe("navigation-bridge stale cache handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  it("sets skipLoadingState: false when cache is stale", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });

    const store = createStore();
    // Cache exists but is marked stale (server action invalidated it)
    store.getCachedSegments.mockReturnValue({
      segments: [{ id: "L0", type: "layout" }] as any,
      stale: true,
      handleData: {},
    });

    function makeTx() {
      return {
        handle: { signal: new AbortController().signal },
        commit: vi.fn(),
        with: vi.fn(() => ({})),
        [Symbol.dispose]: vi.fn(),
      };
    }

    const tx = makeTx();
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/details");

    // Stale cache: skipLoadingState must be false so useNavigation shows loading
    expect(createNavigationTransactionMock).toHaveBeenCalled();
    const options = createNavigationTransactionMock.mock.calls[0][3];
    expect(options.skipLoadingState).toBe(false);
  });

  it("sets skipLoadingState: false even when cache is fresh (forward nav always waits)", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/",
        origin: "http://localhost",
      },
      history: {
        state: {},
        pushState: vi.fn(),
        replaceState: vi.fn(),
      },
    });

    const store = createStore();
    store.getCachedSegments.mockReturnValue({
      segments: [{ id: "L0", type: "layout" }] as any,
      stale: false,
      handleData: {},
    });

    function makeTx() {
      return {
        handle: { signal: new AbortController().signal },
        commit: vi.fn(),
        with: vi.fn(() => ({})),
        [Symbol.dispose]: vi.fn(),
      };
    }

    const tx = makeTx();
    createNavigationTransactionMock.mockReturnValue(tx);
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/details");

    // Forward nav always waits on fetch — loading state must be shown
    expect(createNavigationTransactionMock).toHaveBeenCalled();
    const options = createNavigationTransactionMock.mock.calls[0][3];
    expect(options.skipLoadingState).toBe(false);
  });
});

describe("navigation-bridge handlePopstate intercept exit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  it("passes leave-intercept mode when popstate exits intercept on a cache-miss URL", async () => {
    // Simulate popstate to a non-intercept history entry whose URL isn't
    // cached (e.g., the pre-intercept /shop?page=5 was evicted). Without the
    // mode, partial-update hits the empty-diff "no changes" branch and the
    // modal stays on screen.
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/shop?page=5",
        origin: "http://localhost",
      },
      history: { state: {} }, // no intercept flag on new entry
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const store = createStore();
    // Simulate that we were previously inside an intercept
    store.getInterceptSourceUrl.mockReturnValue("http://localhost/shop?page=5");
    store.getCachedSegments.mockReturnValue(undefined); // cache miss

    const eventController = {
      ...createEventController(),
      setLocation: vi.fn(),
      abortAllActions: vi.fn(),
      getState: vi.fn(() => ({ isStreaming: false })),
      setParams: vi.fn(),
    };

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    createNavigationTransactionMock.mockReturnValue({
      handle: { signal: undefined },
      with: (overrides: Record<string, unknown>) => ({
        ...overrides,
        handle: { signal: undefined },
      }),
      [Symbol.dispose]: vi.fn(),
    });

    await bridge.handlePopstate();

    expect(fetchPartialUpdateMock).toHaveBeenCalled();
    const mode = fetchPartialUpdateMock.mock.calls[0][5];
    expect(mode).toEqual({ type: "leave-intercept" });
  });

  it("passes undefined mode for ordinary popstate with no intercept history", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/shop?page=4",
        origin: "http://localhost",
      },
      history: { state: {} },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const store = createStore();
    store.getInterceptSourceUrl.mockReturnValue(null); // no prior intercept
    store.getCachedSegments.mockReturnValue(undefined);

    const eventController = {
      ...createEventController(),
      setLocation: vi.fn(),
      abortAllActions: vi.fn(),
      getState: vi.fn(() => ({ isStreaming: false })),
      setParams: vi.fn(),
    };

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    createNavigationTransactionMock.mockReturnValue({
      handle: { signal: undefined },
      with: (overrides: Record<string, unknown>) => ({
        ...overrides,
        handle: { signal: undefined },
      }),
      [Symbol.dispose]: vi.fn(),
    });

    await bridge.handlePopstate();

    expect(fetchPartialUpdateMock).toHaveBeenCalled();
    const mode = fetchPartialUpdateMock.mock.calls[0][5];
    expect(mode).toBeUndefined();
  });
});
