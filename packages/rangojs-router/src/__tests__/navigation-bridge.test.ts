import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerRedirect } from "../errors";

const { fetchPartialUpdateMock, createNavigationTransactionMock } = vi.hoisted(
  () => ({
    fetchPartialUpdateMock: vi.fn(),
    createNavigationTransactionMock: vi.fn(),
  }),
);

vi.mock("../browser/partial-update.js", () => ({
  createPartialUpdater: vi.fn(() => fetchPartialUpdateMock),
  shouldStartViewTransition: vi.fn(() => false),
}));

vi.mock("../browser/navigation-transaction.js", () => ({
  resolveNavigationState: vi.fn((state: unknown) => state),
  createNavigationTransaction: vi.fn((...args: unknown[]) =>
    createNavigationTransactionMock(...args),
  ),
}));

import { createNavigationBridge } from "../browser/navigation-bridge";
import { actionBoundaries } from "../browser/segment-reconciler";
import { __resetActionFence, enterActionFence } from "../browser/action-fence";
import {
  initRangoState,
  setRangoStateObserver,
  setRangoStateWriteObserver,
} from "../browser/rango-state";
import { registerNavigationStore } from "../browser/navigation-store-handle";
import { makeJar, type CookieJarMock } from "./cookie-jar-mock.js";

function createStore() {
  return {
    getHistoryKey: vi.fn(() => "http://localhost/current"),
    rememberDisplayedEntry: vi.fn(),
    getHistoryEntryMemory: vi.fn(() => undefined),
    getCachedSegments: vi.fn((_key: string): any => undefined),
    hasInterceptCache: vi.fn(() => false),
    cacheSegmentsForHistory: vi.fn(),
    updateCacheHandleData: vi.fn(),
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
    getHydrationSnapshot: vi.fn(() => undefined),
    commitLocationState: vi.fn(),
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

  // A shallow navigation pushes an entry and commits no tree: its location
  // state reaches readers through the controller, next to the location
  // notification (#1029). No window event carries it.
  it("commits the pushed entry's location state with revalidate: false", async () => {
    const dispatchEvent = vi.fn();
    const order: string[] = [];
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
    const pushState = vi.mocked(window.history.pushState);
    pushState.mockImplementation(() => void order.push("pushState"));
    const commitLocationState = vi.fn(() => void order.push("commit"));

    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: {
        ...createEventController(),
        commitLocationState,
        setLocation: vi.fn(() => void order.push("setLocation")),
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue", {
      revalidate: false,
      state: { from: "filter" },
    });

    // After the entry exists, as a treeless commit of the pushed state: no
    // payload follows a shallow navigation, so the provider takes it with
    // the location notification.
    expect(order).toEqual(["pushState", "commit", "setLocation"]);
    expect(commitLocationState).toHaveBeenCalledExactlyOnceWith(
      { state: { from: "filter" } },
      true,
    );
    expect(dispatchEvent).not.toHaveBeenCalled();
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
      "/product/123?tab=reviews:intercept:/products",
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

    // Store history key names the intercept's source page
    expect(store.setHistoryKey).toHaveBeenCalledWith(
      "/product/123?tab=specs:intercept:/products",
    );
  });

  // A push without state starts an entry with no location state: a mounted
  // reader has to drop the value of the entry being left, so the commit is
  // not conditional on either entry carrying state.
  it("commits with revalidate: false when no state is involved", async () => {
    const dispatchEvent = vi.fn();
    const commitLocationState = vi.fn();
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
        commitLocationState,
        setLocation: vi.fn(),
      } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/products?color=blue", { revalidate: false });

    expect(commitLocationState).toHaveBeenCalledExactlyOnceWith(null, true);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });
});

