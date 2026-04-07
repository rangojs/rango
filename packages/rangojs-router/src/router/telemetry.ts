/**
 * Router Telemetry Sink
 *
 * Internal event model for structured lifecycle events.
 * The sink is optional and zero-cost when not configured.
 *
 * Emit points:
 *   - request.start / request.end   (match-handlers.ts)
 *   - request.error                  (match-handlers.ts catch blocks)
 *   - request.origin-rejected        (rsc/handler.ts origin guard)
 *   - loader.start / loader.end / loader.error  (loader-resolution.ts)
 *   - handler.error                  (trackHandler catch, segment-resolution/helpers.ts)
 *   - cache.decision                 (cache-lookup middleware)
 *   - revalidation.decision          (revalidation evaluation)
 */

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

interface BaseEvent {
  /** Monotonic timestamp from performance.now() */
  timestamp: number;
  /** Request ID (from header or generated) */
  requestId?: string;
}

export interface RequestStartEvent extends BaseEvent {
  type: "request.start";
  method: string;
  pathname: string;
  /** "match" for full document requests, "matchPartial" for navigation */
  transaction: "match" | "matchPartial";
  isPartial: boolean;
}

export interface RequestEndEvent extends BaseEvent {
  type: "request.end";
  method: string;
  pathname: string;
  transaction: "match" | "matchPartial";
  durationMs: number;
  segmentCount: number;
  cacheHit: boolean;
}

export interface RequestErrorEvent extends BaseEvent {
  type: "request.error";
  method: string;
  pathname: string;
  transaction: "match" | "matchPartial";
  error: Error;
  phase: string;
  durationMs: number;
}

export interface LoaderStartEvent extends BaseEvent {
  type: "loader.start";
  segmentId: string;
  loaderName: string;
  pathname: string;
}

export interface LoaderEndEvent extends BaseEvent {
  type: "loader.end";
  segmentId: string;
  loaderName: string;
  pathname: string;
  durationMs: number;
  ok: boolean;
}

export interface LoaderErrorEvent extends BaseEvent {
  type: "loader.error";
  segmentId: string;
  loaderName: string;
  pathname: string;
  error: Error;
  handledByBoundary: boolean;
}

export interface HandlerErrorEvent extends BaseEvent {
  type: "handler.error";
  segmentId?: string;
  segmentType?: string;
  error: Error;
  handledByBoundary: boolean;
  pathname?: string;
  routeKey?: string;
  params?: Record<string, string>;
}

export interface CacheDecisionEvent extends BaseEvent {
  type: "cache.decision";
  pathname: string;
  routeKey: string;
  hit: boolean;
  /** Whether stale-while-revalidate was triggered */
  shouldRevalidate: boolean;
  source?: "runtime" | "prerender";
}

export interface RevalidationDecisionEvent extends BaseEvent {
  type: "revalidation.decision";
  segmentId: string;
  pathname: string;
  routeKey: string;
  shouldRevalidate: boolean;
}

export interface RequestTimeoutEvent extends BaseEvent {
  type: "request.timeout";
  phase: import("./timeout.js").TimeoutPhase;
  pathname: string;
  routeKey?: string;
  actionId?: string;
  durationMs: number;
  customHandler: boolean;
}

export interface OriginCheckRejectedEvent extends BaseEvent {
  type: "request.origin-rejected";
  method: string;
  pathname: string;
  phase: import("../rsc/origin-guard.js").OriginCheckPhase;
  origin: string | null;
  host: string | null;
}

export type TelemetryEvent =
  | RequestStartEvent
  | RequestEndEvent
  | RequestErrorEvent
  | LoaderStartEvent
  | LoaderEndEvent
  | LoaderErrorEvent
  | HandlerErrorEvent
  | CacheDecisionEvent
  | RevalidationDecisionEvent
  | RequestTimeoutEvent
  | OriginCheckRejectedEvent;

// ---------------------------------------------------------------------------
// Sink interface
// ---------------------------------------------------------------------------

/**
 * Telemetry sink receives structured lifecycle events from the router.
 * Implement this interface to integrate with any observability backend.
 *
 * All methods are fire-and-forget — exceptions are caught and logged.
 */
export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

// ---------------------------------------------------------------------------
// No-op singleton (zero-cost disabled state)
// ---------------------------------------------------------------------------

const noopSink: TelemetrySink = {
  emit() {},
};

/**
 * Returns the configured sink, or the no-op singleton.
 * Call sites use this so they don't need null checks.
 */
