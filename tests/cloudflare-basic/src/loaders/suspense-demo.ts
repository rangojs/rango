import { createLoader } from "@rangojs/router";

/**
 * Streaming useLoader demo loaders — three staggered latencies so the
 * progressive fill is visible. Each returns its own delay and a serve
 * timestamp so the cards can show when their data actually landed.
 */

export interface SuspenseDemoData {
  label: string;
  delayMs: number;
  servedAt: string;
  detail: string;
}

function serve(
  label: string,
  delayMs: number,
  detail: string,
): Promise<SuspenseDemoData> {
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          label,
          delayMs,
          servedAt: new Date().toISOString(),
          detail,
        }),
      delayMs,
    ),
  );
}

export const FastStatsLoader = createLoader(() =>
  serve("stats", 400, "42 active sessions, 7 deploys today"),
);

export const MediumActivityLoader = createLoader(() =>
  serve("activity", 1200, "3 new comments, 1 merged PR, 2 releases"),
);

export const SlowReportLoader = createLoader(() =>
  serve("report", 2000, "Quarterly aggregate: 1.2M requests, p95 88ms"),
);
