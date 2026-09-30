import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSegment } from "../browser/types";

/**
 * transition({ when }) decisions made by the navigation bridge itself: a
 * back/forward restored from the history cache (kind "pop", the entry left
 * read from memory) and the optimistic clientUrls() swap (decided at the
 * swap, carried to the canonical commit on the transaction).
 */

const { fetchPartialUpdateMock, txWithMock } = vi.hoisted(() => ({
  fetchPartialUpdateMock: vi.fn(async () => {}),
  txWithMock: vi.fn((opts: Record<string, unknown>) => opts),
}));

vi.mock("../browser/partial-update.js", async () => ({
  ...(await vi.importActual<object>("../browser/partial-update.js")),
  createPartialUpdater: vi.fn(() => fetchPartialUpdateMock),
}));

vi.mock("../browser/navigation-transaction.js", () => ({
  resolveNavigationState: vi.fn((state: unknown) => state),
  createNavigationTransaction: vi.fn(() => ({
    handle: { signal: new AbortController().signal },
    with: txWithMock,
    [Symbol.dispose]: vi.fn(),
  })),
}));

vi.mock("../browser/scroll-restoration.js", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  handleTraversalStart: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "k"),
}));

import { createNavigationBridge } from "../browser/navigation-bridge";
import {
  clearClientUrlNavigationRegistry,
  registerClientUrlGroup,
} from "../client-urls/navigation";

function seg(
  id: string,
  extra: Partial<ResolvedSegment> = {},
): ResolvedSegment {
  return {
    id,
    namespace: "",
    index: 0,
    type: "route",
    component: null,
    ...extra,
  } as ResolvedSegment;
}