export function resolveSink(sink: TelemetrySink | undefined): TelemetrySink {
  return sink ?? noopSink;
}

/**
 * Safe emit — catches any error thrown by the sink to prevent
 * telemetry failures from affecting request handling.
 */
export function safeEmit(sink: TelemetrySink, event: TelemetryEvent): void {
  try {
    sink.emit(event);
  } catch (e) {
    // Telemetry must never break request handling
    if (process.env.NODE_ENV !== "production") {
      console.error("[Router.telemetry] Sink error:", e);
    }
  }
}

// ---------------------------------------------------------------------------
// Request ID extraction (for span correlation)
// ---------------------------------------------------------------------------

// Per-request memoization so the same Request object always maps to the
// same ID. WeakMap allows GC when the Request is no longer referenced.
const requestIds = new WeakMap<Request, string>();
let telemetryRequestCounter = 0;

/**
 * Get or create a request ID for telemetry correlation.
 * Checks standard headers first (x-rsc-router-request-id, x-request-id,
 * cf-ray), then generates an internal ID when none is present.
 * Generated IDs use format "t-{base36}" to distinguish from header values.
 */
export function getRequestId(request: Request): string {
  const existing = requestIds.get(request);
  if (existing) return existing;

  const candidate =
    request.headers.get("x-rsc-router-request-id") ??
    request.headers.get("x-request-id") ??
    request.headers.get("cf-ray");

  let id: string;
  if (candidate) {
    const trimmed = candidate.trim();
    id =
      trimmed.length > 0
        ? trimmed
        : `t-${(++telemetryRequestCounter).toString(36)}`;
  } else {
    id = `t-${(++telemetryRequestCounter).toString(36)}`;
  }

  requestIds.set(request, id);
  return id;
}

// ---------------------------------------------------------------------------
// Console sink (built-in, replaces ad-hoc console.log debug traces)
// ---------------------------------------------------------------------------

/**
 * Built-in console sink that logs events in a structured format.
 * Designed as the default sink for development / debugging.
 */
export function createConsoleSink(): TelemetrySink {
  return {
    emit(event: TelemetryEvent): void {
      switch (event.type) {
        case "request.start":
          console.log(
            `[telemetry] ${event.type} ${event.method} ${event.pathname} (${event.transaction})`,
          );
          break;
        case "request.end":
          console.log(
            `[telemetry] ${event.type} ${event.method} ${event.pathname} ${event.durationMs.toFixed(1)}ms segments=${event.segmentCount} cache=${event.cacheHit}`,
          );
          break;
        case "request.error":
          console.log(
            `[telemetry] ${event.type} ${event.method} ${event.pathname} phase=${event.phase} ${event.durationMs.toFixed(1)}ms`,
            event.error.message,
          );
          break;
        case "loader.start":
          console.log(
            `[telemetry] ${event.type} ${event.loaderName} (${event.segmentId})`,
          );
          break;
        case "loader.end":
          console.log(
            `[telemetry] ${event.type} ${event.loaderName} ${event.durationMs.toFixed(1)}ms ok=${event.ok}`,
          );
          break;
        case "loader.error":
          console.log(
            `[telemetry] ${event.type} ${event.loaderName} boundary=${event.handledByBoundary}`,
            event.error.message,
          );
          break;
        case "handler.error":
          console.log(
            `[telemetry] ${event.type} segment=${event.segmentId ?? "unknown"} boundary=${event.handledByBoundary}${event.pathname ? ` ${event.pathname}` : ""}`,
            event.error.message,
          );
          break;
        case "cache.decision":
          console.log(
            `[telemetry] ${event.type} ${event.pathname} hit=${event.hit} swr=${event.shouldRevalidate}${event.source ? ` source=${event.source}` : ""}`,
          );
          break;
        case "revalidation.decision":
          console.log(
            `[telemetry] ${event.type} ${event.segmentId} revalidate=${event.shouldRevalidate}`,
          );
          break;
        case "request.timeout":
          console.log(
            `[telemetry] ${event.type} phase=${event.phase} ${event.pathname} ${event.durationMs.toFixed(1)}ms custom=${event.customHandler}`,
          );
          break;
        case "request.origin-rejected":
          console.log(
            `[telemetry] ${event.type} ${event.method} ${event.pathname} phase=${event.phase} origin=${event.origin ?? "none"} host=${event.host ?? "none"}`,
          );
          break;
      }
    },
  };
}
