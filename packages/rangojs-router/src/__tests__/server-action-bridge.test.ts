import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventController } from "../browser/event-controller";
import { createServerActionBridge } from "../browser/server-action-bridge";

function createMockStore() {
  return {
    getSegmentState: vi.fn(() => ({
      path: "/",
      currentUrl: "http://localhost/",
      currentSegmentIds: ["R0"],
    })),
    markCacheAsStaleAndBroadcast: vi.fn(),
    getInterceptSourceUrl: vi.fn(() => null),
  };
}

function stubWindow() {
  vi.stubGlobal("window", {
    location: {
      href: "http://localhost/",
      pathname: "/",
      origin: "http://localhost",
    },
    history: {
      state: { key: "k1" },
      replaceState: vi.fn(),
    },
    dispatchEvent: vi.fn(),
  });
}

function setupBridge(payload: unknown, onNavigate = vi.fn(async () => {})) {
  const store = createMockStore();
  const eventController = createEventController();
  const setServerCallback = vi.fn();

  const deps = {
    createTemporaryReferenceSet: vi.fn(() => ({})),
    encodeReply: vi.fn(async () => ""),
    createFromFetch: vi.fn(async () => payload),
    setServerCallback,
  };

  const bridge = createServerActionBridge({
    store: store as any,
    client: {} as any,
    eventController,
    deps: deps as any,
    onUpdate: vi.fn(),
    renderSegments: vi.fn(async () => "tree"),
    onNavigate,
  });
  bridge.register();

  const callback = setServerCallback.mock.calls[0]?.[0] as
    | ((id: string, args: any[]) => Promise<unknown>)
    | undefined;

  if (!callback) {
    throw new Error("Expected setServerCallback to be called");
  }

  return { callback, onNavigate };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("server-action-bridge partial invariant", () => {
  it("rejects non-partial action response", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback } = setupBridge({
      metadata: {
        pathname: "/",
        segments: [{ id: "R0", component: "div" }],
        matched: ["R0"],
        diff: ["R0"],
        // isPartial is intentionally omitted
      },
      returnValue: { ok: true, data: "done" },
    });

    await expect(callback("hash#save", [])).rejects.toThrow(
      /Action response missing isPartial/,
    );
  });

  it("accepts partial action response", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { callback } = setupBridge({
      metadata: {
        pathname: "/",
        segments: [{ id: "R0", component: "div" }],
        matched: ["R0"],
        diff: ["R0"],
        isPartial: true,
      },
      returnValue: { ok: true, data: "result" },
    });

    // The partial payload passes the isPartial guard. It will fail later
    // on store.getHistoryKey (not mocked), but the invariant error is
    // distinct — verify we do NOT get the isPartial rejection.
    await expect(callback("hash#save", [])).rejects.toThrow(
      /getHistoryKey is not a function/,
    );
    await expect(callback("hash#save", [])).rejects.not.toThrow(
      /Action response missing isPartial/,
    );
  });
});

// #1029 left this lane as it was: an action does not change the history
// entry, so its location state reaches readers when the response is
// processed, ahead of the revalidated tree. What changed is the carrier: the
// controller's commit, flushed at once, instead of a window event.
describe("server-action-bridge location state", () => {
  it("commits and flushes an action's location state before its tree renders", async () => {
    const replaceState = vi.fn();
    vi.stubGlobal("window", {
      location: {
        href: "http://localhost/",
        pathname: "/",
        origin: "http://localhost",
      },
      history: { state: { key: "k1" }, replaceState },
      dispatchEvent: vi.fn(),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    const segment = { id: "R0", type: "route", component: "div" };
    const store = {
      ...createMockStore(),
      getHistoryKey: vi.fn(() => "/"),
      getCachedSegments: vi.fn(() => ({ segments: [segment], stale: false })),
      setSegmentIds: vi.fn(),
      cacheSegmentsForHistory: vi.fn(),
      rememberDisplayedEntry: vi.fn(),
      getHistoryEntryMemory: vi.fn(() => undefined),
      getRouterId: vi.fn(() => undefined),
    };
    const eventController = createEventController();
    const before = eventController.getLocationStateCommit();
    const order: string[] = [];
    eventController.subscribe(() => {
      if (eventController.getLocationStateCommit() !== before) {
        order.push("readers notified");
      }
    });
    const setServerCallback = vi.fn();
    createServerActionBridge({
      store: store as any,
      client: {} as any,
      eventController,
      deps: {
        createTemporaryReferenceSet: vi.fn(() => ({})),
        encodeReply: vi.fn(async () => ""),
        createFromFetch: vi.fn(async () => ({
          metadata: {
            pathname: "/",
            segments: [segment],
            matched: ["R0"],
            diff: ["R0"],
            isPartial: true,
            locationState: { __rsc_ls_note: "from-action" },
          },
          returnValue: { ok: true, data: "done" },
        })),
        setServerCallback,
      } as any,
      onUpdate: vi.fn(() => void order.push("tree committed")),
      renderSegments: vi.fn(async () => {
        order.push("tree rendered");
        return "tree";
      }),
    }).register();

    await expect(
      setServerCallback.mock.calls[0]![0]("hash#save", []),
    ).resolves.toBe("done");

    expect(replaceState.mock.calls[0]![0]).toMatchObject({
      __rsc_ls_note: "from-action",
    });
    const commit = eventController.getLocationStateCommit();
    expect(commit).not.toBe(before);
    expect(commit.traversal).toBe(false);
    expect(order.slice(0, 3)).toEqual([
      "readers notified",
      "tree rendered",
      "tree committed",
    ]);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
});

describe("server-action-bridge redirect payload validation", () => {
  it("allows same-origin redirect payload", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );

    const { callback, onNavigate } = setupBridge({
      metadata: {
        redirect: { url: "/safe" },
        locationState: { __rsc_ls_flash: "ok" },
      },
      returnValue: { ok: true, data: "done" },
    });

    const result = await callback("hash#save", []);

    expect(onNavigate).toHaveBeenCalledWith("http://localhost/safe", {
      state: { __rsc_ls_flash: "ok" },
      replace: true,
      _skipCache: true,
    });
    expect(result).toBe("done");
  });

  it("blocks cross-origin redirect payload", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    const { callback, onNavigate } = setupBridge({
      metadata: {
        redirect: { url: "https://evil.example/phish" },
      },
      returnValue: { ok: true, data: "done" },
    });

    const result = await callback("hash#save", []);

    expect(onNavigate).not.toHaveBeenCalled();
    expect(result).toBe("done");
  });
});
