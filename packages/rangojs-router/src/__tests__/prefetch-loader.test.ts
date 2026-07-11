import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  setPrefetchDecoder: vi.fn(),
  setPrefetchConcurrency: vi.fn(),
  prefetchDirect: vi.fn(),
  prefetchQueued: vi.fn(() => "key"),
  observeForPrefetch: vi.fn(),
  unobserveForPrefetch: vi.fn(),
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

  it("does not attach an observer after its link has unmounted", async () => {
    vi.stubGlobal("IntersectionObserver", class {});
    const loader = await import("../browser/prefetch/loader");
    loader.setPrefetchDecoder(vi.fn());
    const element = {} as Element;
    const cleanup = loader.observeForPrefetch(element, vi.fn());

    cleanup();
    await vi.waitFor(() =>
      expect(runtime.setPrefetchDecoder).toHaveBeenCalled(),
    );

    expect(runtime.observeForPrefetch).not.toHaveBeenCalled();
  });

  it("does not load the runtime when IntersectionObserver is unavailable", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const loader = await import("../browser/prefetch/loader");

    const cleanup = loader.observeForPrefetch({} as Element, vi.fn());

    cleanup();
    await Promise.resolve();
    expect(runtime.observeForPrefetch).not.toHaveBeenCalled();
    expect(runtime.setPrefetchDecoder).not.toHaveBeenCalled();
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

  it("observes and cleans up synchronously once the runtime is loaded", async () => {
    vi.stubGlobal("IntersectionObserver", class {});
    const loader = await import("../browser/prefetch/loader");
    loader.prefetchDirect("/first", []);
    await vi.waitFor(() => expect(runtime.prefetchDirect).toHaveBeenCalled());
    const element = {} as Element;
    const callback = vi.fn();

    const cleanup = loader.observeForPrefetch(element, callback);
    expect(runtime.observeForPrefetch).toHaveBeenCalledWith(element, callback);

    cleanup();
    expect(runtime.unobserveForPrefetch).toHaveBeenCalledWith(element);
  });
});
