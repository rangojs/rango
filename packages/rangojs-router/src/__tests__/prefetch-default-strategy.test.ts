import { describe, it, expect, afterEach, vi } from "vitest";

describe("default prefetch strategy (client seat)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // The invariant default-strategy.ts documents: during SSR (and under an
  // older server that ships no metadata) the module is never initialized, so
  // its initial value MUST equal the server resolver's default or the two
  // seats drift.
  it("initial value is none outside production", async () => {
    const { getDefaultPrefetchStrategy } =
      await import("../browser/prefetch/default-strategy.js");
    expect(getDefaultPrefetchStrategy()).toBe("none");
  });

  it("initial value is viewport in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { getDefaultPrefetchStrategy } =
      await import("../browser/prefetch/default-strategy.js");
    expect(getDefaultPrefetchStrategy()).toBe("viewport");
  });

  it("set/get roundtrips every strategy", async () => {
    const { getDefaultPrefetchStrategy, setDefaultPrefetchStrategy } =
      await import("../browser/prefetch/default-strategy.js");
    for (const strategy of [
      "hover",
      "viewport",
      "render",
      "adaptive",
      "none",
    ] as const) {
      setDefaultPrefetchStrategy(strategy);
      expect(getDefaultPrefetchStrategy()).toBe(strategy);
    }
  });

  it("reads the current matchMedia result for each adaptive tree", async () => {
    const firstMatchMedia = vi.fn(() => ({ matches: false }) as MediaQueryList);
    vi.stubGlobal("window", { matchMedia: firstMatchMedia });
    const { resolveAdaptiveStrategy } =
      await import("../browser/prefetch/default-strategy.js");

    expect(resolveAdaptiveStrategy("adaptive")).toBe("hover");
    const secondMatchMedia = vi.fn(() => ({ matches: true }) as MediaQueryList);
    window.matchMedia = secondMatchMedia;
    expect(resolveAdaptiveStrategy("adaptive")).toBe("viewport");
    expect(firstMatchMedia).toHaveBeenCalledOnce();
    expect(secondMatchMedia).toHaveBeenCalledOnce();
  });

  it("subscribes through legacy MediaQueryList listeners when needed", async () => {
    const listener = vi.fn();
    const addListener = vi.fn();
    const removeListener = vi.fn();
    vi.stubGlobal("window", {
      matchMedia: () => ({ matches: false, addListener, removeListener }),
    });
    const { subscribeToAdaptiveStrategyChange } =
      await import("../browser/prefetch/default-strategy.js");

    const cleanup = subscribeToAdaptiveStrategyChange(listener);

    expect(addListener).toHaveBeenCalledWith(listener);
    cleanup();
    expect(removeListener).toHaveBeenCalledWith(listener);
  });
});
