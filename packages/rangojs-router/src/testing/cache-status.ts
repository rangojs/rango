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
 * keyed by the route key, not per individual segment.
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

/**
 * Parse an `X-Rango-Cache` header value into a `{ routeKey: status }` map.
 *
 * Header format: `<routeKey>=<status>, <routeKey2>=<status2>`. The key is the
 * route NAME (ctx.routeKey, e.g. `product.detail`), NOT the URL pattern —
 * see assertCacheStatus. Whitespace around entries and the `=` is tolerated.
 * Entries without a status are ignored.
 *
 * @example
 * parseCacheHeader("product.detail=hit, shop.layout=stale")
 * // => { "product.detail": "hit", "shop.layout": "stale" }
 */
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

/**
 * Assert that the `X-Rango-Cache` header reports `expected` status for the
 * given route. Throws a descriptive error when the header is missing (gate
 * off), the route is absent, or the status differs.
 *
 * `routeKey` is the route NAME (e.g. `product.detail`), the same id the header
 * carries — NOT the URL pattern (`/products/:id`). The signal is built from
 * ctx.routeKey (telemetry.ts), so a pattern-shaped key never matches.
 *
 * The header is produced by the RSC render pipeline, so get the Response from
 * the router's real fetch path (`router.fetch(...)`), with the debug cache
 * signal gate enabled (`debugCacheSignal: true` or `RANGO_TEST_SIGNALS=1`).
 * NOTE: `dispatch()` is the non-RSC primitive and never emits this header.
 *
 * @example
 * // debugCacheSignal must be enabled on the router under test.
 * const res = await router.fetch(new Request("https://app/products/42"));
 * assertCacheStatus(res, "product.detail", "hit");
 */
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

/**
 * Create a capturing telemetry sink for asserting on `cache.decision` events.
 *
 * This is the ZERO-production-surface path: no response header is emitted, the
 * consumer just inspects the captured events.
 *
 * @example
 * const { sink, events } = createCacheSink();
 * const router = createRouter({ telemetry: sink, ... });
 * // ...send a request through the router's RSC fetch path...
 * const decisions = filterCacheDecisions(events);
 * expect(decisions[0].segments?.[0].cacheStatus).toBe("hit");
 */
export function createCacheSink(): CacheSink {
  const events: TelemetryEvent[] = [];
  const sink: TelemetrySink = {
    emit(event: TelemetryEvent): void {
      events.push(event);
    },
  };
  return { sink, events };
}

/**
 * Filter captured telemetry events down to `cache.decision` events.
 */
export function filterCacheDecisions(
  events: readonly TelemetryEvent[],
): CacheDecisionEvent[] {
  return events.filter(
    (e): e is CacheDecisionEvent => e.type === "cache.decision",
  );
}
