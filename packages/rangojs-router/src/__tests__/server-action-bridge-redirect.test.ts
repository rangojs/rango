import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RscPayload } from "../browser/types";

// Mock react.startTransition to run synchronously
vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return { ...actual, startTransition: (fn: () => void) => fn() };
});

// Stub modules not needed for redirect tests
vi.mock("../browser/partial-update.js", () => ({
  createPartialUpdater: () => vi.fn(),
}));
vi.mock("../browser/navigation-transaction.js", () => ({
  createNavigationTransaction: vi.fn(),
}));
vi.mock("../browser/segment-reconciler.js", () => ({
  reconcileSegments: vi.fn(),
  reconcileErrorSegments: vi.fn(),
}));
vi.mock("../browser/action-response-classifier.js", () => ({
  classifyActionResponse: vi.fn(() => "noop"),
}));
vi.mock("../browser/network-error-handler.js", () => ({
  toNetworkError: () => null,
  emitNetworkError: vi.fn(),
  isBackgroundSuppressible: () => false,
}));
vi.mock("../browser/logging.js", () => ({
  isBrowserDebugEnabled: () => false,
  startBrowserTransaction: vi.fn(),
  browserDebugLog: vi.fn(),
}));

import { createServerActionBridge } from "../browser/server-action-bridge";
import { reconcileErrorSegments } from "../browser/segment-reconciler";

// ---------------------------------------------------------------------------
// Window setup (no jsdom — manual globalThis.window like prefetch-fetch tests)
// ---------------------------------------------------------------------------

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  "window",
);

function restoreGlobalProperty(
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, key, descriptor);
    return;
  }
  delete (globalThis as Record<string, unknown>)[key];
}

function setupWindow() {
  const locationHrefSetter = vi.fn();

  const location = {
    href: "http://localhost:3000/",
    origin: "http://localhost:3000",
    pathname: "/",
  };
  Object.defineProperty(location, "href", {
    get: () => "http://localhost:3000/",
    set: locationHrefSetter,
    configurable: true,
  });

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location,
      history: {
        state: { key: "/" },
        replaceState: vi.fn(),
      },
      dispatchEvent: vi.fn(),
      matchMedia: vi.fn(() => ({ matches: false })),
    },
  });

  return { locationHrefSetter };
}

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockStore() {
  return {
    getSegmentState: vi.fn(() => ({
      path: "/",
      currentUrl: "http://localhost:3000/",
      currentSegmentIds: ["root"],
    })),
    markCacheAsStaleAndBroadcast: vi.fn(),
    getInterceptSourceUrl: vi.fn(() => null),
    getHistoryKey: vi.fn(() => "/"),
    setHistoryKey: vi.fn(),
    getCachedSegments: vi.fn(),
    setInterceptSourceUrl: vi.fn(),
    getState: vi.fn(() => ({ state: "idle" })),
    setState: vi.fn(),
    subscribe: vi.fn(),
    cacheSegmentsForHistory: vi.fn(),
    hasHistoryCache: vi.fn(() => false),
    setPath: vi.fn(),
    setCurrentUrl: vi.fn(),
    setSegmentIds: vi.fn(),
    markCacheAsStale: vi.fn(),
    clearHistoryCache: vi.fn(),
    broadcastCacheInvalidation: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
    addInflightAction: vi.fn(),
    removeInflightAction: vi.fn(),
    isActionInProgress: vi.fn(() => false),
    setActionInProgress: vi.fn(),
    updateCacheHandleData: vi.fn(),
    onUpdate: vi.fn(),
    emitUpdate: vi.fn(),
    getActionState: vi.fn(),
    setActionState: vi.fn(),
    subscribeToAction: vi.fn(),
  };
}

function createMockEventController() {
  const completeFn = vi.fn();
  const failFn = vi.fn();
  const abortCtrl = new AbortController();
  return {
    controller: {
      startAction: vi.fn(() => ({
        id: "test-action-1",
        abort: abortCtrl,
        signal: abortCtrl.signal,
        startStreaming: vi.fn(() => ({ end: vi.fn() })),
        recordRevalidatedSegments: vi.fn(),
        complete: completeFn,
        fail: failFn,
        settled: false,
        hadConcurrentActions: false,
        getConsolidationSegments: vi.fn(() => null),
        clearConsolidation: vi.fn(),
        [Symbol.dispose]: vi.fn(),
      })),
      abortAllActions: vi.fn(),
      getState: vi.fn(() => ({
        navState: "idle",
        isStreaming: false,
        hasInflightActions: false,
      })),
      getActionState: vi.fn(),
      getLocation: vi.fn(() => ({
        pathname: "/",
        search: "",
        hash: "",
        key: "/",
      })),
      setLocation: vi.fn(),
      getHandleState: vi.fn(() => ({ data: undefined })),
      subscribe: vi.fn(),
      startNavigation: vi.fn(),
      abortNavigation: vi.fn(),
    },
    completeFn,
    failFn,
    abortCtrl,
  };
}