function eventController() {
  return {
    abortNavigation: vi.fn(),
    abortAllActions: vi.fn(),
    getHandleState: vi.fn(() => ({ data: {} })),
    setLocation: vi.fn(),
    setParams: vi.fn(),
    getState: vi.fn(() => ({ isStreaming: false })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fetchPartialUpdateMock.mockClear();
  txWithMock.mockClear();
  clearClientUrlNavigationRegistry();
});

describe("navigation-bridge transition({ when })", () => {
  it("decides a history-cache restore with kind pop against the entry being left", async () => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/a", origin: "http://localhost" },
      history: { state: { key: "entry-a", __rsc_ls_s: "a-state" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const seen: any[] = [];
    const when = vi.fn((ctx: any) => {
      seen.push(ctx);
      return false;
    });
    const memory = new Map([
      ["entry-a", { routeName: "list", state: { key: "entry-a" } }],
      ["displayed", { routeName: "detail", state: { mark: "left" } }],
    ]);
    const store = {
      getHistoryKey: vi.fn(() => "/b"),
      setHistoryKey: vi.fn(),
      setSegmentIds: vi.fn(),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      getSegmentState: vi.fn(() => ({
        path: "/b",
        currentUrl: "http://localhost/b",
        currentSegmentIds: [],
      })),
      getCachedSegments: vi.fn((key: string) =>
        key === "/a"
          ? {
              segments: [
                seg("R0", { params: { n: "a" }, transition: { when } }),
              ],
              stale: false,
            }
          : { segments: [seg("R0", { params: { n: "b" } })], stale: false },
      ),
      getHistoryEntryMemory: vi.fn((key?: string) =>
        memory.get(key ?? "displayed"),
      ),
      rememberDisplayedEntry: vi.fn(),
      getInterceptSourceUrl: vi.fn(() => null),
      setInterceptSourceUrl: vi.fn(),
    };
    const onUpdate = vi.fn();
    const renderSegments = vi.fn(async (..._args: any[]) => "tree");
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate,
      renderSegments,
    });

    await bridge.handlePopstate();

    expect(when).toHaveBeenCalledTimes(1);
    expect(seen[0].kind).toBe("pop");
    expect(seen[0].from).toMatchObject({
      params: { n: "b" },
      routeName: "detail",
      state: { mark: "left" },
    });
    expect(seen[0].from.url.pathname).toBe("/b");
    expect(seen[0].to).toMatchObject({
      params: { n: "a" },
      routeName: "list",
      state: { key: "entry-a", __rsc_ls_s: "a-state" },
    });
    expect(renderSegments.mock.calls[0]![1]).toMatchObject({
      transitionGatedOff: true,
    });
    expect(store.rememberDisplayedEntry).toHaveBeenCalledOnce();
    expect(fetchPartialUpdateMock).not.toHaveBeenCalled();
  });

  it("does not decide a history-cache restore that leaves an intercept", async () => {
    vi.stubGlobal("window", {
      location: { href: "http://localhost/a", origin: "http://localhost" },
      history: { state: { key: "entry-a", __rsc_ls_s: "a-state" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const seen: any[] = [];
    const when = vi.fn((ctx: any) => {
      seen.push(ctx);
      return false;
    });
    const memory = new Map([
      ["entry-a", { routeName: "list", state: { key: "entry-a" } }],
      ["displayed", { routeName: "detail", state: { mark: "left" } }],
    ]);
    const store = {
      getHistoryKey: vi.fn(() => "/b"),
      setHistoryKey: vi.fn(),
      setSegmentIds: vi.fn(),
      setCurrentUrl: vi.fn(),
      setPath: vi.fn(),
      getSegmentState: vi.fn(() => ({
        path: "/b",
        currentUrl: "http://localhost/b",
        currentSegmentIds: [],
      })),
      getCachedSegments: vi.fn((key: string) =>
        key === "/a"
          ? {
              segments: [
                seg("R0", { params: { n: "a" }, transition: { when } }),
              ],
              stale: false,
            }
          : { segments: [seg("R0", { params: { n: "b" } })], stale: false },
      ),
      getHistoryEntryMemory: vi.fn((key?: string) =>
        memory.get(key ?? "displayed"),
      ),
      rememberDisplayedEntry: vi.fn(),
      // An intercept (modal) was open: this back closes it.
      getInterceptSourceUrl: vi.fn(() => "http://localhost/list"),
      setInterceptSourceUrl: vi.fn(),
    };
    const onUpdate = vi.fn();
    const renderSegments = vi.fn(async (..._args: any[]) => "tree");
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate,
      renderSegments,
    });

    await bridge.handlePopstate();

    expect(when).not.toHaveBeenCalled();
    expect(renderSegments.mock.calls[0]![1]).toMatchObject({
      transitionGatedOff: false,
    });
  });

  it("decides a cross-route clientUrls() navigation at the optimistic swap and carries it to the commit", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/shop/items/one",
        pathname: "/shop/items/one",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const seen: any[] = [];
    const destinationWhen = vi.fn((ctx: any) => {
      seen.push(ctx);
      return false;
    });
    const definition = {
      routes: [
        { id: "items", name: "item", transition: {} },
        { id: "about", name: "about", transition: { when: destinationWhen } },
      ],
      intercepts: [],
      match: (pathname: string) =>
        pathname === "/about"
          ? { routeKey: "about", params: {} }
          : pathname.startsWith("/items/")
            ? { routeKey: "items", params: { itemId: pathname.slice(7) } }
            : null,
    };
    const intents: any[] = [];
    registerClientUrlGroup(
      definition as any,
      "/shop",
      "shop",
      (intent) => intents.push(intent),
      "items",
    );
    const layoutWhen = vi.fn(() => true);
    const store = {
      getHistoryKey: vi.fn(() => "/shop/items/one"),
      getCachedSegments: vi.fn(() => ({
        segments: [
          seg("L0", {
            type: "layout",
            params: { locale: "en" },
            transition: { when: layoutWhen },
          }),
          seg("L0R0", {
            params: { locale: "en", itemId: "one" },
            clientGroup: "/shop",
            transition: { when: vi.fn(() => true) },
          } as any),
        ],
        stale: false,
      })),
      getSegmentState: vi.fn(() => ({
        path: "/shop/items/one",
        currentUrl: "http://localhost/shop/items/one",
        currentSegmentIds: ["L0", "L0R0"],
      })),
      getHistoryEntryMemory: vi.fn(() => ({ routeName: "shop.item" })),
      hasHistoryCache: vi.fn(() => false),
      updateCacheHandleData: vi.fn(),
      setInterceptSourceUrl: vi.fn(),
    };
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/shop/about", {
      state: { __rsc_ls_s: "pushed" },
    } as any);

    // Kept segments outside the group plus the destination's own when; the
    // origin route segment (clientGroup) is being replaced, so not its.
    expect(layoutWhen).toHaveBeenCalledTimes(1);
    expect(destinationWhen).toHaveBeenCalledTimes(1);
    expect(seen[0].kind).toBe("push");
    expect(seen[0].from.routeName).toBe("shop.item");
    expect(seen[0].to).toMatchObject({
      routeName: "shop.about",
      // Mount params carry over; the origin route's own do not.
      params: { locale: "en" },
      state: { __rsc_ls_s: "pushed" },
    });
    expect(intents[0]).toMatchObject({
      routeId: "about",
      transitionGatedOff: true,
    });
    expect(txWithMock.mock.calls[0]![0]).toMatchObject({
      transitionGatedOff: true,
    });
  });

  it("does not decide a same-route clientUrls() navigation at the swap", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/items/one",
        pathname: "/items/one",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const when = vi.fn(() => false);
    const definition = {
      routes: [{ id: "items", name: "item", transition: { when } }],
      intercepts: [],
      match: (pathname: string) =>
        pathname.startsWith("/items/")
          ? { routeKey: "items", params: { itemId: pathname.slice(7) } }
          : null,
    };
    registerClientUrlGroup(definition as any, "/", "", () => {}, "items");
    const store = {
      getHistoryKey: vi.fn(() => "/items/one"),
      getCachedSegments: vi.fn(() => undefined),
      hasHistoryCache: vi.fn(() => false),
      getSegmentState: vi.fn(() => ({
        path: "/items/one",
        currentUrl: "http://localhost/items/one",
        currentSegmentIds: [],
      })),
      updateCacheHandleData: vi.fn(),
      setInterceptSourceUrl: vi.fn(),
    };
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/items/two");

    expect(when).not.toHaveBeenCalled();
    expect(txWithMock.mock.calls[0]![0]).toMatchObject({
      transitionGatedOff: undefined,
    });
  });

  it("transition: false gates a cross-route clientUrls() swap off without calling a predicate", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/items/one",
        pathname: "/items/one",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const destinationWhen = vi.fn(() => true);
    const layoutWhen = vi.fn(() => true);
    const definition = {
      routes: [
        { id: "items", name: "item", transition: {} },
        { id: "about", name: "about", transition: { when: destinationWhen } },
      ],
      intercepts: [],
      match: (pathname: string) =>
        pathname === "/about"
          ? { routeKey: "about", params: {} }
          : pathname.startsWith("/items/")
            ? { routeKey: "items", params: { itemId: pathname.slice(7) } }
            : null,
    };
    const intents: any[] = [];
    registerClientUrlGroup(
      definition as any,
      "/",
      "",
      (intent) => intents.push(intent),
      "items",
    );
    const store = {
      getHistoryKey: vi.fn(() => "/items/one"),
      getCachedSegments: vi.fn(() => ({
        segments: [
          seg("L0", { type: "layout", transition: { when: layoutWhen } }),
        ],
        stale: false,
      })),
      getSegmentState: vi.fn(() => ({
        path: "/items/one",
        currentUrl: "http://localhost/items/one",
        currentSegmentIds: ["L0"],
      })),
      getHistoryEntryMemory: vi.fn(() => ({ routeName: "item" })),
      hasHistoryCache: vi.fn(() => false),
      updateCacheHandleData: vi.fn(),
      setInterceptSourceUrl: vi.fn(),
    };
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/about", { transition: false });

    expect(destinationWhen).not.toHaveBeenCalled();
    expect(layoutWhen).not.toHaveBeenCalled();
    expect(intents[0]).toMatchObject({
      routeId: "about",
      transitionGatedOff: true,
    });
    expect(txWithMock.mock.calls[0]![0]).toMatchObject({
      transitionGatedOff: true,
    });
  });

  it("transition: false carries a gated-off decision to the canonical commit", async () => {
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/a",
        pathname: "/a",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" } },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const store = {
      getHistoryKey: vi.fn(() => "/a"),
      getCachedSegments: vi.fn(() => undefined),
      hasHistoryCache: vi.fn(() => false),
      getSegmentState: vi.fn(() => ({
        path: "/a",
        currentUrl: "http://localhost/a",
        currentSegmentIds: [],
      })),
      updateCacheHandleData: vi.fn(),
      setInterceptSourceUrl: vi.fn(),
    };
    const bridge = createNavigationBridge({
      store: store as any,
      client: {} as any,
      eventController: eventController() as any,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(async () => "tree"),
    });

    await bridge.navigate("/b", { transition: false });
    await bridge.navigate("/c", { transition: true });

    expect(txWithMock.mock.calls[0]![0]).toMatchObject({
      transitionGatedOff: true,
    });
    // Without the opt-out the commit decides (partial-update.ts).
    expect(txWithMock.mock.calls[1]![0]).toMatchObject({
      transitionGatedOff: undefined,
    });
  });
});
