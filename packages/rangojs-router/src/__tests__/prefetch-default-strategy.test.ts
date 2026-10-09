import { describe, it, expect, afterEach, vi } from "vitest";

describe("default prefetch strategy (client seat)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // A payload without `defaultPrefetch` (and SSR, which never reads payload
  // metadata here) falls back to this constant, so it MUST equal the server
  // resolver's environment default or the two seats drift.
  it("the environment default is none outside production", async () => {
    const { ENVIRONMENT_DEFAULT_PREFETCH } =
      await import("../browser/prefetch/default-strategy.js");
    expect(ENVIRONMENT_DEFAULT_PREFETCH).toBe("none");
  });

  it("the environment default is viewport in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { ENVIRONMENT_DEFAULT_PREFETCH } =
      await import("../browser/prefetch/default-strategy.js");
    expect(ENVIRONMENT_DEFAULT_PREFETCH).toBe("viewport");
  });

  it("reads the media query on every resolve, with no module cache", async () => {
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