/**
 * Build mock deps that resolve createFromFetch with the given payload.
 * Accepts an optional sideEffect callback that runs during createFromFetch
 * (useful for aborting the handle mid-stream).
 * Captures the handleServerAction callback via setServerCallback.
 */
function createMockDeps(
  payload: RscPayload,
  opts?: {
    sideEffect?: () => void | Promise<void>;
    responseHeaders?: Record<string, string>;
  },
) {
  const sideEffect = opts?.sideEffect;
  let actionCallback: ((id: string, args: any[]) => Promise<any>) | null = null;

  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: {
            "content-type": "text/x-component",
            ...opts?.responseHeaders,
          },
        }),
      ),
    ),
  );

  return {
    deps: {
      createFromFetch: vi.fn(async () => {
        await sideEffect?.();
        return payload;
      }) as any,
      createFromReadableStream: vi.fn(),
      encodeReply: vi.fn(() => Promise.resolve("encoded")),
      setServerCallback: vi.fn(
        (cb: (id: string, args: any[]) => Promise<any>) => {
          actionCallback = cb;
        },
      ),
      createTemporaryReferenceSet: vi.fn(() => ({})),
    },
    getActionCallback: () => actionCallback!,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server-action-bridge payload redirect origin validation", () => {
  let locationHrefSetter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ locationHrefSetter } = setupWindow());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
  });

  it("blocks cross-origin payload redirect and does not call onNavigate", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const store = createMockStore();
    const { controller, completeFn } = createMockEventController();
    const onNavigate = vi.fn();

    const payload: RscPayload = {
      metadata: {
        redirect: { url: "https://evil.com/steal-cookies" },
      },
      returnValue: { ok: true, data: "action-result" },
    } as any;

    const { deps, getActionCallback } = createMockDeps(payload);

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(),
      onNavigate,
    });
    bridge.register();

    const result = await getActionCallback()("test-action", []);

    expect(completeFn).toHaveBeenCalledWith("action-result");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(locationHrefSetter).not.toHaveBeenCalled();
    expect(result).toBe("action-result");
  });

  it("blocks cross-origin payload redirect via window.location.href fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    const store = createMockStore();
    const { controller, completeFn } = createMockEventController();

    const payload: RscPayload = {
      metadata: {
        redirect: { url: "https://evil.com/steal-cookies" },
      },
      returnValue: { ok: true, data: "result" },
    } as any;

    const { deps, getActionCallback } = createMockDeps(payload);

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(),
      // No onNavigate — fallback uses window.location.href
    });
    bridge.register();

    await getActionCallback()("test-action", []);

    expect(completeFn).toHaveBeenCalledWith("result");
    expect(locationHrefSetter).not.toHaveBeenCalled();
  });

  it("allows same-origin payload redirect and calls onNavigate", async () => {
    const store = createMockStore();
    const { controller, completeFn } = createMockEventController();
    const onNavigate = vi.fn(() => Promise.resolve());

    const payload: RscPayload = {
      metadata: {
        redirect: { url: "/dashboard" },
        locationState: { __rsc_ls_tab: "home" },
      },
      returnValue: { ok: true, data: "redirect-result" },
    } as any;

    const { deps, getActionCallback } = createMockDeps(payload);

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(),
      onNavigate,
    });
    bridge.register();

    const result = await getActionCallback()("test-action", []);

    expect(completeFn).toHaveBeenCalledWith("redirect-result");
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:3000/dashboard", {
      state: { __rsc_ls_tab: "home" },
      replace: true,
      _skipCache: true,
    });
    expect(result).toBe("redirect-result");
  });

  it("bails out of post-payload mutations when action is aborted", async () => {
    const store = createMockStore();
    const { controller, completeFn, abortCtrl } = createMockEventController();
    const onUpdate = vi.fn();
    const renderSegments = vi.fn();

    const payload: RscPayload = {
      metadata: {
        isPartial: true,
        matched: ["root"],
        diff: ["root"],
        segments: [],
      },
      returnValue: { ok: true, data: "stale-result" },
    } as any;

    // Abort the handle after createFromFetch resolves but before
    // post-payload processing. The bridge already returns undefined
    // for aborted-during-fetch via the catch block; the new bailout
    // guards the post-deserialization path. Both paths must avoid
    // store mutations and UI updates.
    const { deps, getActionCallback } = createMockDeps(payload, {
      sideEffect: async () => {
        await Promise.resolve();
        abortCtrl.abort();
      },
    });

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate,
      renderSegments,
    });
    bridge.register();

    await getActionCallback()("test-action", []);

    // Must not mutate store or UI for an aborted action
    expect(renderSegments).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(store.setSegmentIds).not.toHaveBeenCalled();
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
    expect(completeFn).not.toHaveBeenCalled();
  });
});

