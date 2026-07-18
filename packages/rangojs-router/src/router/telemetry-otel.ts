/**
 * OpenTelemetry adapters for the router.
 *
 * Two adapters, two surfaces — matching the split in instrument.ts:
 *
 *   - createOTelTracing(tracer): the OTel adapter for the `tracing` SLOT — the
 *     canonical phase-span layer. It bridges observePhase's callback boundary
 *     onto OTel's callback-bound `startActiveSpan`, so the router's phase spans
 *     (rango.request/middleware/action/loader/handler/render/ssr/response/
 *     background) nest by async context and the loader's own OTel spans
 *     (db/fetch) land under rango.loader. This is the OTel equivalent of
 *     createCloudflareTracing — pass it to `createRouter({ tracing })`.
 *
 *   - createOTelSink(tracer): the OTel adapter for the `telemetry` SLOT — a
 *     TelemetrySink for the EVENT-shaped facts (handler errors, cache decisions,
 *     revalidation decisions, timeouts, origin rejections). It emits one instant
 *     OTel span per fact. It deliberately does NOT emit request/loader phase
 *     spans: those are owned by the tracing slot (createOTelTracing) so the two
 *     layers don't produce duplicate rango.request / rango.loader spans.
 *
 * The core router stays OTel-agnostic — these adapters accept a standard OTel
 * Tracer (structurally typed, no import needed) and bridge the gap.
 *
 * Usage:
 *   import { trace } from "@opentelemetry/api";
 *   import { createRouter, createOTelTracing, createOTelSink } from "@rangojs/router";
 *
 *   const tracer = trace.getTracer("my-app");
 *   const router = createRouter({
 *     tracing: createOTelTracing(tracer),   // phase spans (callback-bound)
 *     telemetry: createOTelSink(tracer),     // discrete-fact instant spans
 *   });
 *
 * Faithful nesting requires an OTel async context manager
 * (AsyncLocalStorageContextManager) configured in your OTel setup — standard for
 * any startActiveSpan-based instrumentation.
 */

import type { TelemetrySink, TelemetryEvent } from "./telemetry.js";
import { runThenSettle } from "./tracing.js";
import type {
  RouterTracingConfig,
  SpanRunner,
  TracingToggleOptions,
} from "./tracing.js";

// ---------------------------------------------------------------------------
// Minimal OTel-compatible types (structurally typed, no import needed)
// ---------------------------------------------------------------------------

/**
 * Minimal Span interface compatible with @opentelemetry/api Span.
 * Only the methods used by the adapters are declared.
 */
export interface OTelSpan {
  setAttribute(key: string, value: string | number | boolean): OTelSpan | void;
  setStatus(status: { code: number; message?: string }): OTelSpan | void;
  recordException(exception: Error): void;
  end(): void;
}

/**
 * Minimal Tracer interface for the EVENT sink (createOTelSink): only `startSpan`
 * is used (one instant span per discrete fact). Kept narrow so a custom,
 * event-only tracer that does not implement `startActiveSpan` still satisfies it.
 * The real `@opentelemetry/api` Tracer has both methods, so it satisfies this and
 * `OTelActiveSpanTracer` below.
 */
export interface OTelTracer {
  startSpan(
    name: string,
    options?: {
      attributes?: Record<string, string | number | boolean>;
    },
  ): OTelSpan;
}

/**
 * Minimal Tracer interface for the PHASE-SPAN adapter (createOTelTracing): only
 * `startActiveSpan` is used (callback-bound, so the span is active for the work
 * and child spans nest). Declared separately from `OTelTracer` so each factory
 * requires exactly the method it calls.
 */
export interface OTelActiveSpanTracer {
  startActiveSpan<T>(name: string, fn: (span: OTelSpan) => T): T;
}

// OTel SpanStatusCode constants (mirrors @opentelemetry/api values)
const STATUS_ERROR = 2;

// ---------------------------------------------------------------------------
// Tracing adapter: phase spans via startActiveSpan (the `tracing` slot)
// ---------------------------------------------------------------------------

/**
 * Options for createOTelTracing. Alias of the shared {@link TracingToggleOptions}
 * (`enabled` master switch + per-phase `spans` toggles); the name is public API.
 */
export type OTelTracingOptions = TracingToggleOptions;

/**
 * Create the tracing config that maps the router's phases onto OTel spans via
 * `tracer.startActiveSpan`, which runs the work inside the span's active context
 * (so child spans nest) and returns the work's value unchanged. The span ends
 * when that value — or, for async work, the returned promise — settles, matching
 * observePhase's contract. When the work throws or rejects, the exception is
 * recorded and the span status is set to ERROR before it ends, so a failed phase
 * stays visible in the trace (the old createOTelSink error path is preserved here
 * now that phase spans live in this adapter). Pass the result to
 * `createRouter({ tracing })`.
 *
 * @see createCloudflareTracing (`@rangojs/router/cloudflare`) for the same slot
 *   using Cloudflare Workers native custom spans.
 */
