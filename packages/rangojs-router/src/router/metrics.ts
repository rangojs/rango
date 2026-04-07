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
  return [...metrics].sort((a, b) => {
    // handler:total always goes last (it wraps everything)
    if (a.label === "handler:total") return 1;
    if (b.label === "handler:total") return -1;
    return a.startTime - b.startTime;
  });
}

interface Span {
  startTime: number;
  duration: number;
}

function renderTimeline(spans: Span[], total: number): string {
  if (TIMELINE_WIDTH <= 0) {
    return "||";
  }

  const cells = Array(TIMELINE_WIDTH).fill(".");

  if (!(total > 0)) {
    cells[0] = "#";
    return `|${cells.join("")}|`;
  }

  for (const span of spans) {
    const start = Math.max(0, span.startTime);
    const end = Math.max(start, span.startTime + span.duration);
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
  }

  return `|${cells.join("")}|`;
}

function createTimelineAxis(total: number): string {
  const totalLabel = formatMs(total);
  return `0ms${" ".repeat(
    Math.max(1, TIMELINE_WIDTH - "0ms".length - totalLabel.length),
  )}${totalLabel}`;
}

/**
 * Create a metrics store for the request if debugPerformance is enabled.
 * An optional `requestStart` timestamp can anchor the store to an earlier
 * point (e.g. handler start) so that handler:total has startTime=0.
 */
export function createMetricsStore(
  debugPerformance: boolean,
  requestStart?: number,
): MetricsStore | undefined {
  if (!debugPerformance) return undefined;
  return {
    enabled: true,
    requestStart: requestStart ?? performance.now(),
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
 */
export function buildMetricsTiming(
  method: string,
  pathname: string,
  metricsStore: MetricsStore | undefined,
): string | undefined {
  if (!metricsStore) return undefined;
  logMetrics(method, pathname, metricsStore);
  return generateServerTiming(metricsStore) || undefined;
}

/** Display row produced by merging :pre/:post metric pairs. */
interface DisplayRow {
  label: string;
  startTime: number;
  duration: number;
  depth: number | undefined;
  spans: Span[];
}

/**
 * Build display rows from sorted metrics, merging :pre/:post pairs into
 * a single row with disjoint timeline segments.
 */
function buildDisplayRows(sorted: PerformanceMetric[]): DisplayRow[] {
  // Index :pre and :post metrics by their base label
  const preMap = new Map<string, PerformanceMetric>();
  const postMap = new Map<string, PerformanceMetric>();
  const consumed = new Set<PerformanceMetric>();

  for (const m of sorted) {
    if (m.label.endsWith(":pre")) {
      preMap.set(m.label.slice(0, -4), m);
    } else if (m.label.endsWith(":post")) {
      postMap.set(m.label.slice(0, -5), m);
    }
  }

  const rows: DisplayRow[] = [];

  for (const m of sorted) {
    if (consumed.has(m)) continue;

    if (m.label.endsWith(":pre")) {
      const base = m.label.slice(0, -4);
      const post = postMap.get(base);
      if (post) {
        // Merge into a single row with two disjoint spans
        consumed.add(m);
        consumed.add(post);
        rows.push({
          label: base,
          startTime: m.startTime,
          duration: m.duration + post.duration,
          depth: m.depth,
          spans: [
            { startTime: m.startTime, duration: m.duration },
            { startTime: post.startTime, duration: post.duration },
          ],
        });
        continue;
      }
      // Lone :pre — display with base label
      consumed.add(m);
      rows.push({
        label: base,
        startTime: m.startTime,
        duration: m.duration,
        depth: m.depth,
        spans: [{ startTime: m.startTime, duration: m.duration }],
      });
      continue;
    }

    if (m.label.endsWith(":post")) {
      const base = m.label.slice(0, -5);
      if (preMap.has(base)) {
        // Already consumed as part of the pair above
        continue;
      }
      // Lone :post — display with base label
      consumed.add(m);
      rows.push({
        label: base,
        startTime: m.startTime,
        duration: m.duration,
        depth: m.depth,
        spans: [{ startTime: m.startTime, duration: m.duration }],
      });
      continue;
    }

    // Regular metric
    rows.push({
      label: m.label,
      startTime: m.startTime,
      duration: m.duration,
      depth: m.depth,
      spans: [{ startTime: m.startTime, duration: m.duration }],
    });
  }

  return rows;
}

/**
 * Log metrics to console in a formatted way.
 * Uses a shared-axis timeline so overlapping work stays visible.
 * Merges :pre/:post pairs onto one row with disjoint timeline segments.
 */
export function logMetrics(
  method: string,
  pathname: string,
  metricsStore: MetricsStore,
): void {
  const total = performance.now() - metricsStore.requestStart;

  const sorted = sortMetrics(metricsStore.metrics);
  const displayRows = buildDisplayRows(sorted);

  const labels = displayRows.map(
    (r) =>
      `${" ".repeat(BASE_INDENT + (r.depth ?? 0) * DEPTH_INDENT)}${r.label}`,
  );
  const startValues = displayRows.map((r) => formatMs(r.startTime));
  const durationValues = displayRows.map((r) => formatMs(r.duration));
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

  for (let index = 0; index < displayRows.length; index++) {
    const row = displayRows[index];
    const label = labels[index].padEnd(spanWidth);
    const start = formatMs(row.startTime).padStart(startWidth);
    const duration = formatMs(row.duration).padStart(durationWidth);

    console.log(
      `${start}  ${duration}  ${label}  ${renderTimeline(row.spans, total)}`,
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
