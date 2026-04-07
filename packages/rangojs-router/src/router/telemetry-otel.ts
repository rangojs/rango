/**
 * OpenTelemetry Adapter for Router Telemetry
 *
 * Maps internal TelemetrySink events to OTel spans. The core router
 * remains OTel-agnostic — this adapter bridges the gap by accepting
 * a standard OTel Tracer and producing spans/events from it.
 *
 * Usage:
 *   import { trace } from "@opentelemetry/api";
 *   import { createOTelSink } from "@rangojs/router";
 *
 *   const router = createRouter({
 *     telemetry: createOTelSink(trace.getTracer("my-app")),
 *   });
 */

import type { TelemetrySink, TelemetryEvent } from "./telemetry.js";

// ---------------------------------------------------------------------------
// Minimal OTel-compatible types (structurally typed, no import needed)
// ---------------------------------------------------------------------------

/**
 * Minimal Span interface compatible with @opentelemetry/api Span.
 * Only the methods used by the adapter are declared.
 */
export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): OTelSpan | void;
  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): OTelSpan | void;
  setStatus(status: { code: number; message?: string }): OTelSpan | void;
  recordException(exception: Error): void;
  end(): void;
}

/**
 * Minimal Tracer interface compatible with @opentelemetry/api Tracer.
 */
export interface OTelTracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, string | number | boolean>;
    },
  ): OTelSpan;
}

// OTel SpanStatusCode constants (mirrors @opentelemetry/api values)
const STATUS_OK = 1;
const STATUS_ERROR = 2;

// ---------------------------------------------------------------------------
// Span correlation helpers
// ---------------------------------------------------------------------------

// Build correlation keys using requestId.
// getRequestId() always returns a value (generated internally when no
// header is present), so concurrent requests to the same path each get
// their own correlation key and never mis-correlate.

function requestKey(event: {
  requestId?: string;
  pathname: string;
  transaction: string;
}): string {
  return `${event.requestId ?? ""}:${event.pathname}:${event.transaction}`;
}

function loaderKey(event: {
  requestId?: string;
  segmentId: string;
  loaderName: string;
  pathname: string;
}): string {
  return `${event.requestId ?? ""}:${event.segmentId}:${event.loaderName}:${event.pathname}`;
}

function pushSpan(
  map: Map<string, OTelSpan[]>,
  key: string,
  span: OTelSpan,
): void {
  let stack = map.get(key);
  if (!stack) {
    stack = [];
    map.set(key, stack);
  }
  stack.push(span);
}

