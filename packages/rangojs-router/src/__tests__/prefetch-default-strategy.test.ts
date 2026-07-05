import { describe, it, expect, afterEach } from "vitest";
import {
  getDefaultPrefetchStrategy,
  setDefaultPrefetchStrategy,
} from "../browser/prefetch/default-strategy.js";
import { DEFAULT_PREFETCH_STRATEGY } from "../router/prefetch-default.js";

describe("default prefetch strategy (client seat)", () => {
  afterEach(() => {
    setDefaultPrefetchStrategy(DEFAULT_PREFETCH_STRATEGY);
  });

  // The invariant default-strategy.ts documents: during SSR (and under an
  // older server that ships no metadata) the module is never initialized, so
  // its initial value MUST equal the server resolver's default or the two
  // seats drift.
  it("initial value equals the server resolver default (viewport)", () => {
    expect(getDefaultPrefetchStrategy()).toBe(DEFAULT_PREFETCH_STRATEGY);
    expect(getDefaultPrefetchStrategy()).toBe("viewport");
  });

  it("set/get roundtrips every strategy", () => {
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
