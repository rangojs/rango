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
    getCachedSegments: vi.fn(() => undefined),
    hasHistoryCache: vi.fn(() => false),
    cacheSegmentsForHistory: vi.fn(),
    setInterceptSourceUrl: vi.fn(),
    setCrossTabRefreshCallback: vi.fn(),
  };
}

function createEventController() {
  return {
    abortNavigation: vi.fn(),
    getHandleState: vi.fn(() => ({ data: {} })),
  };
}

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