function popSpan(
  map: Map<string, OTelSpan[]>,
  key: string,
): OTelSpan | undefined {
  const stack = map.get(key);
  if (!stack || stack.length === 0) return undefined;
  const span = stack.pop()!;
  if (stack.length === 0) map.delete(key);
  return span;
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * Create a TelemetrySink that maps router lifecycle events to OTel spans.
 *
 * Span mapping:
 *   - request.start / request.end / request.error  → "rango.request" span
 *   - loader.start / loader.end / loader.error      → "rango.loader" span
 *   - handler.error                                  → "rango.handler.error" instant span
 *   - cache.decision                                 → "rango.cache.decision" instant span
 *   - revalidation.decision                          → "rango.revalidation.decision" instant span
 *
 * Attributes use the `rango.*` namespace for router-specific data and
 * `http.method` / `http.route` for HTTP semantics.
 */
export function createOTelSink(tracer: OTelTracer): TelemetrySink {
  const requestSpans = new Map<string, OTelSpan[]>();
  const loaderSpans = new Map<string, OTelSpan[]>();

  return {
    emit(event: TelemetryEvent): void {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Request lifecycle
        // -----------------------------------------------------------------

        case "request.start": {
          const span = tracer.startSpan("rango.request", {
            attributes: {
              "http.method": event.method,
              "http.route": event.pathname,
              "rango.transaction": event.transaction,
              "rango.is_partial": event.isPartial,
            },
          });
          pushSpan(requestSpans, requestKey(event), span);
          break;
        }

        case "request.end": {
          const span = popSpan(requestSpans, requestKey(event));
          if (span) {
            span.setAttribute("rango.duration_ms", event.durationMs);
            span.setAttribute("rango.segment_count", event.segmentCount);
            span.setAttribute("rango.cache.hit", event.cacheHit);
            span.setStatus({ code: STATUS_OK });
            span.end();
          }
          break;
        }

        case "request.error": {
          const span = popSpan(requestSpans, requestKey(event));
          if (span) {
            span.setAttribute("rango.duration_ms", event.durationMs);
            span.setAttribute("rango.phase", event.phase);
            span.recordException(event.error);
            span.setStatus({
              code: STATUS_ERROR,
              message: event.error.message,
            });
            span.end();
          }
          break;
        }

        // -----------------------------------------------------------------
        // Loader lifecycle
        // -----------------------------------------------------------------

        case "loader.start": {
          const span = tracer.startSpan("rango.loader", {
            attributes: {
              "rango.segment_id": event.segmentId,
              "rango.loader_name": event.loaderName,
              "http.route": event.pathname,
            },
          });
          pushSpan(loaderSpans, loaderKey(event), span);
          break;
        }

        case "loader.end": {
          const key = loaderKey(event);
          const span = popSpan(loaderSpans, key);
          if (span) {
            span.setAttribute("rango.duration_ms", event.durationMs);
            span.setAttribute("rango.loader.ok", event.ok);
            span.setStatus({ code: event.ok ? STATUS_OK : STATUS_ERROR });
            span.end();
          }
          break;
        }

        case "loader.error": {
          const key = loaderKey(event);
          const span = popSpan(loaderSpans, key);
          if (span) {
            span.setAttribute(
              "rango.handled_by_boundary",
              event.handledByBoundary,
            );
            span.recordException(event.error);
            span.setStatus({
              code: STATUS_ERROR,
              message: event.error.message,
            });
            span.end();
          } else {
            // No matching start — create a standalone error span
            const errorSpan = tracer.startSpan("rango.loader", {
              attributes: {
                "rango.segment_id": event.segmentId,
                "rango.loader_name": event.loaderName,
                "http.route": event.pathname,
                "rango.handled_by_boundary": event.handledByBoundary,
              },
            });
            errorSpan.recordException(event.error);
            errorSpan.setStatus({
              code: STATUS_ERROR,
              message: event.error.message,
            });
            errorSpan.end();
          }
          break;
        }

        // -----------------------------------------------------------------
        // Handler errors (instant span)
        // -----------------------------------------------------------------

        case "handler.error": {
          const attrs: Record<string, string | number | boolean> = {
            "rango.handled_by_boundary": event.handledByBoundary,
          };
          if (event.segmentId) attrs["rango.segment_id"] = event.segmentId;
          if (event.segmentType)
            attrs["rango.segment_type"] = event.segmentType;
          if (event.pathname) attrs["http.route"] = event.pathname;
          if (event.routeKey) attrs["rango.route_key"] = event.routeKey;
          if (event.params) {
            attrs["rango.params"] = JSON.stringify(event.params);
          }

          const span = tracer.startSpan("rango.handler.error", {
            attributes: attrs,
          });
          span.recordException(event.error);
          span.setStatus({ code: STATUS_ERROR, message: event.error.message });
          span.end();
          break;
        }

        // -----------------------------------------------------------------
        // Cache decision (instant span)
        // -----------------------------------------------------------------

        case "cache.decision": {
          const attrs: Record<string, string | number | boolean> = {
            "http.route": event.pathname,
            "rango.route_key": event.routeKey,
            "rango.cache.hit": event.hit,
            "rango.cache.should_revalidate": event.shouldRevalidate,
          };
          if (event.source) attrs["rango.cache.source"] = event.source;

          const span = tracer.startSpan("rango.cache.decision", {
            attributes: attrs,
          });
          span.end();
          break;
        }

        // -----------------------------------------------------------------
        // Revalidation decision (instant span)
        // -----------------------------------------------------------------

        case "revalidation.decision": {
          const span = tracer.startSpan("rango.revalidation.decision", {
            attributes: {
              "rango.segment_id": event.segmentId,
              "http.route": event.pathname,
              "rango.route_key": event.routeKey,
              "rango.revalidate": event.shouldRevalidate,
            },
          });
          span.end();
          break;
        }
      }
    },
  };
}