// #1029: location state is committed by the transaction's commit and nowhere
// else on this path. A navigation that never reaches it carried `state` for
// nothing: no entry is pushed and no reader hears of it, whether the bridge
// renders an error boundary or drops the navigation.
describe("navigation-bridge location state on a navigation that does not commit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  it.each([
    {
      label: "a network failure",
      error: new TypeError("Failed to fetch"),
      aborted: false,
      boundaryUpdates: 1,
    },
    {
      label: "an unprocessable response",
      error: new Error("undecodable Flight body"),
      aborted: false,
      boundaryUpdates: 1,
    },
    {
      label: "a navigation superseded by another",
      error: new DOMException("Navigation aborted", "AbortError"),
      aborted: true,
      boundaryUpdates: 0,
    },
  ])(
    "$label commits no location state",
    async ({ error, aborted, boundaryUpdates }) => {
      const pushState = vi.fn();
      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        location: {
          href: "http://localhost/current",
          origin: "http://localhost",
        },
        history: { state: { key: "k1" }, pushState, replaceState },
        dispatchEvent: vi.fn(),
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const abort = new AbortController();
      if (aborted) abort.abort();
      createNavigationTransactionMock.mockReturnValue({
        handle: { signal: abort.signal },
        with: vi.fn(() => ({})),
        [Symbol.dispose]: vi.fn(),
      });
      fetchPartialUpdateMock.mockRejectedValue(error);
      const eventController = createEventController();
      const onUpdate = vi.fn();

      const bridge = createNavigationBridge({
        store: createStore() as any,
        client: {} as any,
        eventController: eventController as any,
        onUpdate,
        renderSegments: vi.fn(async () => "tree"),
      });
      await bridge.navigate("/target", { state: { from: "list" } });

      expect(eventController.commitLocationState).not.toHaveBeenCalled();
      expect(pushState).not.toHaveBeenCalled();
      expect(replaceState).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalledTimes(boundaryUpdates);
    },
  );
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

describe("navigation-bridge link to an entry whose cached list holds an error boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  /** A link to /page while its entry caches `segments`, fresh. */
  async function linkTo(segments: unknown[]) {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/other", origin: "http://localhost" },
      history: { state: {}, pushState: vi.fn(), replaceState: vi.fn() },
    });
    const store = createStore();
    store.getCachedSegments.mockImplementation((key: string) =>
      key === "http://localhost/current"
        ? undefined
        : { segments, stale: false, handleData: {} },
    );
    createNavigationTransactionMock.mockReturnValue({
      handle: { signal: new AbortController().signal },
      commit: vi.fn(),
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    });
    fetchPartialUpdateMock.mockResolvedValue(undefined);
    await createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    }).navigate("/page");
    const [, segmentIds, , , , mode] = fetchPartialUpdateMock.mock.calls[0]!;
    return { segmentIds, mode };
  }

  it("does not hold the list: the request holds the page on screen, so the route the error replaced renders again", async () => {
    const { segmentIds, mode } = await linkTo([
      { id: "L0", type: "layout" },
      { id: "L0R0D0.item", type: "loader" },
      { id: "L0R0", type: "error" },
    ]);
    expect(segmentIds).toBeUndefined();
    expect(mode).toEqual({
      type: "navigate",
      onStalePrefetch: expect.any(Function),
    });
  });

  it("a parallel slot's error segment, the list's only one, also keeps the link from holding it", async () => {
    const { segmentIds, mode } = await linkTo([
      { id: "L0", type: "layout" },
      { id: "L0.@side", type: "error" },
      { id: "L0R0", type: "route" },
    ]);
    expect(segmentIds).toBeUndefined();
    expect(mode).toEqual({
      type: "navigate",
      onStalePrefetch: expect.any(Function),
    });
  });

  it("control: a list without one is held, as before", async () => {
    const { segmentIds, mode } = await linkTo([
      { id: "L0", type: "layout" },
      { id: "L0R0", type: "route" },
    ]);
    expect(segmentIds).toEqual(["L0", "L0R0"]);
    expect(mode).toMatchObject({ type: "navigate" });
    expect(mode.targetCacheSegments).toHaveLength(2);
  });
});

