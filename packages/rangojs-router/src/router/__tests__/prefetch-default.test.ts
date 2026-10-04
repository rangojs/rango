import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFETCH_STRATEGY,
  resolveDefaultPrefetch,
  type PrefetchStrategy,
} from "../prefetch-default.js";

describe("resolveDefaultPrefetch", () => {
  it("defaults to none outside production", () => {
    expect(DEFAULT_PREFETCH_STRATEGY).toBe("none");
    expect(resolveDefaultPrefetch(undefined, "development")).toBe("none");
    expect(resolveDefaultPrefetch(undefined, "test")).toBe("none");
  });

  it("defaults to viewport in production", () => {
    expect(resolveDefaultPrefetch(undefined, "production")).toBe("viewport");
  });

  it("passes every valid strategy through unchanged", () => {
    const all: PrefetchStrategy[] = [
      "hover",
      "viewport",
      "render",
      "adaptive",
      "none",
    ];
    for (const strategy of all) {
      expect(resolveDefaultPrefetch(strategy, "development")).toBe(strategy);
      expect(resolveDefaultPrefetch(strategy, "production")).toBe(strategy);
    }
  });

  it("falls back to the environment default for invalid inputs", () => {
    expect(
      resolveDefaultPrefetch(
        "intent" as unknown as PrefetchStrategy,
        "development",
      ),
    ).toBe("none");
    expect(
      resolveDefaultPrefetch(
        "Viewport" as unknown as PrefetchStrategy,
        "production",
      ),
    ).toBe("viewport");
    expect(
      resolveDefaultPrefetch(null as unknown as PrefetchStrategy, "test"),
    ).toBe("none");
    expect(
      resolveDefaultPrefetch(42 as unknown as PrefetchStrategy, "production"),
    ).toBe("viewport");
  });
});