export function createOTelTracing(
  tracer: OTelActiveSpanTracer,
  options: OTelTracingOptions = {},
): RouterTracingConfig {
  const runner: SpanRunner = <T>(name: string, fn: (span: OTelSpan) => T): T =>
    tracer.startActiveSpan(
      name,
      (span): T =>
        runThenSettle(
          () => fn(span),
          (error) => {
            // On failure record the exception + ERROR status before ending, so a
            // failed phase stays visible in the trace.
            if (error !== undefined) {
              if (error instanceof Error) {
                span.recordException(error);
                span.setStatus({ code: STATUS_ERROR, message: error.message });
              } else {
                span.setStatus({ code: STATUS_ERROR });
              }
            }
            span.end();
          },
        ),
    );

  return {
    runner,
    enabled: options.enabled ?? true,
    spans: options.spans,
  };
}

// ---------------------------------------------------------------------------
// Telemetry sink: discrete-fact instant spans (the `telemetry` slot)
// ---------------------------------------------------------------------------

/**
 * Create a TelemetrySink that maps the router's discrete-fact events to instant
 * OTel spans. One span per fact; no duration spans.
 *
 * Fact mapping:
 *   - handler.error              -> "rango.handler.error" (error)
 *   - cache.decision             -> "rango.cache.decision"
 *   - revalidation.decision      -> "rango.revalidation.decision"
 *   - request.timeout            -> "rango.request.timeout" (error)
 *   - request.origin-rejected    -> "rango.request.origin-rejected" (error)
 *
 * Request and loader PHASE spans are intentionally NOT emitted here — they are
 * owned by the tracing slot (createOTelTracing) so the two layers cannot produce
 * duplicate rango.request / rango.loader spans. request.start/end and
 * loader.start/end events are no-ops for this sink.
 *
 * Attributes use the `rango.*` namespace for router-specific data and
 * `http.method` / `http.route` for HTTP semantics.
 */
export function createOTelSink(tracer: OTelTracer): TelemetrySink {
  const instant = (
    name: string,
    attributes: Record<string, string | number | boolean>,
  ): OTelSpan => tracer.startSpan(name, { attributes });

  return {
    emit(event: TelemetryEvent): void {
      switch (event.type) {
        case "handler.error": {
          const attrs: Record<string, string | number | boolean> = {
            "rango.handled_by_boundary": event.handledByBoundary,
          };
          if (event.segmentId) attrs["rango.segment_id"] = event.segmentId;
          if (event.segmentType)
            attrs["rango.segment_type"] = event.segmentType;
          if (event.pathname) attrs["http.route"] = event.pathname;
          if (event.routeKey) attrs["rango.route_key"] = event.routeKey;
          if (event.params)
            attrs["rango.params"] = JSON.stringify(event.params);

          const span = instant("rango.handler.error", attrs);
          span.recordException(event.error);
          span.setStatus({ code: STATUS_ERROR, message: event.error.message });
          span.end();
          break;
        }

        case "cache.decision": {
          const attrs: Record<string, string | number | boolean> = {
            "http.route": event.pathname,
            "rango.route_key": event.routeKey,
            "rango.cache.hit": event.hit,
            "rango.cache.revalidation_claimed": event.revalidationClaimed,
          };
          if (event.source) attrs["rango.cache.source"] = event.source;
          if (event.freshness) attrs["rango.cache.freshness"] = event.freshness;
          instant("rango.cache.decision", attrs).end();
          break;
        }

        case "revalidation.decision": {
          instant("rango.revalidation.decision", {
            "rango.segment_id": event.segmentId,
            "http.route": event.pathname,
            "rango.route_key": event.routeKey,
            "rango.revalidate": event.shouldRevalidate,
          }).end();
          break;
        }

        case "request.timeout": {
          const attrs: Record<string, string | number | boolean> = {
            "rango.phase": event.phase,
            "http.route": event.pathname,
            "rango.duration_ms": event.durationMs,
            "rango.timeout.custom_handler": event.customHandler,
          };
          if (event.routeKey) attrs["rango.route_key"] = event.routeKey;
          if (event.actionId) attrs["rango.action_id"] = event.actionId;
          if (event.render) {
            attrs["rango.render.mode"] = event.render.mode;
            attrs["rango.render.phase"] = event.render.phase;
            attrs["rango.render.state"] = event.render.state;
            attrs["rango.render.completed"] = event.render.completed;
            attrs["rango.render.total"] = event.render.total;
            if (event.render.phaseDurationMs !== undefined) {
              attrs["rango.render.phase_duration_ms"] =
                event.render.phaseDurationMs;
            }
          }
          const span = instant("rango.request.timeout", attrs);
          span.setStatus({
            code: STATUS_ERROR,
            message: `timeout: ${event.phase}`,
          });
          span.end();
          break;
        }

        case "request.origin-rejected": {
          const attrs: Record<string, string | number | boolean> = {
            "http.method": event.method,
            "http.route": event.pathname,
            "rango.phase": event.phase,
          };
          if (event.origin) attrs["rango.origin"] = event.origin;
          if (event.host) attrs["http.host"] = event.host;
          const span = instant("rango.request.origin-rejected", attrs);
          span.setStatus({ code: STATUS_ERROR, message: "origin rejected" });
          span.end();
          break;
        }

        // request.start/end/error and loader.start/end/error are phase events;
        // their spans are owned by the tracing slot (createOTelTracing), so this
        // sink ignores them to avoid duplicate rango.request / rango.loader spans.
      }
    },
  };
}
