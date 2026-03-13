import { describe, it, expect, vi, afterEach } from "vitest";
import {
  logMetrics,
  generateServerTiming,
  createMetricsStore,
} from "../metrics.js";
import type { MetricsStore } from "../../server/context.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function extractMetricLabel(line: string): string {
  const match = line.match(/^\s*\S+\s+\S+\s+(.*?)\s+\|[.#]+\|$/);
  expect(match?.[1]).toBeDefined();
  return match![1].trim();
}

function getTimeline(line: string): string {
  return line.slice(line.indexOf("|"));
}

function getBarRange(line: string): [start: number, end: number] {
  const timeline = getTimeline(line);
  const start = timeline.indexOf("#");
  const end = timeline.lastIndexOf("#");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThanOrEqual(start);
  return [start, end];
}

// ---------------------------------------------------------------------------
// logMetrics — startTime ordering
// ---------------------------------------------------------------------------

describe("logMetrics", () => {
  it("prints metrics sorted by startTime so parents appear before children", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    // Simulate the real append order: child metrics (depth 2) are pushed
    // before their parent (depth 1) because the parent scope closes after
    // its children finish.
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        // Child pushed first (handler finishes before segment scope closes)
        { label: "handler:blog.post", duration: 50, startTime: 5, depth: 2 },
        // Parent pushed second (segment scope closes last)
        { label: "segment:blog.post", duration: 54, startTime: 2, depth: 1 },
        // Pipeline-level metric pushed even earlier
        {
          label: "pipeline:segment-resolve",
          duration: 57,
          startTime: 0,
          depth: 0,
        },
      ],
    };

    logMetrics("GET", "/blog/hello", store);

    // Extract just the label portion from each metric row.
    const metricLines = logs.slice(3).map(extractMetricLabel);

    // Should be sorted: pipeline (t=0) → segment (t=2) → handler (t=5)
    expect(metricLines).toEqual([
      "pipeline:segment-resolve",
      "segment:blog.post",
      "handler:blog.post",
    ]);
  });

  it("preserves order for metrics with identical startTime", () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "b-metric", duration: 10, startTime: 5 },
        { label: "a-metric", duration: 10, startTime: 5 },
      ],
    };

    logMetrics("GET", "/", store);

    const metricLines = logs.slice(3).map(extractMetricLabel);
    // Stable sort should preserve original order for equal startTime
    expect(metricLines).toEqual(["b-metric", "a-metric"]);
  });

  it("renders a shared timeline sidebar with a fixed start column", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "segment:root", duration: 20, startTime: 0, depth: 1 },
        { label: "handler:root", duration: 10, startTime: 50, depth: 2 },
      ],
    };

    logMetrics("GET", "/", store);

    expect(logs[1]).toContain("timeline");
    expect(logs[2]?.trimStart()).toBe(
      "0ms                             100.00ms",
    );

    const metricRows = logs.slice(3);
    const timelineStarts = metricRows.map((line) => line.indexOf("|"));
    expect(new Set(timelineStarts).size).toBe(1);

    const firstTimeline = getTimeline(metricRows[0]!);
    const secondTimeline = getTimeline(metricRows[1]!);
    expect(firstTimeline.indexOf("#")).toBeLessThan(
      secondTimeline.indexOf("#"),
    );
  });

  it("preserves the idle gap before the first recorded span", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "render:start", duration: 20, startTime: 60 }],
    };

    logMetrics("GET", "/gap", store);

    const [barStart] = getBarRange(logs[3]!);
    expect(barStart).toBeGreaterThan(20);
  });

  it("shows overlap for parallel spans and separation for sequential spans", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "segment:a", duration: 40, startTime: 0, depth: 1 },
        { label: "segment:b", duration: 40, startTime: 20, depth: 1 },
        { label: "segment:c", duration: 20, startTime: 70, depth: 1 },
      ],
    };

    logMetrics("GET", "/overlap", store);

    const [aStart, aEnd] = getBarRange(logs[3]!);
    const [bStart, bEnd] = getBarRange(logs[4]!);
    const [cStart] = getBarRange(logs[5]!);

    expect(bStart).toBeLessThanOrEqual(aEnd);
    expect(cStart).toBeGreaterThan(bEnd);
  });
});

// ---------------------------------------------------------------------------
// generateServerTiming — depth encoding
// ---------------------------------------------------------------------------

describe("generateServerTiming", () => {
  it("encodes depth as d{N}- prefix", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "pipeline:segment-resolve", duration: 57, startTime: 0 },
        { label: "segment:blog.post", duration: 54, startTime: 2, depth: 1 },
        { label: "handler:blog.post", duration: 50, startTime: 5, depth: 2 },
      ],
    };

    const timing = generateServerTiming(store);
    const parts = timing.split(", ");

    expect(parts[0]).toMatch(/^pipeline-segment-resolve;dur=/);
    expect(parts[1]).toMatch(/^d1-segment-blogpost;dur=/);
    expect(parts[2]).toMatch(/^d2-handler-blogpost;dur=/);
  });

  it("omits depth prefix for depth 0 or undefined", () => {
    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [
        { label: "top-level", duration: 10, startTime: 0, depth: 0 },
        { label: "no-depth", duration: 5, startTime: 1 },
      ],
    };

    const timing = generateServerTiming(store);
    expect(timing).toBe("top-level;dur=10.00, no-depth;dur=5.00");
  });
});

// ---------------------------------------------------------------------------
// Formatter precision
// ---------------------------------------------------------------------------

describe("formatMs precision", () => {
  it("displays sub-millisecond durations with two decimal places", () => {
    vi.spyOn(performance, "now").mockReturnValue(100);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: any[]) => {
      logs.push(args.join(" "));
    });

    const store: MetricsStore = {
      enabled: true,
      requestStart: 0,
      metrics: [{ label: "fast-op", duration: 0.04, startTime: 0.12 }],
    };

    logMetrics("GET", "/fast", store);

    // Header should use two decimal places
    expect(logs[0]).toContain("100.00ms");
    // Metric row should show 0.04ms not 0.0ms
    const metricRow = logs[3]!;
    expect(metricRow).toContain("0.04ms");
    expect(metricRow).toContain("0.12ms");
  });
});

// ---------------------------------------------------------------------------
// createMetricsStore
// ---------------------------------------------------------------------------

describe("createMetricsStore", () => {
  it("returns undefined when disabled", () => {
    expect(createMetricsStore(false)).toBeUndefined();
  });

  it("returns a store with empty metrics when enabled", () => {
    const store = createMetricsStore(true);
    expect(store).toBeDefined();
    expect(store!.enabled).toBe(true);
    expect(store!.metrics).toEqual([]);
    expect(typeof store!.requestStart).toBe("number");
  });
});
