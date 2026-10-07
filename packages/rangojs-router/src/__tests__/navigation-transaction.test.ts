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

  // #1029: commit() hands the controller the entry state it pushed, restored
  // or merged, and notifies no reader. NavigationProvider takes the recorded
  // state in the update that renders the entry's payload; only a commit the
  // caller marks treeless rides the state notification.
  describe("location state commit", () => {
    type CommitFlags = {
      replace?: boolean;
      traversal?: boolean;
      storeOnly?: boolean;
      cacheOnly?: boolean;
      intercept?: boolean;
      interceptSourceUrl?: string;
      state?: unknown;
      serverState?: Record<string, unknown>;
      treeless?: boolean;
    };
    const SOURCE = { __rsc_ls_product: { name: "Widget" }, key: "abc" };
    function commitOf(flags: CommitFlags, previous: unknown = SOURCE) {
      const { store, eventController } = createTestContext();
      historyState = previous;
      eventController.commitLocationState(previous);
      const before = eventController.getLocationState();
      const heard = vi.fn();
      eventController.subscribe(heard);
      const tx = createNavigationTransaction(
        store,
        eventController,
        "http://localhost/other",
      );
      // startNavigation's own notification: out of the way.
      eventController.flushRouteState();
      heard.mockClear();
      const commitSpy = vi.spyOn(eventController, "commitLocationState");
      tx.commit({
        url: "http://localhost/other",
        segmentIds: ["root"],
        segments: [],
        ...flags,
      });
      return { tx, eventController, before, heard, commitSpy };
    }

    it.each([
      { label: "push", options: {} },
      { label: "replace", options: { replace: true } },
      {
        // A modal over the page: its entry carries the Link's state only.
        label: "intercept push",
        options: {
          intercept: true,
          interceptSourceUrl: "http://localhost/start",
        },
      },
    ])("a $label commit records the state object it pushes", ({ options }) => {
      const { tx, eventController, commitSpy } = commitOf({
        ...options,
        state: { from: "list" },
      });

      // The object handed to history, before the idx stamp: one source.
      const pushed = (
        options.replace ? replaceStateSpy : pushStateSpy
      ).mock.calls.at(-1)![0];
      expect(commitSpy).toHaveBeenCalledOnce();
      expect(pushed).toMatchObject(commitSpy.mock.calls[0][0] as object);
      expect(eventController.getLocationState()).toEqual({
        state: { from: "list" },
      });
      expect(window.dispatchEvent).not.toHaveBeenCalled();
      tx[Symbol.dispose]();
    });

    it("a back/forward commit records the entry history restored, with server-set state merged in", () => {
      // history is already at the destination entry.
      const restored = { __rsc_ls_product: { name: "Restored" }, key: "dest" };
      const plain = commitOf({ traversal: true }, restored);
      expect(plain.commitSpy).toHaveBeenCalledWith(restored, undefined);
      expect(pushStateSpy).not.toHaveBeenCalled();
      plain.tx[Symbol.dispose]();

      const merged = commitOf(
        { traversal: true, serverState: { __rsc_ls_flash: "saved" } },
        restored,
      );
      expect(merged.eventController.getLocationState()).toEqual({
        __rsc_ls_product: { name: "Restored" },
        __rsc_ls_flash: "saved",
      });
      // What was recorded is what was written to the entry.
      expect(merged.commitSpy.mock.calls[0][0]).toBe(
        replaceStateSpy.mock.calls.at(-1)![0],
      );
      merged.tx[Symbol.dispose]();
    });

    it("notifies no listener: the provider takes the state with the payload", () => {
      const { tx, eventController, heard } = commitOf({
        state: { from: "list" },
      });
      // handle.complete() notifies once; that notification carries no cue to
      // take location state.
      eventController.flushRouteState();
      expect(heard).toHaveBeenCalledOnce();
      expect(eventController.takeTreelessLocationState()).toBe(false);
      tx[Symbol.dispose]();
    });

    it.each([
      { label: "push", options: {} },
      { label: "back/forward", options: { traversal: true } },
    ])(
      "a treeless $label commit hands the state over with its notification",
      ({ options }) => {
        const { tx, eventController } = commitOf({
          ...options,
          state: { from: "list" },
          treeless: true,
        });
        expect(eventController.takeTreelessLocationState()).toBe(true);
        tx[Symbol.dispose]();
      },
    );

    it("records an entry without location state as none", () => {
      // A reader has to drop the previous entry's value with the entry.
      const { tx, eventController, before } = commitOf({});
      expect(before).toEqual({ __rsc_ls_product: { name: "Widget" } });
      expect(eventController.getLocationState()).toBeUndefined();
      tx[Symbol.dispose]();
    });

    it.each([
      { label: "storeOnly (action refetch)", options: { storeOnly: true } },
      { label: "cacheOnly (stale revalidation)", options: { cacheOnly: true } },
    ])("a $label commit leaves the entry's state alone", ({ options }) => {
      const { tx, eventController, before, commitSpy } = commitOf(options);
      expect(commitSpy).not.toHaveBeenCalled();
      expect(eventController.getLocationState()).toBe(before);
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

// prefetch: false (docs/design/prefetch-false.md, "Abort"): a fill is
// cancelled when the tree it belongs to is replaced, not when a navigation
// merely starts.
describe("createNavigationTransaction and a pending fill", () => {
  async function pendingFill() {
    const { setPendingFill, cancelPendingFill } =
      await import("../browser/pending-fill");
    const cancel = vi.fn();
    setPendingFill(cancel);
    return { cancel, cancelPendingFill };
  }

  function transaction(options: Record<string, unknown>) {
    const { store, eventController } = createTestContext();
    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      { replace: true },
    );
    return {
      tx,
      commit: () => {
        tx.commit({
          url: "http://localhost/target",
          segmentIds: [],
          segments: [],
          ...options,
        });
        tx[Symbol.dispose]();
      },
    };
  }

  it("is not cancelled by a navigation that only starts", async () => {
    const { cancel, cancelPendingFill } = await pendingFill();
    const { tx } = transaction({});
    expect(cancel).not.toHaveBeenCalled();
    tx[Symbol.dispose]();
    expect(cancel).not.toHaveBeenCalled();
    cancelPendingFill();
  });

  it.each([{}, { traversal: true }])(
    "is cancelled by a commit that replaces the page (%o)",
    async (options) => {
      const { cancel } = await pendingFill();
      transaction(options).commit();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each([{ storeOnly: true }, { cacheOnly: true }])(
    "survives a commit that keeps the page (%o)",
    async (options) => {
      const { cancel, cancelPendingFill } = await pendingFill();
      transaction(options).commit();
      expect(cancel).not.toHaveBeenCalled();
      cancelPendingFill();
    },
  );
});

// Scroll belongs to the navigation transaction. A navigation always decides,
// and "do not scroll" is a decision. A commit that is not a navigation
// decides nothing: its update carries no scroll and leaves a pending
// decision alone (react/NavigationProvider.tsx).
describe("what a commit says about scroll", () => {
  function commit(
    options: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ) {
    const { store, eventController } = createTestContext();
    const tx = createNavigationTransaction(
      store,
      eventController,
      "http://localhost/target",
      {},
    );
    const result = tx
      .with({ url: "http://localhost/target", ...options })
      .commit([], [], overrides);
    tx[Symbol.dispose]();
    return result;
  }

  it("a navigation decides, also when it decides not to scroll", () => {
    expect(commit({})).toEqual({ scroll: { enabled: undefined } });
    expect(commit({ scroll: true })).toEqual({ scroll: { enabled: true } });
    // <Link scroll={false}>, router.replace(url, { scroll: false }).
    expect(commit({ scroll: false })).toEqual({ scroll: { enabled: false } });
    // An intercept: partial-update.ts overrides the bound option.
    expect(commit({}, { scroll: false, intercept: true })).toEqual({
      scroll: { enabled: false },
    });
    expect(commit({ traversal: true, scroll: false })).toEqual({
      scroll: { enabled: false },
    });
  });

  it.each([
    ["an action refetch into the entry on screen", { storeOnly: true }],
    ["a cache-only commit", { cacheOnly: true }],
  ])("%s decides nothing", (_label, options) => {
    expect(commit(options)).toEqual({});
    // Whatever the options said: it is not a navigation.
    expect(commit({ ...options, scroll: true })).toEqual({});
  });
});
