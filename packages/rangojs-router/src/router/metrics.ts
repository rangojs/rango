/**
 * Router Metrics Utilities
 *
 * Performance metrics collection and reporting for RSC Router.
 */

import type { MetricsStore, PerformanceMetric } from "../server/context";

const BASE_INDENT = 2;
const DEPTH_INDENT = 2;
const TIMELINE_WIDTH = 40;

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function sortMetrics(metrics: PerformanceMetric[]): PerformanceMetric[] {
  return [...metrics].sort((a, b) => a.startTime - b.startTime);
}

function renderTimeline(metric: PerformanceMetric, total: number): string {
  if (TIMELINE_WIDTH <= 0) {
    return "||";
  }

  const cells = Array(TIMELINE_WIDTH).fill(".");

  if (!(total > 0)) {
    cells[0] = "#";
    return `|${cells.join("")}|`;
  }

  const start = Math.max(0, metric.startTime);
  const end = Math.max(start, metric.startTime + metric.duration);
  const startColumn = Math.min(
    TIMELINE_WIDTH - 1,
    Math.floor((start / total) * TIMELINE_WIDTH),
  );
  const endColumn = Math.max(
    startColumn + 1,
    Math.min(
      TIMELINE_WIDTH,
      Math.ceil((Math.min(total, end) / total) * TIMELINE_WIDTH),
    ),
  );

  cells.fill("#", startColumn, endColumn);
  return `|${cells.join("")}|`;
}

function createTimelineAxis(total: number): string {
  const totalLabel = formatMs(total);
  return `0ms${" ".repeat(
    Math.max(1, TIMELINE_WIDTH - "0ms".length - totalLabel.length),
  )}${totalLabel}`;
}

/**
 * Create a metrics store for the request if debugPerformance is enabled
 */
export function createMetricsStore(
  debugPerformance: boolean,
): MetricsStore | undefined {
  if (!debugPerformance) return undefined;
  return {
    enabled: true,
    requestStart: performance.now(),
    metrics: [],
  };
}

/**
 * Append a metric to the request store using an absolute start timestamp.
 */
export function appendMetric(
  metricsStore: MetricsStore | undefined,
  label: string,
  start: number,
  duration: number,
  depth?: number,
): void {
  if (!metricsStore) return;
  metricsStore.metrics.push({
    label,
    duration,
    startTime: start - metricsStore.requestStart,
    depth,
  });
}

/**
 * Log the current request metrics and return the corresponding Server-Timing value.
 * Falls back to an existing header value when no metrics store is active.
 */
export function buildMetricsTiming(
  method: string,
  pathname: string,
  metricsStore: MetricsStore | undefined,
  fallback?: string,
): string | undefined {
  if (!metricsStore) {
    return fallback;
  }
  logMetrics(method, pathname, metricsStore);
  return generateServerTiming(metricsStore) || undefined;
}

/**
 * Log metrics to console in a formatted way.
 * Uses a shared-axis timeline so overlapping work stays visible.
 */
export function logMetrics(
  method: string,
  pathname: string,
  metricsStore: MetricsStore,
): void {
  const total = performance.now() - metricsStore.requestStart;

  const sorted = sortMetrics(metricsStore.metrics);
  const labels = sorted.map(
    (m) =>
      `${" ".repeat(BASE_INDENT + (m.depth ?? 0) * DEPTH_INDENT)}${m.label}`,
  );
  const startValues = sorted.map((m) => formatMs(m.startTime));
  const durationValues = sorted.map((m) => formatMs(m.duration));
  const startWidth = Math.max(
    "start".length,
    ...startValues.map((v) => v.length),
  );
  const durationWidth = Math.max(
    "dur".length,
    ...durationValues.map((v) => v.length),
  );
  const spanWidth = Math.max(
    "span".length,
    ...labels.map((label) => label.length),
    22,
  );
  const timelinePadding = " ".repeat(
    startWidth + 2 + durationWidth + 2 + spanWidth + 2,
  );

  console.log(`[RSC Perf] ${method} ${pathname} (${total.toFixed(2)}ms)`);
  console.log(
    `${"start".padStart(startWidth)}  ${"dur".padStart(durationWidth)}  ${"span".padEnd(spanWidth)}  timeline`,
  );
  console.log(`${timelinePadding}${createTimelineAxis(total)}`);

  for (let index = 0; index < sorted.length; index++) {
    const metric = sorted[index];
    const label = labels[index].padEnd(spanWidth);
    const start = formatMs(metric.startTime).padStart(startWidth);
    const duration = formatMs(metric.duration).padStart(durationWidth);

    console.log(
      `${start}  ${duration}  ${label}  ${renderTimeline(metric, total)}`,
    );
  }
}

/**
 * Generate Server-Timing header value from metrics
 * Format: metric-name;dur=X.XX
 * Depth is encoded as a "d{N}-" prefix for nested metrics.
 */
export function generateServerTiming(metricsStore: MetricsStore): string {
  return metricsStore.metrics
    .map((m) => {
      // Convert label to valid Server-Timing name (alphanumeric and hyphens)
      const base = m.label
        .replace(/:/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "")
        .toLowerCase();
      const name = m.depth ? `d${m.depth}-${base}` : base;
      return `${name};dur=${m.duration.toFixed(2)}`;
    })
    .join(", ");
}
