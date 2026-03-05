import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scroll-restoration (touches DOM/history state internals)
vi.mock("../browser/scroll-restoration", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  ensureHistoryKey: vi.fn(),
}));

// Mock logging to keep test output clean
vi.mock("../browser/logging", () => ({
  debugLog: vi.fn(),
}));

// Provide minimal window/history/location globals for Node
// createNavigationTransaction reads and writes window.location.href,
// window.history.state, pushState, and replaceState.

let historyState: any = null;
let locationHref = "http://localhost/start";
const pushStateSpy = vi.fn();
const replaceStateSpy = vi.fn();

function setupGlobals(initialHref = "http://localhost/start") {
  locationHref = initialHref;
  historyState = null;

  pushStateSpy.mockImplementation((state: any, _title: string, url?: any) => {
    historyState = state;
    if (typeof url === "string") {
      locationHref = new URL(url, "http://localhost").href;
    }
  });

  replaceStateSpy.mockImplementation(
    (state: any, _title: string, url?: any) => {
      historyState = state;
      if (typeof url === "string") {
        locationHref = new URL(url, "http://localhost").href;
      }
    },
  );

  const locationProxy = {
    get href() {
      return locationHref;
    },
    set href(v: string) {
      locationHref = v;
    },
    get origin() {
      return "http://localhost";
    },
  };

  const historyProxy = {
    pushState: pushStateSpy,
    replaceState: replaceStateSpy,
    get state() {
      return historyState;
    },
    get length() {
      return 1;
    },
  };

  (globalThis as any).window = {
    location: locationProxy,
    history: historyProxy,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };

  // Also expose on globalThis for modules that read window directly
  (globalThis as any).location = locationProxy;
  (globalThis as any).history = historyProxy;
}

function cleanupGlobals() {
  delete (globalThis as any).window;
  delete (globalThis as any).location;
  delete (globalThis as any).history;
  pushStateSpy.mockReset();
  replaceStateSpy.mockReset();
}

// Import after setting up mocks but the actual import is deferred via dynamic import
// to ensure the globals are in place when the module evaluates.
let createNavigationTransaction: typeof import("../browser/navigation-transaction").createNavigationTransaction;
let createNavigationStore: typeof import("../browser/navigation-store").createNavigationStore;
let createEventController: typeof import("../browser/event-controller").createEventController;

beforeEach(async () => {
  setupGlobals();

  // Dynamic import after globals are set up
  const txMod = await import("../browser/navigation-transaction");
  createNavigationTransaction = txMod.createNavigationTransaction;

  const storeMod = await import("../browser/navigation-store");
  createNavigationStore = storeMod.createNavigationStore;

  const controllerMod = await import("../browser/event-controller");
  createEventController = controllerMod.createEventController;
});

afterEach(() => {
  cleanupGlobals();
  vi.restoreAllMocks();
});

function createTestContext(href = "http://localhost/start") {
  const store = createNavigationStore({
    initialLocation: { href },
    crossTabSync: false,
  });

  const eventController = createEventController({
    initialLocation: new URL(href),
  });

  return { store, eventController };
}

describe("createNavigationTransaction", () => {
  it("does not push state before commit", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" } },
    );

    // No history change until commit
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(locationHref).toBe("http://localhost/start");

    tx.commit({
      url: "http://localhost/target",
      segmentIds: [],
      segments: [],
      state: { productName: "Widget" },
    });

    // Now the URL is updated
    expect(pushStateSpy).toHaveBeenCalledOnce();
    expect(locationHref).toBe("http://localhost/target");

    tx[Symbol.dispose]();
  });

  it("URL stays at origin on failed navigation (no commit)", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" } },
    );

    // Dispose without committing (simulates navigation failure)
    tx[Symbol.dispose]();

    // URL unchanged — no push happened
    expect(locationHref).toBe("http://localhost/start");
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("URL stays at origin on failed navigation without state", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
    );

    expect(locationHref).toBe("http://localhost/start");

    tx[Symbol.dispose]();

    expect(locationHref).toBe("http://localhost/start");
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("keeps target URL after successful commit", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" } },
    );

    tx.commit({
      url: "http://localhost/target",
      segmentIds: ["root"],
      segments: [],
      state: { productName: "Widget" },
    });

    replaceStateSpy.mockClear();

    tx[Symbol.dispose]();

    expect(locationHref).toBe("http://localhost/target");
  });

  it("superseded navigation does not touch URL", () => {
    const { store, eventController } = createTestContext();

    const txA = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target-a",
      { state: { productName: "Widget" } },
    );

    // No early push — URL is still at start
    expect(locationHref).toBe("http://localhost/start");

    // Abort A (simulates newer navigation taking over)
    eventController.abortNavigation();

    txA[Symbol.dispose]();

    // URL unchanged — A never pushed
    expect(locationHref).toBe("http://localhost/start");
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("cacheOnly commit completes the navigation handle", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { skipLoadingState: true, replace: true },
    );

    // Before commit: navigation is in-flight
    expect(eventController.getState().state).toBe("idle"); // skipLoadingState

    tx.commit({
      url: "http://localhost/target",
      segmentIds: ["root"],
      segments: [],
      cacheOnly: true,
    });
    tx[Symbol.dispose]();

    // After cacheOnly commit + dispose: navigation handle should be cleared
    // (no dangling currentNavigation entry)
    expect(eventController.getState().state).toBe("idle");
    // Starting a new navigation should work without aborting a stale one
    const tx2 = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/other",
    );
    tx2.commit({
      url: "http://localhost/other",
      segmentIds: ["root"],
      segments: [],
    });
    tx2[Symbol.dispose]();
  });
});
