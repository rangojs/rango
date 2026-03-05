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
