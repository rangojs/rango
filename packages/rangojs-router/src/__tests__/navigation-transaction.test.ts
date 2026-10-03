import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock scroll-restoration (touches DOM/history state internals)
vi.mock("../browser/scroll-restoration", () => ({
  handleNavigationStart: vi.fn(),
  handleNavigationEnd: vi.fn(),
  ensureHistoryKey: vi.fn(),
  getHistoryStateKey: vi.fn(() => "entry-key"),
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

  // #1029: commit() moves history and the controller's location-state commit
  // identity, and tells no reader itself. Readers are state listeners: they
  // run when the caller's payload update flushes the notification, so the
  // read lands in that update's lane, with the destination's tree.
  describe("location state commit", () => {
    type CommitFlags = {
      replace?: boolean;
      traversal?: boolean;
      storeOnly?: boolean;
      cacheOnly?: boolean;
      intercept?: boolean;
      interceptSourceUrl?: string;
      state?: unknown;
    };
    function commitOf(
      flags: CommitFlags,
      previous: unknown = { __rsc_ls_product: { name: "Widget" }, key: "abc" },
    ) {
      const { store, eventController } = createTestContext();
      historyState = previous;
      const before = eventController.getLocationStateCommit();
      const heard: unknown[] = [];
      eventController.subscribe(() => heard.push(historyState));
      const tx = createNavigationTransaction(
        store,
        eventController,
        "http://localhost/other",
      );
      // startNavigation's own notification: out of the way.
      eventController.flushRouteState();
      heard.length = 0;
      tx.commit({
        url: "http://localhost/other",
        segmentIds: ["root"],
        segments: [],
        ...flags,
      });
      return { tx, eventController, before, heard };
    }

    it.each([
      { label: "push", options: {}, traversal: false },
      { label: "replace", options: { replace: true }, traversal: false },
      { label: "back/forward", options: { traversal: true }, traversal: true },
      {
        // A modal over the page: its entry carries the Link's state only.
        label: "intercept push",
        options: {
          intercept: true,
          interceptSourceUrl: "http://localhost/start",
        },
        traversal: false,
      },
    ])(
      "a $label commit moves the identity (traversal: $traversal) and notifies on the flush, not before",
      ({ options, traversal }) => {
        const { tx, eventController, before, heard } = commitOf({
          ...options,
          state: { from: "list" },
        });

        const after = eventController.getLocationStateCommit();
        expect(after).not.toBe(before);
        expect(after.traversal).toBe(traversal);
        expect(heard).toEqual([]);

        eventController.flushRouteState();
        // One notification, with history already at the committed entry.
        expect(heard).toEqual([window.history.state]);
        expect(window.dispatchEvent).not.toHaveBeenCalled();
        tx[Symbol.dispose]();
      },
    );

    it("moves the identity when neither entry carries location state", () => {
      // A reader mounted over a static write() has to drop it with the entry.
      const { tx, eventController, before } = commitOf({}, { key: "abc" });
      expect(eventController.getLocationStateCommit()).not.toBe(before);
      tx[Symbol.dispose]();
    });

    it.each([
      { label: "storeOnly (action refetch)", options: { storeOnly: true } },
      { label: "cacheOnly (stale revalidation)", options: { cacheOnly: true } },
    ])("a $label commit leaves the entry's state alone", ({ options }) => {
      const { tx, eventController, before } = commitOf(options);
      expect(eventController.getLocationStateCommit()).toBe(before);
      expect(window.dispatchEvent).not.toHaveBeenCalled();
      tx[Symbol.dispose]();
    });
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

describe("createNavigationTransaction traversal commit", () => {
  let handleNavigationStart: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const scroll = await import("../browser/scroll-restoration");
    handleNavigationStart = vi.mocked(scroll.handleNavigationStart);
    handleNavigationStart.mockClear();
  });

  it("keeps the history entry the browser restored and saves no scroll", () => {
    const { store, eventController } = createTestContext();
    const entryState = {
      key: "k-entry",
      idx: 3,
      state: { from: "list" },
      __rsc_ls_origin: { from: "origin-link" },
    };
    historyState = entryState;

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/start",
      { replace: true },
    );
    tx.commit({
      url: "http://localhost/start",
      segmentIds: [],
      segments: [],
      traversal: true,
    });

    expect(handleNavigationStart).not.toHaveBeenCalled();
    expect(pushStateSpy).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
    expect(historyState).toBe(entryState);
    expect(store.getHistoryKey()).toBe("/start");
    tx[Symbol.dispose]();
  });

  it("merges server-set state into the entry instead of replacing it", () => {
    const { store, eventController } = createTestContext();
    historyState = { key: "k-entry", idx: 3, state: { from: "list" } };

    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/start",
      { replace: true },
    );
    tx.commit({
      url: "http://localhost/start",
      segmentIds: [],
      segments: [],
      traversal: true,
      serverState: { __rsc_ls_flash: { text: "saved" } },
    });

    expect(replaceStateSpy).toHaveBeenCalledOnce();
    expect(historyState).toEqual({
      key: "k-entry",
      idx: 3,
      state: { from: "list" },
      __rsc_ls_flash: { text: "saved" },
    });
    tx[Symbol.dispose]();
  });
});
