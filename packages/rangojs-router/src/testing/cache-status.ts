/**
 * Cache-status testing primitives for @rangojs/router consumers.
 *
 * Two complementary paths, both DEVELOPMENT/TEST ONLY:
 *
 * 1. Header path — `parseCacheHeader` / `assertCacheStatus` read the
 *    `X-Rango-Cache` response header. The header is emitted only when the
 *    router's debug cache signal gate is on (the `debugCacheSignal` option or
 *    `RANGO_TEST_SIGNALS=1`). With the gate off there is no header and these
 *    helpers throw a clear "header missing" error.
 *
 * 2. Telemetry path — `createCacheSink` returns a `{ sink, events }` pair the
 *    consumer wires via `createRouter({ telemetry: sink })`. This has ZERO
 *    production surface: no header, just structured `cache.decision` events
 *    (which carry the same coarse `segments` cache signal).
 *
 * v1 cache status is COARSE (route-level): the router reports a single entry
 * keyed by the route key (the route NAME), not per individual segment.
 *
 * Import path: from a Vitest unit/integration test use `@rangojs/router/testing`;
 * from a Playwright e2e use `@rangojs/router/testing/e2e` (the barrel pulls a
 * build-only virtual that does not resolve in a plain Playwright runner).
 */

import type {
  CacheDecisionEvent,
  CacheSegmentStatus,
  TelemetryEvent,
  TelemetrySink,
} from "../router/telemetry.js";

const CACHE_HEADER = "X-Rango-Cache";

/** Expected cache status passed to assertCacheStatus. */
export type ExpectedCacheStatus = CacheSegmentStatus;

/** A target carrying response headers (a Response or a `{ headers }` object). */
export type CacheStatusTarget = Response | { headers: Headers };

export function parseCacheHeader(
  headerValue: string | null | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headerValue) return result;
  for (const rawEntry of headerValue.split(",")) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const id = entry.slice(0, eq).trim();
    const status = entry.slice(eq + 1).trim();
    if (id.length === 0 || status.length === 0) continue;
    result[id] = status;
  }
  return result;
}

function getHeaders(target: CacheStatusTarget): Headers {
  return target.headers;
}

export function assertCacheStatus(
  target: CacheStatusTarget,
  segment: string,
  expected: ExpectedCacheStatus,
): void {
  const headerValue = getHeaders(target).get(CACHE_HEADER);
  if (headerValue === null) {
    throw new Error(
      `assertCacheStatus: response has no ${CACHE_HEADER} header. ` +
        `Enable the debug cache signal via createRouter({ debugCacheSignal: true }) ` +
        `or RANGO_TEST_SIGNALS=1.`,
    );
  }
  const map = parseCacheHeader(headerValue);
  const actual = map[segment];
  if (actual === undefined) {
    const known = Object.keys(map);
    throw new Error(
      `assertCacheStatus: segment "${segment}" not found in ${CACHE_HEADER} ` +
        `("${headerValue}"). Known segments: ${
          known.length > 0 ? known.join(", ") : "(none)"
        }.`,
    );
  }
  if (actual !== expected) {
    throw new Error(
      `assertCacheStatus: segment "${segment}" expected "${expected}" but got "${actual}".`,
    );
  }
}

/**
 * A telemetry sink paired with the array it records events into.
 */
export interface CacheSink {
  /** Wire into `createRouter({ telemetry: sink })`. */
  sink: TelemetrySink;
  /** All telemetry events captured so far, in emit order. */
  events: TelemetryEvent[];
}

export function createCacheSink(): CacheSink {
  const events: TelemetryEvent[] = [];
  const sink: TelemetrySink = {
    emit(event: TelemetryEvent): void {
      events.push(event);
    },
  };
  return { sink, events };
}

export function filterCacheDecisions(
  events: readonly TelemetryEvent[],
): CacheDecisionEvent[] {
  return events.filter(
    (e): e is CacheDecisionEvent => e.type === "cache.decision",
  );
}