describe("navigation-bridge link to a history entry after another tab's write", () => {
  const NAME = "rango-state_router_0";
  let jar: CookieJarMock;
  let stale: boolean;

  beforeEach(() => {
    __resetActionFence();
    stale = false;
    jar = makeJar({ [NAME]: "v1:100" });
    vi.stubGlobal("document", jar.jar);
    vi.stubGlobal("location", { protocol: "http:" });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/other", origin: "http://localhost" },
      history: { state: {}, pushState: vi.fn(), replaceState: vi.fn() },
    });
    initRangoState("v1", NAME);
    // The write observer marks the entry stale, as the navigation store's
    // markCachesStaleAfterWrite does.
    registerNavigationStore({
      markHistoryCacheStale: vi.fn(),
      markCachesStaleAfterWrite: () => {
        stale = true;
      },
    } as never);
  });

  afterEach(() => {
    setRangoStateObserver(null);
    setRangoStateWriteObserver(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  /** A link to /page, whose entry caches a layout and its route. */
  async function linkToCachedPage() {
    const store = createStore();
    store.getCachedSegments.mockImplementation((key: string) =>
      key === "http://localhost/current"
        ? undefined
        : {
            segments: [
              { id: "L0", type: "layout" },
              { id: "L0R0", type: "route" },
            ],
            stale,
            handleData: {},
          },
    );
    createNavigationTransactionMock.mockReturnValue({
      handle: { signal: new AbortController().signal },
      commit: vi.fn(),
      with: vi.fn(() => ({})),
      [Symbol.dispose]: vi.fn(),
    });
    fetchPartialUpdateMock.mockResolvedValue(undefined);
    await createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: createEventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    }).navigate("/page");
    const [, segmentIds, , , , mode] = fetchPartialUpdateMock.mock.calls[0]!;
    return { segmentIds, mode };
  }

  it("reads the state before the entry's stale bit: the write marks it, so the link does not hold its ids", async () => {
    // Another tab's action bumped the write part in the shared jar, and no
    // broadcast reached this tab: the read is the only way it learns.
    jar.set(NAME, "v1:100:5000");
    const { segmentIds, mode } = await linkToCachedPage();
    expect(segmentIds).toBeUndefined();
    expect(mode).not.toHaveProperty("targetCacheSegments");
    expect(stale, "the write observer ran").toBe(true);
  });

  it("control: with no write since the last read, the fresh entry is held", async () => {
    const { segmentIds, mode } = await linkToCachedPage();
    expect(stale).toBe(false);
    expect(segmentIds).toEqual(["L0", "L0R0"]);
    expect(mode.targetCacheSegments).toHaveLength(2);
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
      handle: { signal: new AbortController().signal },
      with: (overrides: Record<string, unknown>) => ({
        ...overrides,
        handle: { signal: new AbortController().signal },
      }),
      [Symbol.dispose]: vi.fn(),
    });

    await bridge.handlePopstate();

    expect(fetchPartialUpdateMock).toHaveBeenCalled();
    const mode = fetchPartialUpdateMock.mock.calls[0][5];
    expect(mode).toEqual({ type: "leave-intercept" });
  });

  it("keeps in-flight actions running when Back leaves an intercept", async () => {
    // An action whose modal closes before its response is an ordinary
    // navigate-away: its caller gets its result, and its exit owes the page
    // underneath the follow-up (server-action-bridge.ts followUp).
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/shop",
        origin: "http://localhost",
      },
      history: { state: {} },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const store = createStore();
    store.getInterceptSourceUrl.mockReturnValue("http://localhost/shop");
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
      handle: { signal: new AbortController().signal },
      with: (overrides: Record<string, unknown>) => ({
        ...overrides,
        handle: { signal: new AbortController().signal },
      }),
      [Symbol.dispose]: vi.fn(),
    });

    await bridge.handlePopstate();

    expect(eventController.abortAllActions).not.toHaveBeenCalled();
    expect(store.setInterceptSourceUrl).toHaveBeenCalledWith(null);
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
      handle: { signal: new AbortController().signal },
      with: (overrides: Record<string, unknown>) => ({
        ...overrides,
        handle: { signal: new AbortController().signal },
      }),
      [Symbol.dispose]: vi.fn(),
    });

    await bridge.handlePopstate();

    expect(fetchPartialUpdateMock).toHaveBeenCalled();
    const mode = fetchPartialUpdateMock.mock.calls[0][5];
    expect(mode).toBeUndefined();
  });
});

