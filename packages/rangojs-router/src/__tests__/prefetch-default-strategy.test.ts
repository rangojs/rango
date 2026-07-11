import { describe, it, expect, afterEach, vi } from "vitest";

describe("default prefetch strategy (client seat)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
