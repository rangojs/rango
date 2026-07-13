import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  setPrefetchDecoder: vi.fn(),
  setPrefetchConcurrency: vi.fn(),
  prefetchDirect: vi.fn(),
  prefetchQueued: vi.fn(() => "key"),
  cancelAllPrefetches: vi.fn(),
  abortAllPrefetches: vi.fn(),
}));

vi.mock("../browser/prefetch/runtime", () => runtime);

describe("lazy prefetch loader", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("stores configuration without loading the runtime", async () => {
    const loader = await import("../browser/prefetch/loader");
    const decoder = vi.fn();

    loader.setPrefetchDecoder(decoder);
    loader.setPrefetchConcurrency(4);

    expect(runtime.setPrefetchDecoder).not.toHaveBeenCalled();
    expect(runtime.setPrefetchConcurrency).not.toHaveBeenCalled();
  });

  it("runs scheduled prefetch work immediately when the router is idle", async () => {
    const loader = await import("../browser/prefetch/loader");
    const callback = vi.fn();
    const subscribe = vi.fn();

    const eventController = {
      getState: () => ({ state: "idle", isStreaming: false }),
      subscribe,
    } as unknown as Parameters<typeof loader.schedulePrefetchWhenRouterIdle>[0];

    const cleanup = loader.schedulePrefetchWhenRouterIdle(
      eventController,
      callback,
    );

    expect(callback).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
    expect(cleanup).toBeUndefined();
  });

  it("unsubscribes before running scheduled work after the router becomes idle", async () => {
    const loader = await import("../browser/prefetch/loader");
    const calls: string[] = [];
    let isIdle = false;
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn(() => calls.push("unsubscribe"));

    const eventController = {
      getState: () => ({
        state: isIdle ? "idle" : "loading",
        isStreaming: !isIdle,
      }),
      subscribe: (next: () => void) => {
        listener = next;
        return unsubscribe;
      },
    } as unknown as Parameters<typeof loader.schedulePrefetchWhenRouterIdle>[0];

    const cleanup = loader.schedulePrefetchWhenRouterIdle(eventController, () =>
      calls.push("callback"),
    );

    expect(calls).toEqual([]);
    expect(cleanup).toBe(unsubscribe);

    isIdle = true;
    listener!();
    expect(calls).toEqual(["unsubscribe", "callback"]);
  });

  it("loads and configures the runtime on the first prefetch", async () => {
    const loader = await import("../browser/prefetch/loader");
    const decoder = vi.fn();
    loader.setPrefetchDecoder(decoder);
    loader.setPrefetchConcurrency(4);

    loader.prefetchDirect("/next", ["root"], "v1", "router");

    await vi.waitFor(() => {
      expect(runtime.prefetchDirect).toHaveBeenCalledWith(
        "/next",
        ["root"],
        "v1",
        "router",
        undefined,
      );
    });
    expect(runtime.setPrefetchDecoder).toHaveBeenCalledWith(decoder);
    expect(runtime.setPrefetchConcurrency).toHaveBeenCalledWith(4);
  });

  it("calls an already-loaded runtime synchronously", async () => {
    const loader = await import("../browser/prefetch/loader");
    loader.prefetchDirect("/first", []);
    await vi.waitFor(() => expect(runtime.prefetchDirect).toHaveBeenCalled());
    runtime.prefetchDirect.mockClear();

    loader.prefetchDirect("/second", ["root"]);

    expect(runtime.prefetchDirect).toHaveBeenCalledWith(
      "/second",
      ["root"],
      undefined,
      undefined,
      undefined,
    );
  });

  it("drops a prefetch when navigation starts before the runtime loads", async () => {
    const loader = await import("../browser/prefetch/loader");
    loader.setPrefetchDecoder(vi.fn());

    loader.prefetchDirect("/next", ["root"]);
    loader.cancelAllPrefetches("/next");

    await vi.waitFor(() =>
      expect(runtime.setPrefetchDecoder).toHaveBeenCalled(),
    );
    expect(runtime.prefetchDirect).not.toHaveBeenCalled();
  });

  it("drops a prefetch when invalidation starts before the runtime loads", async () => {
    const loader = await import("../browser/prefetch/loader");
    loader.setPrefetchDecoder(vi.fn());

    loader.prefetchDirect("/next", ["root"]);
    loader.abortAllPrefetches();

    await vi.waitFor(() =>
      expect(runtime.setPrefetchDecoder).toHaveBeenCalled(),
    );
    expect(runtime.prefetchDirect).not.toHaveBeenCalled();
  });

  it("forwards cancellation once the runtime is loaded", async () => {
    const loader = await import("../browser/prefetch/loader");
    loader.prefetchDirect("/first", []);
    await vi.waitFor(() => expect(runtime.prefetchDirect).toHaveBeenCalled());

    loader.cancelAllPrefetches("/keep");
    loader.abortAllPrefetches();

    expect(runtime.cancelAllPrefetches).toHaveBeenCalledWith("/keep");
    expect(runtime.abortAllPrefetches).toHaveBeenCalledTimes(1);
  });
});
