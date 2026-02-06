/**
 * Router Metrics Utilities
 *
 * Performance metrics collection and reporting for RSC Router.
 */

import type { MetricsStore } from "../server/context";

/**
 * Create a metrics store for the request if debugPerformance is enabled
 */
export function createMetricsStore(
  debugPerformance: boolean
): MetricsStore | undefined {
  if (!debugPerformance) return undefined;
  return {
    enabled: true,
    requestStart: performance.now(),
    metrics: [],
  };
}

/**
 * Log metrics to console in a formatted way
 */
export function logMetrics(
  method: string,
  pathname: string,
  metricsStore: MetricsStore
): void {
  const total = performance.now() - metricsStore.requestStart;

  // Find max label length for alignment
  const maxLabelLen = Math.max(
    ...metricsStore.metrics.map((m) => m.label.length),
    20
  );

  console.log(`[RSC Perf] ${method} ${pathname} (${total.toFixed(1)}ms)`);

  for (const m of metricsStore.metrics) {
    const paddedLabel = m.label.padEnd(maxLabelLen);
    console.log(`  ${paddedLabel} ${m.duration.toFixed(1)}ms`);
  }
}

/**
 * Generate Server-Timing header value from metrics
 * Format: metric-name;dur=X.XX
 */
export function generateServerTiming(metricsStore: MetricsStore): string {
  return metricsStore.metrics
    .map((m) => {
      // Convert label to valid Server-Timing name (alphanumeric and hyphens)
      const name = m.label
        .replace(/:/g, "-")
        .replace(/[^a-zA-Z0-9-]/g, "")
        .toLowerCase();
      return `${name};dur=${m.duration.toFixed(2)}`;
    })
    .join(", ");
}
