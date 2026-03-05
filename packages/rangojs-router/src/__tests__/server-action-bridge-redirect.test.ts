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
  return {
    controller: {
      startAction: vi.fn(() => ({
        id: "test-action-1",
        abort: new AbortController(),
        signal: new AbortController().signal,
        startStreaming: vi.fn(() => ({ end: vi.fn() })),
        recordRevalidatedSegments: vi.fn(),
        complete: completeFn,
        fail: failFn,
        settled: false,
        hadConcurrentActions: false,
        getConsolidationSegments: vi.fn(() => null),
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
  };
}

/**
 * Build mock deps that resolve createFromFetch with the given payload.
 * Captures the handleServerAction callback via setServerCallback.
 */
function createMockDeps(payload: RscPayload) {
  let actionCallback: ((id: string, args: any[]) => Promise<any>) | null = null;

  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { "content-type": "text/x-component" },
        }),
      ),
    ),
  );

  return {
    deps: {
      createFromFetch: vi.fn(() => Promise.resolve(payload)) as any,
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
    expect(onNavigate).toHaveBeenCalledWith("/dashboard", {
      state: { __rsc_ls_tab: "home" },
      replace: true,
      _skipCache: true,
    });
    expect(result).toBe("redirect-result");
  });
});
