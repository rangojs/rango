import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREFETCH_STRATEGY,
  resolveDefaultPrefetch,
  type PrefetchStrategy,
} from "../prefetch-default.js";

// Strings, not counts: the only invalid inputs are strings outside the union
// (untyped JS consumers, config/env-threaded values). Fallback is the default
// ("viewport"), never "none" — a malformed value must not silently disable a
// feature the consumer nominally left enabled.
describe("resolveDefaultPrefetch", () => {
  it("defaults to viewport when undefined", () => {
    expect(DEFAULT_PREFETCH_STRATEGY).toBe("viewport");
    expect(resolveDefaultPrefetch(undefined)).toBe("viewport");
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
      expect(resolveDefaultPrefetch(strategy)).toBe(strategy);
    }
  });

  it("falls back to the default for strings outside the union", () => {
    expect(
      resolveDefaultPrefetch("intent" as unknown as PrefetchStrategy),
    ).toBe("viewport");
    expect(
      resolveDefaultPrefetch("Viewport" as unknown as PrefetchStrategy),
    ).toBe("viewport");
    expect(resolveDefaultPrefetch("" as unknown as PrefetchStrategy)).toBe(
      "viewport",
    );
  });

  it("falls back to the default for non-string inputs", () => {
    expect(resolveDefaultPrefetch(null as unknown as PrefetchStrategy)).toBe(
      "viewport",
    );
    expect(resolveDefaultPrefetch(42 as unknown as PrefetchStrategy)).toBe(
      "viewport",
    );
    expect(resolveDefaultPrefetch(true as unknown as PrefetchStrategy)).toBe(
      "viewport",
    );
  });
});
