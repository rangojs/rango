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
let createNavigationTransaction: typeof import("../browser/navigation-bridge").createNavigationTransaction;
let createNavigationStore: typeof import("../browser/navigation-store").createNavigationStore;
let createEventController: typeof import("../browser/event-controller").createEventController;

beforeEach(async () => {
  setupGlobals();

  // Dynamic import after globals are set up
  const bridgeMod = await import("../browser/navigation-bridge");
  createNavigationTransaction = bridgeMod.createNavigationTransaction;

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
  it("pushes state to history immediately when state is provided", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" } },
    );

    expect(pushStateSpy).toHaveBeenCalledOnce();
    expect(locationHref).toBe("http://localhost/target");

    // Commit to prevent dispose from rolling back
    tx.commit({
      url: "http://localhost/target",
      segmentIds: [],
      segments: [],
    });
    tx[Symbol.dispose]();
  });

  it("does not push early state when replace is true", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" }, replace: true },
    );

    // pushState should not have been called for early state
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(locationHref).toBe("http://localhost/start");

    tx[Symbol.dispose]();
  });

  it("keeps target URL on failed navigation — error UI owns it", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { state: { productName: "Widget" } },
    );

    expect(locationHref).toBe("http://localhost/target");

    // Dispose without committing (simulates navigation failure)
    tx[Symbol.dispose]();

    // URL stays at target — the error UI is rendered for this destination
    expect(locationHref).toBe("http://localhost/target");
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("keeps target URL on failed navigation without state", () => {
    const { store, eventController } = createTestContext();

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
    );

    // No early push without state — URL is still at start
    expect(locationHref).toBe("http://localhost/start");

    tx[Symbol.dispose]();

    // URL unchanged — no early push happened
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
    });

    replaceStateSpy.mockClear();

    tx[Symbol.dispose]();

    expect(locationHref).toBe("http://localhost/target");
  });

  it("rolls back URL when superseded and new nav has not pushed yet", () => {
    const { store, eventController } = createTestContext();

    const txA = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target-a",
      { state: { productName: "Widget" } },
    );

    expect(locationHref).toBe("http://localhost/target-a");

    // Abort A (simulates the first thing navigate() does for B)
    eventController.abortNavigation();

    // B has NOT pushed yet — A still owns the URL
    txA[Symbol.dispose]();

    // A correctly rolled back since URL was still its target
    expect(locationHref).toBe("http://localhost/start");
  });

  it("does not overwrite newer navigation's URL on superseded dispose", () => {
    const { store, eventController } = createTestContext();

    // Nav A starts with state — early pushes to target-a
    const txA = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target-a",
      { state: { from: "list" } },
    );
    expect(locationHref).toBe("http://localhost/target-a");

    // Nav B aborts A and creates its own transaction with state.
    // This mirrors the real navigate() flow: abort first, then create tx.
    eventController.abortNavigation();
    const txB = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target-b",
      { state: { from: "search" } },
    );
    expect(locationHref).toBe("http://localhost/target-b");

    // Now A's dispose fires (like the microtask-deferred using cleanup).
    // It must NOT overwrite B's URL.
    txA[Symbol.dispose]();
    expect(locationHref).toBe("http://localhost/target-b");
    // replaceState should not have been called for A's rollback
    expect(replaceStateSpy).not.toHaveBeenCalled();

    // Clean up B
    txB.commit({
      url: "http://localhost/target-b",
      segmentIds: ["root"],
      segments: [],
    });
    txB[Symbol.dispose]();
  });

  it("does not clobber newer navigation when both target the same URL", () => {
    const { store, eventController } = createTestContext();

    // Nav A navigates to /product with state { view: "gallery" }
    const txA = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/product",
      { state: { view: "gallery" } },
    );
    expect(locationHref).toBe("http://localhost/product");

    // Nav B aborts A and navigates to the SAME URL with different state.
    // This happens when the user clicks a link to the same page but with
    // different state (e.g., switching tabs on a product page).
    eventController.abortNavigation();
    const txB = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/product",
      { state: { view: "details" } },
    );
    expect(locationHref).toBe("http://localhost/product");

    // A's dispose fires. Without stamp-based ownership, A would see
    // window.location.href === url and roll back, clobbering B's state.
    txA[Symbol.dispose]();

    // B's URL and state must survive
    expect(locationHref).toBe("http://localhost/product");
    // B's state should be the current history state (not A's or the original).
    // buildHistoryState wraps plain objects as { state: <value> }.
    expect(historyState).toHaveProperty("state");
    expect(historyState.state).toEqual({ view: "details" });
    // replaceState should NOT have been called for A's rollback
    expect(replaceStateSpy).not.toHaveBeenCalled();

    // Clean up B
    txB.commit({
      url: "http://localhost/product",
      segmentIds: ["root"],
      segments: [],
    });
    txB[Symbol.dispose]();
  });

  it("still rolls back superseded navigation when no newer push has happened", () => {
    const { store, eventController } = createTestContext();

    // Nav A navigates to /product with state
    const txA = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/product",
      { state: { view: "gallery" } },
    );
    expect(locationHref).toBe("http://localhost/product");

    // Abort A, but do NOT start a new navigation that pushes state
    eventController.abortNavigation();

    // A's dispose fires — A's stamp is still in history.state, so rollback is valid
    txA[Symbol.dispose]();

    // Should roll back to the original URL
    expect(locationHref).toBe("http://localhost/start");
  });
});