describe("server-action-bridge error path race guard", () => {
  beforeEach(() => {
    setupWindow();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
  });

  it("skips UI/store mutations when user navigates during error renderSegments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMockStore();
    const { controller } = createMockEventController();
    const onUpdate = vi.fn();

    // Mock reconcileErrorSegments to return a minimal result
    vi.mocked(reconcileErrorSegments).mockReturnValue({
      segments: [],
      mainSegments: [],
      interceptSegments: [],
    });

    // renderSegments simulates user navigating away during async render
    const renderSegments = vi.fn(async () => {
      // Simulate navigation: change pathname
      (window as any).location.pathname = "/other-page";
      return "error-tree";
    });

    const payload: RscPayload = {
      metadata: {
        isPartial: true,
        isError: true,
        matched: ["root"],
        diff: ["error-seg"],
        segments: [],
      },
      returnValue: { ok: false, data: new Error("action failed") },
    } as any;

    const { deps, getActionCallback } = createMockDeps(payload);

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate,
      renderSegments,
    });
    bridge.register();

    // The action should throw the error but NOT apply UI/store updates
    await expect(getActionCallback()("test-action", [])).rejects.toThrow(
      "action failed",
    );

    // renderSegments was called (error tree was prepared)
    expect(renderSegments).toHaveBeenCalled();
    // But onUpdate must NOT be called (user navigated away)
    expect(onUpdate).not.toHaveBeenCalled();
    expect(store.setSegmentIds).not.toHaveBeenCalled();
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
  });

  it("skips UI/store mutations when history key changes during error renderSegments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const store = createMockStore();
    const { controller } = createMockEventController();
    const onUpdate = vi.fn();

    vi.mocked(reconcileErrorSegments).mockReturnValue({
      segments: [],
      mainSegments: [],
      interceptSegments: [],
    });

    // renderSegments simulates history key change during async render
    const renderSegments = vi.fn(async () => {
      store.getHistoryKey.mockReturnValue("/new-key");
      return "error-tree";
    });

    const payload: RscPayload = {
      metadata: {
        isPartial: true,
        isError: true,
        matched: ["root"],
        diff: ["error-seg"],
        segments: [],
      },
      returnValue: { ok: false, data: new Error("action failed") },
    } as any;

    const { deps, getActionCallback } = createMockDeps(payload);

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate,
      renderSegments,
    });
    bridge.register();

    await expect(getActionCallback()("test-action", [])).rejects.toThrow(
      "action failed",
    );

    expect(renderSegments).toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(store.setSegmentIds).not.toHaveBeenCalled();
    expect(store.cacheSegmentsForHistory).not.toHaveBeenCalled();
  });
});

describe("server-action-bridge header redirect abort safety", () => {
  let locationHrefSetter: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ locationHrefSetter } = setupWindow());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreGlobalProperty("window", originalWindowDescriptor);
  });

  it("does not navigate on X-RSC-Redirect when handle is aborted", async () => {
    const store = createMockStore();
    const { controller, completeFn, abortCtrl } = createMockEventController();
    const onNavigate = vi.fn();

    // Payload has no redirect — the redirect comes via response header.
    // After the header redirect is skipped (aborted), createFromFetch
    // resolves with this minimal payload that triggers the abort bailout.
    const payload: RscPayload = {
      metadata: { isPartial: true, matched: ["root"], diff: [], segments: [] },
      returnValue: { ok: true, data: "ignored" },
    } as any;

    // Abort synchronously during createFromFetch so that by the time the
    // fetch .then() microtask runs, handle.signal.aborted is already true.
    const { deps, getActionCallback } = createMockDeps(payload, {
      sideEffect: () => {
        abortCtrl.abort();
      },
      responseHeaders: { "X-RSC-Redirect": "/should-not-navigate" },
    });

    const bridge = createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController: controller as any,
      deps,
      onUpdate: vi.fn(),
      renderSegments: vi.fn(),
      onNavigate,
    });
    bridge.register();

    await getActionCallback()("test-action", []);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(completeFn).not.toHaveBeenCalled();
    expect(locationHrefSetter).not.toHaveBeenCalled();
  });
});