// Only a client navigation from the source page shows an intercept. A
// Back/Forward onto an intercept entry that must be fetched fetches it from
// its source page, and loads as a document from any other page.
describe("navigation-bridge handlePopstate onto an intercept entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  const SOURCE = "http://localhost/list";

  function setup(opts: {
    intercept?: boolean;
    /** The page on screen; an open intercept's URL with `openSource`. */
    onScreen?: string;
    openSource?: string;
    cached?: { stale?: boolean; placeholder?: boolean };
    renderThrows?: boolean;
  }) {
    const reload = vi.fn();
    const scrollTo = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/item/1",
        origin: "http://localhost",
        reload,
      },
      history: {
        state:
          opts.intercept === false
            ? { key: "entry-key" }
            : { intercept: true, sourceUrl: SOURCE, key: "entry-key" },
        replaceState: vi.fn(),
      },
      scrollTo,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    let historyKey = "http://localhost/away";
    const store = {
      ...createStore(),
      getHistoryKey: vi.fn(() => historyKey),
      setHistoryKey: vi.fn((key: string) => {
        historyKey = key;
      }),
      getSegmentState: vi.fn(() => ({
        currentUrl: opts.onScreen ?? "http://localhost/away",
        currentSegmentIds: [],
      })),
      setSegmentIds: vi.fn(),
      setPath: vi.fn(),
    };
    store.getInterceptSourceUrl.mockReturnValue(opts.openSource ?? null);
    store.getCachedSegments.mockReturnValue(
      opts.cached
        ? {
            segments: [
              {
                id: "L0",
                type: "layout",
                ...(opts.cached.placeholder && { deferred: true }),
              },
            ] as any,
            stale: opts.cached.stale ?? false,
          }
        : undefined,
    );
    const eventController = {
      ...createEventController(),
      setLocation: vi.fn(),
      abortAllActions: vi.fn(),
      getState: vi.fn(() => ({ isStreaming: false })),
      setParams: vi.fn(),
    };
    const onUpdate = vi.fn();
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController as any,
      onUpdate,
      renderSegments: vi.fn(async () => {
        if (opts.renderThrows) throw new Error("render failed");
        return "tree";
      }),
    });
    createNavigationTransactionMock.mockReturnValue({
      handle: { signal: new AbortController().signal },
      with: (overrides: Record<string, unknown>) => ({ ...overrides }),
      [Symbol.dispose]: vi.fn(),
    });
    fetchPartialUpdateMock.mockResolvedValue(undefined);
    return { bridge, store, eventController, reload, scrollTo, onUpdate };
  }

  const fetchedIntercept = (): void => {
    expect(fetchPartialUpdateMock).toHaveBeenCalledOnce();
    expect(fetchPartialUpdateMock.mock.calls[0][5]).toEqual({
      type: "navigate",
      interceptSourceUrl: SOURCE,
    });
  };

  it("with no cached copy, from another page, loads the entry as a document from the top, before it touches the store", async () => {
    const { bridge, store, eventController, reload, scrollTo } = setup({});

    await bridge.handlePopstate();

    expect(reload).toHaveBeenCalledOnce();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(scrollTo.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0],
    );
    // A beforeunload that cancels the reload leaves the page on screen and
    // a store that still describes it.
    expect(store.setInterceptSourceUrl).not.toHaveBeenCalled();
    expect(eventController.abortAllActions).not.toHaveBeenCalled();
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("with no cached copy, from its source page, fetches the intercept", async () => {
    const { bridge, reload } = setup({ onScreen: SOURCE });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    fetchedIntercept();
  });

  it("with no cached copy, from an intercept open over its source page, fetches the intercept", async () => {
    const { bridge, reload } = setup({
      onScreen: "http://localhost/item/9",
      openSource: SOURCE,
    });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    fetchedIntercept();
  });

  it("with a cached copy that holds a prefetch: false placeholder, fetches from its source page", async () => {
    const { bridge, reload } = setup({
      onScreen: SOURCE,
      cached: { placeholder: true },
    });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    fetchedIntercept();
  });

  it("with a cached copy that holds a prefetch: false placeholder, loads as a document from another page", async () => {
    const { bridge, reload } = setup({ cached: { placeholder: true } });

    await bridge.handlePopstate();

    expect(reload).toHaveBeenCalledOnce();
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("a cached copy that fails to render follows the same rule", async () => {
    const away = setup({ cached: {}, renderThrows: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await away.bridge.handlePopstate();
    expect(away.reload).toHaveBeenCalledOnce();
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();

    const source = setup({
      onScreen: SOURCE,
      cached: {},
      renderThrows: true,
    });
    await source.bridge.handlePopstate();
    expect(source.reload).not.toHaveBeenCalled();
    fetchedIntercept();
  });

  it("a non-intercept entry with no cached copy fetches as before", async () => {
    const { bridge, reload } = setup({ intercept: false });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    expect(fetchPartialUpdateMock).toHaveBeenCalledOnce();
  });

  it("a cache hit re-opens the intercept with no request, from any page", async () => {
    const { bridge, store, reload, onUpdate } = setup({ cached: {} });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(store.getCachedSegments).toHaveBeenCalledWith(
      "/item/1:intercept:/list",
    );
    expect(store.setHistoryKey).toHaveBeenCalledWith("/item/1:intercept:/list");
    expect(store.setInterceptSourceUrl).toHaveBeenLastCalledWith(SOURCE);
  });

  it("a stale cache hit revalidates the intercept in the background, from its source", async () => {
    const { bridge, reload } = setup({ cached: { stale: true } });

    await bridge.handlePopstate();

    expect(reload).not.toHaveBeenCalled();
    expect(fetchPartialUpdateMock).toHaveBeenCalledOnce();
    const [, , , , tx, mode] = fetchPartialUpdateMock.mock.calls[0];
    expect(tx).toMatchObject({
      intercept: true,
      interceptSourceUrl: SOURCE,
      cacheOnly: true,
    });
    expect(mode).toEqual({
      type: "stale-revalidation",
      interceptSourceUrl: SOURCE,
    });
  });
});

describe("navigation-bridge an action's error boundary the entry shows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
  });

  const layout = () => ({ id: "L0", type: "layout" });
  const layoutLoader = () => ({ id: "L0D0.cart", type: "loader" });
  const routeLoader = () => ({ id: "L0R0D0.item", type: "loader" });
  const error = () => ({ id: "L0R0", type: "error" });
  const action = <T extends object>(segment: T): T => {
    actionBoundaries.add(segment as any);
    return segment;
  };

  /** /page's entry caches `segments`; history is on it. */
  function setup(segments: unknown[], opts: { stale?: boolean } = {}) {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/page", origin: "http://localhost" },
      history: { state: { key: "entry-key" }, replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    let historyKey = "http://localhost/other";
    const store = {
      ...createStore(),
      getHistoryKey: vi.fn(() => historyKey),
      setHistoryKey: vi.fn((key: string) => {
        historyKey = key;
      }),
      getSegmentState: vi.fn(() => ({
        currentUrl: "http://localhost/other",
        currentSegmentIds: [],
      })),
      setSegmentIds: vi.fn(),
      setPath: vi.fn(),
    };
    store.getCachedSegments.mockReturnValue({
      segments,
      stale: opts.stale ?? false,
    });
    const eventController = {
      ...createEventController(),
      setLocation: vi.fn(),
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
      handle: { signal: new AbortController().signal },
      with: (overrides: Record<string, unknown>) => ({ ...overrides }),
      [Symbol.dispose]: vi.fn(),
    });
    fetchPartialUpdateMock.mockResolvedValue(undefined);
    return { bridge, store, eventController };
  }

  it("Back onto a stale entry: the page holds the ids above the boundary, and the revalidation holds them and names the boundary", async () => {
    const { bridge, store } = setup(
      [layout(), layoutLoader(), action(error()), routeLoader()],
      { stale: true },
    );

    await bridge.handlePopstate();

    expect(store.setSegmentIds).toHaveBeenCalledWith(["L0", "L0D0.cart"]);
    expect(fetchPartialUpdateMock).toHaveBeenCalledOnce();
    const [, segmentIds, , , tx, mode] = fetchPartialUpdateMock.mock.calls[0];
    expect(segmentIds).toEqual(["L0", "L0D0.cart"]);
    expect(tx).toMatchObject({ cacheOnly: true });
    expect(mode).toEqual({ type: "stale-revalidation", boundary: "L0R0" });
  });

  it("Back onto a fresh entry: the page holds the ids above the boundary, with no request", async () => {
    const { bridge, store } = setup([layout(), action(error())]);

    await bridge.handlePopstate();

    expect(store.setSegmentIds).toHaveBeenCalledWith(["L0"]);
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("a boundary at the page's first segment: nothing above it is revalidated", async () => {
    const { bridge, store } = setup([action(error()), routeLoader()], {
      stale: true,
    });

    await bridge.handlePopstate();

    expect(store.setSegmentIds).toHaveBeenCalledWith([]);
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("control: a navigation's error segment is held and revalidated as before", async () => {
    const { bridge, store } = setup([layout(), error()], { stale: true });

    await bridge.handlePopstate();

    expect(store.setSegmentIds).toHaveBeenCalledWith(["L0", "L0R0"]);
    const [, segmentIds, , , , mode] = fetchPartialUpdateMock.mock.calls[0];
    expect(segmentIds).toEqual(["L0", "L0R0"]);
    expect(mode.boundary).toBeUndefined();
  });

  it("a cross-tab refresh holds nothing and names the boundary; a refresh the app asks for names none", async () => {
    const { bridge, store } = setup([layout(), action(error())]);
    store.getHistoryKey.mockReturnValue("http://localhost/page");

    await bridge.refresh(true);
    await bridge.refresh();

    const [cross, app] = fetchPartialUpdateMock.mock.calls;
    expect(cross[1]).toEqual([]);
    expect(cross[5]).toEqual({
      type: "navigate",
      refresh: true,
      boundary: "L0R0",
    });
    expect(app[5].boundary).toBeUndefined();
  });

  it("a cross-tab refresh with the boundary at the page's first segment sends nothing and aborts nothing", async () => {
    const { bridge, store, eventController } = setup([action(error())]);
    store.getHistoryKey.mockReturnValue("http://localhost/page");

    await bridge.refresh(true);

    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
    expect(eventController.abortNavigation).not.toHaveBeenCalled();
  });

  it("a cross-tab refresh under an open intercept names no boundary", async () => {
    const { bridge, store } = setup([layout(), action(error())]);
    store.getHistoryKey.mockReturnValue("http://localhost/page");
    store.getInterceptSourceUrl.mockReturnValue("http://localhost/list");

    await bridge.refresh(true);

    expect(fetchPartialUpdateMock.mock.calls[0][5].boundary).toBeUndefined();
  });
});

describe("navigation-bridge bfcache pageshow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not take scroll from the browser (that belongs to <Html.ScrollRestoration>)", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const history = { state: {}, scrollRestoration: "auto" };
    vi.stubGlobal("document", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      location: { href: "http://localhost/", origin: "http://localhost" },
      history,
      addEventListener: vi.fn((type: string, fn: (event: unknown) => void) =>
        listeners.set(type, fn),
      ),
      removeEventListener: vi.fn(),
    });
    const abortNavigation = vi.fn();
    const bridge = createNavigationBridge({
      store: createStore() as any,
      client: {} as any,
      eventController: { ...createEventController(), abortNavigation } as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    const cleanup = bridge.registerLinkInterception();
    listeners.get("pageshow")?.({ persisted: true });

    expect(abortNavigation).toHaveBeenCalledOnce();
    expect(history.scrollRestoration).toBe("auto");
    cleanup();
  });
});

// #1329: a click on a prefetch a server action marked stale commits it as any
// prefetched click does, then revalidates the page once the click settled,
// in Back's stale-revalidation lane (navigation-bridge.ts
// revalidateStalePrefetch).
const CART = "http://localhost/cart";
const SEGMENTS = [
  { id: "L0", type: "layout" },
  { id: "L0D0.basket", type: "loader" },
  { id: "L0R1", type: "route" },
];

interface Settling {
  abort: AbortController;
  settled: Promise<boolean>;
  settle(committed: boolean): void;
}

function makeEntry(): Settling {
  let settle!: (committed: boolean) => void;
  const settled = new Promise<boolean>((resolve) => (settle = resolve));
  return { abort: new AbortController(), settled, settle };
}

function makeTx(abort: AbortController) {
  return {
    handle: { signal: abort.signal, abort },
    commit: vi.fn(),
    with: vi.fn((opts: unknown) => opts),
    [Symbol.dispose]: vi.fn(),
  };
}

function setup() {
  let historyKey = "http://localhost/";
  const cached = new Map<string, any>([
    [CART, { segments: SEGMENTS, stale: false, handleData: { h: {} } }],
  ]);
  const store = {
    getHistoryKey: vi.fn(() => historyKey),
    rememberDisplayedEntry: vi.fn(),
    getHistoryEntryMemory: vi.fn(() => undefined),
    getCachedSegments: vi.fn((key: string) => cached.get(key)),
    hasInterceptCache: vi.fn(() => false),
    cacheSegmentsForHistory: vi.fn(),
    updateCacheHandleData: vi.fn(),
    setInterceptSourceUrl: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
    setHistoryKey: vi.fn(),
    setCurrentUrl: vi.fn(),
    getInterceptSourceUrl: vi.fn((): string | null => null),
  };
  const click = makeEntry();
  const revalidation = makeEntry();
  let unsettled: Settling | null = click;
  const eventController = {
    abortNavigation: vi.fn(),
    getHandleState: vi.fn(() => ({ data: {} })),
    getHydrationSnapshot: vi.fn(() => undefined),
    commitLocationState: vi.fn(),
    getUnsettledNavigation: vi.fn(() => unsettled),
  };
  createNavigationTransactionMock
    .mockReturnValueOnce(makeTx(click.abort))
    .mockReturnValueOnce(makeTx(revalidation.abort));
  const bridge = createNavigationBridge({
    store: store as any,
    client: {} as any,
    eventController: eventController as any,
    onUpdate: vi.fn(),
    renderSegments: vi.fn(async () => "tree"),
  });
  return {
    bridge,
    store,
    click,
    /** The click committed: the store moved to its entry. */
    commit: () => {
      historyKey = CART;
    },
    moveTo: (key: string) => {
      historyKey = key;
    },
    settle: async (committed: boolean) => {
      unsettled = null;
      click.settle(committed);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    startOther: () => {
      unsettled = makeEntry();
    },
  };
}

describe("navigation-bridge click on a stale prefetch", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {
      location: { href: CART, origin: "http://localhost" },
      history: { state: {}, pushState: vi.fn(), replaceState: vi.fn() },
    });
    __resetActionFence();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetchPartialUpdateMock.mockReset();
    createNavigationTransactionMock.mockReset();
    __resetActionFence();
  });

  /** The click's response is a stale prefetch, and it commits. */
  function staleClick(env: ReturnType<typeof setup>) {
    fetchPartialUpdateMock.mockImplementationOnce(
      async (_url, _ids, _retry, _signal, _tx, mode) => {
        mode.onStalePrefetch(true);
        env.commit();
      },
    );
    fetchPartialUpdateMock.mockResolvedValue(undefined);
  }

  it("commits, then runs one stale revalidation of the page with its ids held once the click settled", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    // The click's fill or stream is still open: nothing runs yet.
    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);

    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(2);
    const [url, heldIds, isRetry, , tx, mode] =
      fetchPartialUpdateMock.mock.calls[1]!;
    expect(url).toBe(CART);
    expect(heldIds).toEqual(["L0", "L0D0.basket", "L0R1"]);
    expect(isRetry).toBe(false);
    expect(mode).toEqual({
      type: "stale-revalidation",
      interceptSourceUrl: undefined,
      boundary: undefined,
    });
    expect(tx).toMatchObject({ url: CART, replace: true, cacheOnly: true });
    expect(createNavigationTransactionMock.mock.calls[1]![3]).toEqual({
      skipLoadingState: true,
      replace: true,
    });
    // The entry is stale until the revalidation re-caches it.
    expect(env.store.updateCacheHandleData).toHaveBeenCalledWith(
      CART,
      { h: {} },
      true,
    );
  });

  // A prefetch: false fill that made the click start over: the fresh
  // refetch is what committed (partial-update.ts tells the mode of each
  // response), so revalidating after it would be one redundant request.
  it("runs nothing when a fresh response after the stale one is what committed", async () => {
    const env = setup();
    fetchPartialUpdateMock.mockImplementationOnce(
      async (_url, _ids, _retry, _signal, _tx, mode) => {
        mode.onStalePrefetch(true);
        mode.onStalePrefetch(false);
        env.commit();
      },
    );

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(env.store.updateCacheHandleData).not.toHaveBeenCalledWith(
      CART,
      expect.anything(),
      true,
    );
  });

  it("runs nothing for a click on a fresh prefetch", async () => {
    const env = setup();
    fetchPartialUpdateMock.mockImplementationOnce(async () => env.commit());

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(env.store.updateCacheHandleData).not.toHaveBeenCalledWith(
      CART,
      expect.anything(),
      true,
    );
  });

  it("runs nothing when the click was left before it settled", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.click.abort.abort();
    await env.settle(false);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("only marks the entry stale when the page moved since the commit", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.moveTo("http://localhost/cart?tab=2");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    expect(env.store.updateCacheHandleData).toHaveBeenCalledWith(
      CART,
      { h: {} },
      true,
    );
  });

  it("only marks the entry stale while another navigation is open", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    env.startOther();
    await new Promise((resolve) => setTimeout(resolve, 0));
    env.click.settle(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
  });

  it("runs while an action is in flight, as Back's revalidation does", async () => {
    const env = setup();
    staleClick(env);

    await env.bridge.navigate("/cart");
    enterActionFence();
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(2);
    expect(fetchPartialUpdateMock.mock.calls[1]![5]).toMatchObject({
      type: "stale-revalidation",
    });
  });

  it("re-renders the page whole when its cached handles are incomplete", async () => {
    const env = setup();
    staleClick(env);
    env.store.getCachedSegments.mockImplementation((key: string) =>
      key === CART
        ? {
            segments: SEGMENTS,
            stale: false,
            handleData: { h: {} },
            handlesPending: true,
          }
        : undefined,
    );

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock.mock.calls[1]![1]).toEqual([]);
  });

  // An action's error boundary on screen is that action's outcome, which no
  // GET reproduces: the revalidation holds it and renders what is above it,
  // as Back's does (actionBoundaryAt, idsAboveBoundary).
  it("holds an action error boundary the page shows, and sends only the ids above it", async () => {
    const env = setup();
    staleClick(env);
    const boundary = { id: "L0R1", type: "error" };
    actionBoundaries.add(boundary as any);
    const segments = [
      SEGMENTS[0],
      SEGMENTS[1],
      boundary,
      { id: "L0R1D0.items", type: "loader" },
    ];
    env.store.getCachedSegments.mockImplementation((key: string) =>
      key === CART ? { segments, stale: false, handleData: {} } : undefined,
    );

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(2);
    const [, heldIds, , , , mode] = fetchPartialUpdateMock.mock.calls[1]!;
    expect(heldIds).toEqual(["L0", "L0D0.basket"]);
    expect(mode).toMatchObject({
      type: "stale-revalidation",
      boundary: "L0R1",
    });
  });

  it("runs nothing when the action error boundary is the page's root: nothing is above it", async () => {
    const env = setup();
    staleClick(env);
    const boundary = { id: "L0", type: "error" };
    actionBoundaries.add(boundary as any);
    env.store.getCachedSegments.mockImplementation((key: string) =>
      key === CART
        ? { segments: [boundary], stale: false, handleData: {} }
        : undefined,
    );

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(1);
    // Still marked stale, so a Back onto it revalidates.
    expect(env.store.updateCacheHandleData).toHaveBeenCalledWith(
      CART,
      {},
      true,
    );
  });

  // An intercept on screen (a modal over its source page): the revalidation
  // asks for it from its source, as Back onto an intercept entry does, and
  // holds no boundary (an intercept's list is not the page's).
  it("revalidates an intercept from its source page", async () => {
    const env = setup();
    // The click from the source page opens the modal: its commit writes the
    // intercept entry.
    fetchPartialUpdateMock.mockImplementationOnce(
      async (_url, _ids, _retry, _signal, _tx, mode) => {
        mode.onStalePrefetch(true);
        env.commit();
        (window.history as { state: unknown }).state = {
          intercept: true,
          sourceUrl: "http://localhost/shop",
        };
      },
    );
    fetchPartialUpdateMock.mockResolvedValue(undefined);

    await env.bridge.navigate("/cart");
    await env.settle(true);

    expect(fetchPartialUpdateMock).toHaveBeenCalledTimes(2);
    const [, , , , tx, mode] = fetchPartialUpdateMock.mock.calls[1]!;
    expect(mode).toEqual({
      type: "stale-revalidation",
      interceptSourceUrl: "http://localhost/shop",
      boundary: undefined,
    });
    expect(tx).toMatchObject({
      intercept: true,
      interceptSourceUrl: "http://localhost/shop",
    });
  });
});
