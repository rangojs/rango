import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createMetricsStore,
  logMetrics,
  generateServerTiming,
} from "../metrics";
import type { MetricsStore } from "../../server/context";

describe("createMetricsStore", () => {
  describe("when debugPerformance is enabled", () => {
    it("should create a metrics store", () => {
      const store = createMetricsStore(true);

      expect(store).toBeDefined();
      expect(store?.enabled).toBe(true);
      expect(store?.metrics).toEqual([]);
    });

    it("should set requestStart to current time", () => {
      const before = performance.now();
      const store = createMetricsStore(true);
      const after = performance.now();

      expect(store?.requestStart).toBeGreaterThanOrEqual(before);
      expect(store?.requestStart).toBeLessThanOrEqual(after);
    });

    it("should initialize with empty metrics array", () => {
      const store = createMetricsStore(true);

      expect(store?.metrics).toEqual([]);
      expect(Array.isArray(store?.metrics)).toBe(true);
    });
  });

  describe("when debugPerformance is disabled", () => {
    it("should return undefined", () => {
      const store = createMetricsStore(false);
      expect(store).toBeUndefined();
    });
  });
});

describe("logMetrics", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("should log method, pathname and total duration", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: performance.now() - 100,
      metrics: [],
    };

    logMetrics("GET", "/products", store);

    expect(consoleSpy).toHaveBeenCalled();
    const firstCall = consoleSpy.mock.calls[0][0];
    expect(firstCall).toContain("[RSC Perf]");
    expect(firstCall).toContain("GET");
    expect(firstCall).toContain("/products");
    expect(firstCall).toContain("ms");
  });

  it("should log each metric with duration", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: performance.now() - 100,
      metrics: [
        { label: "route-matching", duration: 5.5, startTime: 0 },
        { label: "loader:ProductLoader", duration: 45.2, startTime: 5.5 },
      ],
    };

    logMetrics("GET", "/products/123", store);

    // First call is the header
    expect(consoleSpy.mock.calls[0][0]).toContain("[RSC Perf]");

    // Subsequent calls are metrics
    expect(consoleSpy.mock.calls[1][0]).toContain("route-matching");
    expect(consoleSpy.mock.calls[1][0]).toContain("5.5ms");

    expect(consoleSpy.mock.calls[2][0]).toContain("loader:ProductLoader");
    expect(consoleSpy.mock.calls[2][0]).toContain("45.2ms");
  });

  it("should align labels based on longest label", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: performance.now(),
      metrics: [
        { label: "short", duration: 1, startTime: 0 },
        { label: "very-long-label-name", duration: 2, startTime: 1 },
      ],
    };

    logMetrics("POST", "/api/action", store);

    // Both metric lines should have consistent formatting
    const shortLine = consoleSpy.mock.calls[1][0];
    const longLine = consoleSpy.mock.calls[2][0];

    // The "short" label should be padded to match "very-long-label-name"
    expect(shortLine.indexOf("1.0ms")).toBeGreaterThan(0);
    expect(longLine.indexOf("2.0ms")).toBeGreaterThan(0);
  });

  it("should handle POST method", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: performance.now(),
      metrics: [],
    };

    logMetrics("POST", "/api/submit", store);

    expect(consoleSpy.mock.calls[0][0]).toContain("POST");
    expect(consoleSpy.mock.calls[0][0]).toContain("/api/submit");
  });

  it("should handle empty metrics array", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: performance.now(),
      metrics: [],
    };

    logMetrics("GET", "/", store);

    // Should only log the header line
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy.mock.calls[0][0]).toContain("[RSC Perf]");
  });

  it("should calculate total duration from requestStart", () => {
    const now = performance.now();
    const store: MetricsStore = {
      enabled: true,
      requestStart: now - 150, // 150ms ago
      metrics: [],
    };

    logMetrics("GET", "/test", store);

    const logOutput = consoleSpy.mock.calls[0][0];
    // Extract duration from log (format: "... (XXX.Xms)")
    const durationMatch = logOutput.match(/\((\d+\.?\d*)ms\)/);
    expect(durationMatch).not.toBeNull();
    const duration = parseFloat(durationMatch[1]);
    // Should be at least 150ms (might be slightly more due to execution time)
    expect(duration).toBeGreaterThanOrEqual(149);
  });
});

describe("generateServerTiming", () => {
  it("should generate Server-Timing header from metrics", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "route-matching", duration: 5.55, startTime: 0 },
        { label: "loader", duration: 45.22, startTime: 5.55 },
      ],
    };

    const timing = generateServerTiming(store);

    expect(timing).toContain("route-matching;dur=5.55");
    expect(timing).toContain("loader;dur=45.22");
    expect(timing).toBe("route-matching;dur=5.55, loader;dur=45.22");
  });

  it("should convert colons to hyphens", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "loader:ProductLoader", duration: 10, startTime: 0 }],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("loader-productloader;dur=10.00");
    expect(timing).not.toContain(":");
  });

  it("should remove invalid characters", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "loader (async)", duration: 15, startTime: 0 },
        { label: "route$special%chars", duration: 5, startTime: 15 },
      ],
    };

    const timing = generateServerTiming(store);

    expect(timing).toContain("loaderasync;dur=15.00");
    expect(timing).toContain("routespecialchars;dur=5.00");
    // Should not contain parentheses, $, % in metric names
    // (space is allowed as separator between metrics)
    expect(timing).not.toContain("(");
    expect(timing).not.toContain(")");
    expect(timing).not.toContain("$");
    expect(timing).not.toContain("%");
  });

  it("should convert to lowercase", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "LoaderComponent", duration: 20, startTime: 0 }],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("loadercomponent;dur=20.00");
  });

  it("should format duration with 2 decimal places", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "fast", duration: 0.1, startTime: 0 },
        { label: "slow", duration: 100.555, startTime: 0.1 },
      ],
    };

    const timing = generateServerTiming(store);

    expect(timing).toContain("fast;dur=0.10");
    expect(timing).toContain("slow;dur=100.56"); // Rounded
  });

  it("should join multiple metrics with comma and space", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "a", duration: 1, startTime: 0 },
        { label: "b", duration: 2, startTime: 1 },
        { label: "c", duration: 3, startTime: 3 },
      ],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("a;dur=1.00, b;dur=2.00, c;dur=3.00");
  });

  it("should return empty string for empty metrics", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("");
  });

  it("should handle hyphens in labels", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "route-matching-phase", duration: 8, startTime: 0 }],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("route-matching-phase;dur=8.00");
  });

  it("should handle numeric characters in labels", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "loader123", duration: 5, startTime: 0 }],
    };

    const timing = generateServerTiming(store);

    expect(timing).toBe("loader123;dur=5.00");
  });
});
